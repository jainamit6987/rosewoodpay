const express = require('express');
const authenticate = require('../middleware/authenticate');
const supabaseAdmin = require('../config/supabaseAdmin');

const router = express.Router();

// Postgres error codes we translate into specific HTTP responses instead of
// a generic 500, so the mobile client can show the resident something
// useful instead of "something went wrong".
const PG_UNIQUE_VIOLATION = '23505';
const PG_INSUFFICIENT_PRIVILEGE = '42501';

// Kept in sync with the chk_transaction_type CHECK constraint added in
// 20260725030000_add_transaction_type_and_multiple_rule.sql. Only
// MAINTENANCE_TYPE is produced by any code path today - the others are
// reserved for the not-yet-built admin society-expense feature (utility
// bills, labour salaries).
const TRANSACTION_TYPES = ['Maintenance', 'UtilityBill', 'Salary', 'Other'];
const MAINTENANCE_TYPE = 'Maintenance';

// Whole-rupee-and-paise-safe "is amount a whole multiple of base" check.
// Plain `amount % base !== 0` is unreliable on NUMERIC values that arrive
// as JS floats (e.g. 6600 % 2200 can come out as a tiny non-zero epsilon),
// so this compares integer paise instead.
function isWholeMultiple(amount, base) {
  const amountPaise = Math.round(amount * 100);
  const basePaise = Math.round(base * 100);
  if (basePaise <= 0) return false;
  return amountPaise % basePaise === 0;
}

function addMonths(dateString, count) {
  const date = new Date(dateString);
  date.setUTCMonth(date.getUTCMonth() + count);
  return date;
}

function startOfCurrentMonthUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

router.post('/', authenticate, async (req, res) => {
  const {
    house_id,
    amount,
    utr_number,
    raw_shared_payload,
    proof_file_path,
    txn_date,
    transaction_type,
  } = req.body || {};

  if (!house_id || amount === undefined || amount === null) {
    return res.status(400).json({ error: 'house_id and amount are required.' });
  }

  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number.' });
  }

  if (!utr_number && !raw_shared_payload && !proof_file_path) {
    return res
      .status(400)
      .json({ error: 'At least one of utr_number, raw_shared_payload, or proof_file_path is required.' });
  }

  // Defaults to Maintenance - every existing client/seed/test row that
  // predates this field means exactly that, so the default keeps them
  // meaningful without a backfill.
  const resolvedTransactionType = transaction_type || MAINTENANCE_TYPE;
  if (!TRANSACTION_TYPES.includes(resolvedTransactionType)) {
    return res.status(400).json({
      error: `transaction_type must be one of: ${TRANSACTION_TYPES.join(', ')}.`,
    });
  }

  const supabase = req.supabase;

  // society_id is derived from the house, never trusted from the request
  // body, so a caller cannot submit into a society they are not a member of.
  const { data: house, error: houseError } = await supabase
    .from('houses')
    .select('id, society_id, default_monthly_amount')
    .eq('id', house_id)
    .maybeSingle();

  if (houseError) {
    return res.status(500).json({ error: houseError.message });
  }
  if (!house) {
    return res.status(404).json({ error: 'House not found or not accessible.' });
  }

  // Explicit assignment check, independent of whether any billing_periods
  // exist yet for this house - a brand-new or fully-caught-up house may
  // have zero periods, and we still need to distinguish "legitimately
  // nothing to see yet" from "not assigned to this house at all" before
  // deciding whether to auto-generate anything below. RLS scopes this to
  // the caller's own assignment (for residents) or any assignment in their
  // society (for admins/committee), so a non-empty result here always
  // means the caller is legitimately allowed to deal with this house.
  const { data: houseAssignments, error: assignmentError } = await supabase
    .from('resident_house_assignments')
    .select('id')
    .eq('house_id', house_id)
    .eq('status', 'Active')
    .limit(1);

  if (assignmentError) {
    return res.status(500).json({ error: assignmentError.message });
  }
  if (!houseAssignments || houseAssignments.length === 0) {
    return res.status(403).json({
      error: 'No active house assignment visible for this house. Confirm you have an approved, active assignment to it.',
    });
  }

  // Base-amount-multiple rule: a Maintenance payment must cover one or more
  // *whole* months, never a fraction of one - e.g. 1x or 2x the base rate is
  // fine, 1.5x is rejected outright, before any period lookup/generation
  // happens. Non-Maintenance types (utility bills, salaries, once that
  // feature exists) have no monthly "base amount" to be a multiple of, so
  // they are exempt entirely.
  if (resolvedTransactionType === MAINTENANCE_TYPE) {
    if (!house.default_monthly_amount) {
      return res.status(409).json({
        error: 'This house has no default monthly amount configured, so maintenance payments cannot be validated. Ask an admin to configure a rate first.',
      });
    }
    if (!isWholeMultiple(amount, Number(house.default_monthly_amount))) {
      return res.status(400).json({
        error: `Maintenance payments must be a whole-month multiple of the base amount (${house.default_monthly_amount}). Partial-month payments are not allowed - pay for one or more full months (e.g. ${house.default_monthly_amount}, ${2 * house.default_monthly_amount}, ${3 * house.default_monthly_amount}).`,
      });
    }
  }

  const { data: housePeriods, error: periodsError } = await supabase
    .from('billing_periods')
    .select('id, period_month, status, amount_due')
    .eq('house_id', house_id)
    .order('period_month', { ascending: true });

  if (periodsError) {
    return res.status(500).json({ error: periodsError.message });
  }

  // FIFO allocation across as many sequential periods as this payment
  // covers: walk the oldest still-Open periods first, consuming each one's
  // own amount_due from the submitted total (not a flat rate, since a rate
  // change could mean periods differ), and auto-generate further periods -
  // using the house's trusted default_monthly_amount, never the unverified
  // submitted amount - once the existing ones run out. This one mechanism
  // covers a single month's payment, clearing several months of arrears in
  // one lump payment, and paying ahead of schedule.
  const openPeriods = housePeriods.filter((period) => period.status === 'Open');
  let cursorMonth = housePeriods.length > 0 ? housePeriods[housePeriods.length - 1].period_month : null;

  const allocations = [];
  let remaining = amount;
  let index = 0;

  while (remaining > 0) {
    let period = openPeriods[index];

    if (!period) {
      if (!house.default_monthly_amount) {
        break; // out of periods and no rate configured to generate more - handled below
      }

      const nextMonth = cursorMonth ? addMonths(cursorMonth, 1) : startOfCurrentMonthUtc();
      const nextMonthDate = toDateOnly(nextMonth);

      const { data: generated, error: generateError } = await supabaseAdmin
        .from('billing_periods')
        .insert({
          society_id: house.society_id,
          house_id,
          period_month: nextMonthDate,
          base_amount: house.default_monthly_amount,
          amount_due: house.default_monthly_amount,
          status: 'Open',
        })
        .select('id, period_month, status, amount_due')
        .single();

      if (generateError) {
        if (generateError.code === PG_UNIQUE_VIOLATION) {
          // A concurrent request already generated this exact month for
          // this house - use it instead of failing.
          const { data: existing, error: existingError } = await supabaseAdmin
            .from('billing_periods')
            .select('id, period_month, status, amount_due')
            .eq('house_id', house_id)
            .eq('period_month', nextMonthDate)
            .single();
          if (existingError) {
            return res.status(500).json({ error: existingError.message });
          }
          period = existing;
        } else {
          return res.status(500).json({ error: generateError.message });
        }
      } else {
        period = generated;
      }

      openPeriods.push(period);
      cursorMonth = period.period_month;
    }

    const allocate = Math.min(remaining, Number(period.amount_due));
    allocations.push({ billing_period_id: period.id, amount_allocated: allocate });
    remaining -= allocate;
    index += 1;
  }

  if (remaining > 0) {
    return res.status(409).json({
      error:
        'This amount covers more than the periods available, and no default monthly amount is configured on this house to generate further ones. Ask an admin to configure a rate.',
    });
  }

  const { data: transaction, error: insertError } = await supabase
    .from('transactions')
    .insert({
      society_id: house.society_id,
      house_id,
      submitted_by: req.user.id,
      amount,
      utr_number: utr_number || null,
      raw_shared_payload: raw_shared_payload || null,
      proof_file_path: proof_file_path || null,
      txn_date: txn_date || null,
      transaction_type: resolvedTransactionType,
    })
    .select()
    .single();

  if (insertError) {
    if (insertError.code === PG_UNIQUE_VIOLATION) {
      return res.status(409).json({ error: 'This UTR has already been submitted for this society.' });
    }
    if (insertError.code === PG_INSUFFICIENT_PRIVILEGE || insertError.message?.includes('row-level security')) {
      return res.status(403).json({
        error: 'Not allowed to submit for this house. It must be an approved, active house assignment.',
      });
    }
    return res.status(500).json({ error: insertError.message });
  }

  // Not wrapped in a single atomic DB transaction - PostgREST does not
  // expose multi-statement transactions over REST. If this second insert
  // fails partway through, the transaction row above can end up with
  // incomplete allocations. Accepted MVP gap; moving this whole flow into
  // one Postgres RPC function is the correct fix once this shape is
  // validated end-to-end.
  const { data: insertedAllocations, error: allocationError } = await supabase
    .from('transaction_allocations')
    .insert(
      allocations.map((allocation) => ({
        transaction_id: transaction.id,
        billing_period_id: allocation.billing_period_id,
        amount_allocated: allocation.amount_allocated,
      }))
    )
    .select();

  if (allocationError) {
    return res.status(500).json({
      error: `Transaction recorded but allocation failed: ${allocationError.message}`,
      transaction,
    });
  }

  res.status(201).json({ ...transaction, allocations: insertedAllocations });
});

module.exports = router;
