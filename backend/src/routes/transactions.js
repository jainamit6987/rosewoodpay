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
// 20260725030000_add_transaction_type_and_multiple_rule.sql. MAINTENANCE_TYPE
// is a resident paying the society, allocated against their house's billing
// periods below; the other three are the society paying someone else
// (a vendor, an employee) and take the entirely separate, house-less path
// near the top of this handler - see
// 20260726010000_society_expenses_house_optional.sql.
const TRANSACTION_TYPES = ['Maintenance', 'UtilityBill', 'Salary', 'Other'];
const MAINTENANCE_TYPE = 'Maintenance';

// Kept in sync with the chk_processing_status CHECK constraint in the
// initial schema - used only to validate the optional ?status= filter on
// GET /report below, not referenced anywhere else in this file.
const PROCESSING_STATUSES = [
  'Submitted',
  'Queued',
  'Processing',
  'Extracted',
  'Pending_Verification',
  'Manual_Review',
  'Verified',
  'Rejected',
  'Failed',
];

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
    society_id,
    amount,
    utr_number,
    raw_shared_payload,
    proof_file_path,
    txn_date,
    transaction_type,
    payee_name,
  } = req.body || {};

  if (amount === undefined || amount === null) {
    return res.status(400).json({ error: 'amount is required.' });
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

  // UtilityBill/Salary/Other are society-level expenses - the society
  // paying a vendor or an employee, never something a specific house owes
  // - so they take an entirely separate path from here on: no house, no
  // billing periods, no allocations, Admin-only. See
  // 20260726010000_society_expenses_house_optional.sql for the matching
  // "house_id required for Maintenance, forbidden otherwise" DB constraint
  // - this app-layer check exists only to give a clean 4xx message; RLS
  // and that CHECK constraint are the real enforcement underneath it.
  //
  // Unlike Maintenance, these skip Submitted -> Verify/Reject entirely and
  // are recorded as Verified immediately. Verify/Reject exists for
  // Maintenance to gate whether a *billing period* gets credited as paid -
  // rejecting never recovers the resident's money either, but it does
  // leave the underlying debt uncleared until a correct payment is found.
  // An expense has no analogous debt to leave uncleared: the money is
  // already gone by the time an Admin types it in, and (discussed and
  // confirmed with the user) a Submitted-then-self-reviewed checkpoint
  // here would just be theater - the Admin recording it is already the
  // attestation that it's real.
  if (resolvedTransactionType !== MAINTENANCE_TYPE) {
    if (house_id) {
      return res.status(400).json({
        error: `house_id must not be provided for ${resolvedTransactionType} transactions - they are society-level expenses, not owed by any house.`,
      });
    }
    if (!society_id) {
      return res.status(400).json({ error: 'society_id is required for non-Maintenance transactions.' });
    }
    if (!payee_name || typeof payee_name !== 'string' || !payee_name.trim()) {
      return res.status(400).json({
        error: 'payee_name is required for non-Maintenance transactions (who or what was paid).',
      });
    }

    // status='Active' is required explicitly here, not just implied by
    // RLS - this query reads the caller's OWN row, which the deliberately
    // ungated "Users can view their own society_member record" policy
    // always lets them see regardless of status, so a Suspended admin
    // could otherwise still pass this check (see
    // 20260727000000_enforce_suspended_status_in_rls.sql's closing note).
    const { data: adminMembership, error: adminError } = await supabase
      .from('society_members')
      .select('id')
      .eq('society_id', society_id)
      .eq('auth_user_id', req.user.id)
      .eq('is_admin', true)
      .eq('status', 'Active')
      .maybeSingle();

    if (adminError) {
      return res.status(500).json({ error: adminError.message });
    }
    if (!adminMembership) {
      return res.status(403).json({ error: 'Only an Admin can record a society expense (UtilityBill/Salary/Other).' });
    }

    const nowIso = new Date().toISOString();
    const { data: transaction, error: insertError } = await supabase
      .from('transactions')
      .insert({
        society_id,
        house_id: null,
        submitted_by: req.user.id,
        amount,
        utr_number: utr_number || null,
        raw_shared_payload: raw_shared_payload || null,
        proof_file_path: proof_file_path || null,
        txn_date: txn_date || null,
        transaction_type: resolvedTransactionType,
        payee_name: payee_name.trim(),
        processing_status: 'Verified',
        payment_status: 'Success',
        verified_by: req.user.id,
        verified_at: nowIso,
      })
      .select()
      .single();

    if (insertError) {
      if (insertError.code === PG_UNIQUE_VIOLATION) {
        return res.status(409).json({ error: 'This UTR has already been submitted for this society.' });
      }
      if (insertError.code === PG_INSUFFICIENT_PRIVILEGE || insertError.message?.includes('row-level security')) {
        return res.status(403).json({ error: 'Not allowed to record this expense.' });
      }
      return res.status(500).json({ error: insertError.message });
    }

    const { error: auditError } = await supabase.from('audit_events').insert({
      society_id,
      actor_user_id: req.user.id,
      entity_type: 'transaction',
      entity_id: transaction.id,
      action: 'Verified',
      metadata: {
        amount: transaction.amount,
        utr_number: transaction.utr_number,
        payee_name: transaction.payee_name,
        transaction_type: transaction.transaction_type,
        auto_verified: true,
      },
    });

    if (auditError) {
      return res.status(500).json({
        error: `Expense recorded but the audit log entry failed: ${auditError.message}`,
        transaction,
      });
    }

    return res.status(201).json({ ...transaction, allocations: [] });
  }

  if (!house_id) {
    return res.status(400).json({ error: 'house_id is required for Maintenance payments.' });
  }

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

// Admin/Committee dashboard feed: every Submitted transaction across every
// society the caller administers or sits on the committee of, oldest-first
// (review the longest-waiting submissions first). This is what actually
// makes /:id/verify and /:id/reject usable in practice - without it, an
// admin would have no way to discover which transactions need action short
// of already knowing a specific house's id and calling
// GET /houses/:houseId/transactions one house at a time. Committee members
// can see this list (same visibility they already have on individual
// transactions) even though only an Admin can act on any given item.
router.get('/pending', authenticate, async (req, res) => {
  const supabase = req.supabase;

  // Same reasoning as the expense-creation admin check above: this reads
  // the caller's own row (always visible regardless of status via the
  // ungated "own record" policy), so status='Active' must be checked here
  // explicitly rather than relying on RLS to have already filtered it out.
  const { data: memberships, error: membershipError } = await supabase
    .from('society_members')
    .select('society_id')
    .eq('auth_user_id', req.user.id)
    .eq('status', 'Active')
    .or('is_admin.eq.true,is_committee_member.eq.true');

  if (membershipError) {
    return res.status(500).json({ error: membershipError.message });
  }

  const societyIds = [...new Set((memberships || []).map((m) => m.society_id))];
  if (societyIds.length === 0) {
    return res.status(403).json({
      error: 'Only an Admin or Committee member can view pending transactions.',
    });
  }

  const { data: pending, error: pendingError } = await supabase
    .from('transactions')
    .select(
      'id, society_id, house_id, submitted_by, amount, transaction_type, utr_number, payee_name, txn_date, processing_status, created_at, houses(house_number), transaction_allocations(billing_period_id, amount_allocated)'
    )
    .in('society_id', societyIds)
    .eq('processing_status', 'Submitted')
    .order('created_at', { ascending: true });

  if (pendingError) {
    return res.status(500).json({ error: pendingError.message });
  }

  res.json(pending);
});

// Admin/Committee full transaction report - every transaction across every
// society the caller administers or sits on the committee of, regardless
// of status, not just the Submitted-only review queue above. The "view
// transactions -- report" gap from the workflow doc: before this,
// GET /pending only ever surfaced Submitted items (a to-do list, not a
// report), and GET /houses/:houseId/transactions covered every status but
// only one house at a time - there was no single call that gave a
// full-society, all-status view. Newest-first, matching every other
// transaction-listing endpoint in this codebase.
//
// All filters are optional and combine with AND, each independently
// defaulting to "all": ?status= (one exact processing_status), ?house_id=
// (one house - if it belongs to a different society than the caller
// administers, the combined query simply returns nothing, never another
// society's data), ?transaction_type= (one exact type), ?from=/?to= (an
// inclusive created_at range), and ?billing_period_id= (one billing
// period, across every house that isn't already narrowed by ?house_id=).
// house_id and billing_period_id compose exactly as you'd expect: neither
// given is the whole society; house_id alone is "every transaction for
// this house, any period"; billing_period_id alone is "every house's
// transaction(s) against this one period"; both together is the
// intersection - deliberately one endpoint instead of three, since S.No 22
// ("view transactions -- report") and S.No 24 ("view transaction for a
// billing period") from the workflow doc turned out to be the exact same
// underlying report with one more optional dimension, not two different
// features.
//
// billing_period_id has no direct column to filter on - transactions never
// had one after 20260725020000_add_transaction_allocations_and_default_rate
// dropped it in favor of the transaction_allocations many-to-many join
// table (a single payment can cover several months, and a single month can
// in principle be topped up by more than one payment) - so this is the one
// filter here that has to reach into an embedded resource. PostgREST/
// supabase-js only turns an embed's `.eq()` into a real filter on the
// parent rows (not just on which embedded rows show up per parent) when
// the embed is forced to `!inner`; every other query here keeps the plain
// left-join embed, since house-less society expenses have zero
// transaction_allocations rows and must still appear when no billing_period_id
// filter is requested.
//
// Filters on created_at (always set, DEFAULT NOW()) rather than the
// resident-supplied, optional txn_date - a report filtered by a field that
// can silently be NULL would just as silently drop real rows.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/report', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { status, house_id, billing_period_id, transaction_type, from, to } = req.query;

  if (status !== undefined && !PROCESSING_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${PROCESSING_STATUSES.join(', ')}.` });
  }
  if (billing_period_id !== undefined && !UUID_PATTERN.test(billing_period_id)) {
    return res.status(400).json({ error: 'billing_period_id must be a valid UUID.' });
  }
  if (transaction_type !== undefined && !TRANSACTION_TYPES.includes(transaction_type)) {
    return res.status(400).json({ error: `transaction_type must be one of: ${TRANSACTION_TYPES.join(', ')}.` });
  }
  let fromIso;
  if (from !== undefined) {
    const parsed = new Date(from);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ error: 'from must be a valid date, e.g. 2026-07-01.' });
    }
    fromIso = parsed.toISOString();
  }
  let toIso;
  if (to !== undefined) {
    const parsed = new Date(to);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ error: 'to must be a valid date, e.g. 2026-07-31.' });
    }
    toIso = parsed.toISOString();
  }

  // Same reasoning as GET /pending above: reads the caller's own row,
  // always visible regardless of status, so status='Active' must be
  // checked here explicitly rather than relying on RLS alone.
  const { data: memberships, error: membershipError } = await supabase
    .from('society_members')
    .select('society_id')
    .eq('auth_user_id', req.user.id)
    .eq('status', 'Active')
    .or('is_admin.eq.true,is_committee_member.eq.true');

  if (membershipError) {
    return res.status(500).json({ error: membershipError.message });
  }

  const societyIds = [...new Set((memberships || []).map((m) => m.society_id))];
  if (societyIds.length === 0) {
    return res.status(403).json({ error: 'Only an Admin or Committee member can view the transaction report.' });
  }

  // Only switches to an inner join when actually filtering by
  // billing_period_id - see the comment above for why an unconditional
  // !inner would silently hide every house-less society expense.
  const allocationsEmbed = billing_period_id !== undefined ? 'transaction_allocations!inner' : 'transaction_allocations';

  let query = supabase
    .from('transactions')
    .select(
      `id, society_id, house_id, submitted_by, amount, transaction_type, utr_number, payee_name, txn_date, payment_status, processing_status, verified_by, verified_at, created_at, houses(house_number), ${allocationsEmbed}(billing_period_id, amount_allocated)`
    )
    .in('society_id', societyIds)
    .order('created_at', { ascending: false });

  if (status !== undefined) query = query.eq('processing_status', status);
  if (house_id !== undefined) query = query.eq('house_id', house_id);
  if (billing_period_id !== undefined) query = query.eq('transaction_allocations.billing_period_id', billing_period_id);
  if (transaction_type !== undefined) query = query.eq('transaction_type', transaction_type);
  if (fromIso !== undefined) query = query.gte('created_at', fromIso);
  if (toIso !== undefined) query = query.lte('created_at', toIso);

  const { data: transactions, error: transactionsError } = await query;

  if (transactionsError) {
    return res.status(500).json({ error: transactionsError.message });
  }

  res.json(transactions);
});

// Every transaction across every house the caller personally has an Active
// assignment to - the aggregated "all my transactions" view the workflow
// doc flagged as missing (GET /houses/:houseId/transactions only ever
// covers one house at a time; a resident with more than one house had no
// single call that combined them). Newest first, across every society the
// caller belongs to.
//
// Deliberately keyed off "does this member have an Active house
// assignment", the same principle GET /me's personal-dues section uses,
// never off is_admin/is_committee_member - an Admin who is also a resident
// (e.g. admin@society.app's own D-404) gets exactly their own personal
// transactions here, not their society's full admin transactions report
// (that is GET /transactions/pending plus GET /houses/:houseId/transactions,
// deliberately separate).
router.get('/mine', authenticate, async (req, res) => {
  const supabase = req.supabase;

  const { data: memberships, error: membershipError } = await supabase
    .from('society_members')
    .select('id')
    .eq('auth_user_id', req.user.id);

  if (membershipError) {
    return res.status(500).json({ error: membershipError.message });
  }

  const membershipIds = (memberships || []).map((m) => m.id);
  if (membershipIds.length === 0) {
    return res.json([]);
  }

  const { data: assignments, error: assignmentError } = await supabase
    .from('resident_house_assignments')
    .select('house_id')
    .in('society_member_id', membershipIds)
    .eq('status', 'Active');

  if (assignmentError) {
    return res.status(500).json({ error: assignmentError.message });
  }

  const houseIds = [...new Set((assignments || []).map((a) => a.house_id))];
  if (houseIds.length === 0) {
    return res.json([]);
  }

  const { data: transactions, error: transactionsError } = await supabase
    .from('transactions')
    .select(
      'id, house_id, submitted_by, amount, transaction_type, utr_number, txn_date, payment_status, processing_status, verified_at, created_at, houses(house_number), transaction_allocations(billing_period_id, amount_allocated)'
    )
    .in('house_id', houseIds)
    .order('created_at', { ascending: false });

  if (transactionsError) {
    return res.status(500).json({ error: transactionsError.message });
  }

  res.json(transactions);
});

// Confirms the caller is an Admin of the transaction's own society - not
// just "an Admin somewhere". Returns the transaction row (via the caller's
// RLS-scoped client, so a non-member gets the same "not found" outcome as a
// real 404) or null, plus a boolean for whether they're allowed to act on
// it. Shared by both verify and reject below since the checks are identical.
async function loadTransactionAndCheckAdmin(supabase, userId, transactionId) {
  const { data: transaction, error: transactionError } = await supabase
    .from('transactions')
    .select('id, society_id, house_id, amount, utr_number, transaction_type, payee_name, processing_status')
    .eq('id', transactionId)
    .maybeSingle();

  if (transactionError) {
    throw new Error(transactionError.message);
  }
  if (!transaction) {
    return { transaction: null, isAdmin: false };
  }

  // Same reasoning as the other two raw is_admin checks in this file:
  // this reads the caller's own row, always visible regardless of status,
  // so status='Active' must be checked here explicitly too.
  const { data: adminMembership, error: adminError } = await supabase
    .from('society_members')
    .select('id')
    .eq('society_id', transaction.society_id)
    .eq('auth_user_id', userId)
    .eq('is_admin', true)
    .eq('status', 'Active')
    .maybeSingle();

  if (adminError) {
    throw new Error(adminError.message);
  }

  return { transaction, isAdmin: !!adminMembership };
}

// After marking a transaction Verified, checks every billing period it has
// an allocation against and closes any period whose *total* verified
// allocations (across every transaction that has ever paid into it, not
// just this one - a period can in principle be topped up by more than one
// payment) now cover its amount_due. Left as "Open" if still short, so a
// partial/underpayment does not incorrectly close a period.
async function closeFullyPaidPeriods(supabase, billingPeriodIds) {
  const closedPeriods = [];

  for (const billingPeriodId of billingPeriodIds) {
    const { data: period, error: periodError } = await supabase
      .from('billing_periods')
      .select('id, status, amount_due')
      .eq('id', billingPeriodId)
      .maybeSingle();

    if (periodError) throw new Error(periodError.message);
    if (!period || period.status !== 'Open') continue; // already Closed/Waived - nothing to do

    const { data: allocations, error: allocationsError } = await supabase
      .from('transaction_allocations')
      .select('amount_allocated, transaction_id')
      .eq('billing_period_id', billingPeriodId);

    if (allocationsError) throw new Error(allocationsError.message);

    const transactionIds = [...new Set((allocations || []).map((a) => a.transaction_id))];
    if (transactionIds.length === 0) continue;

    const { data: verifiedTransactions, error: verifiedError } = await supabase
      .from('transactions')
      .select('id')
      .in('id', transactionIds)
      .eq('processing_status', 'Verified');

    if (verifiedError) throw new Error(verifiedError.message);

    const verifiedIds = new Set((verifiedTransactions || []).map((t) => t.id));
    const verifiedTotal = (allocations || [])
      .filter((a) => verifiedIds.has(a.transaction_id))
      .reduce((sum, a) => sum + Number(a.amount_allocated), 0);

    if (verifiedTotal >= Number(period.amount_due)) {
      const { error: closeError } = await supabase
        .from('billing_periods')
        .update({ status: 'Closed' })
        .eq('id', billingPeriodId);

      if (closeError) throw new Error(closeError.message);
      closedPeriods.push(billingPeriodId);
    }
  }

  return closedPeriods;
}

// Admin-only: confirms a submitted payment is real (matches a genuine bank
// settlement, as far as the admin can tell from the UTR/receipt) and closes
// any billing period it now fully covers. A screenshot or typed UTR is
// evidence, not proof, of settlement - this is the one deliberate human
// checkpoint the spec requires before a payment counts anywhere in the
// resident-facing ledger (totalOutstanding, receipts, etc. all still only
// reflect Open/Closed billing_periods state, unaffected by this alone -
// closing the period is what actually changes what a resident owes).
router.post('/:id/verify', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id } = req.params;

  let transaction, isAdmin;
  try {
    ({ transaction, isAdmin } = await loadTransactionAndCheckAdmin(supabase, req.user.id, id));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (!transaction) {
    return res.status(404).json({ error: 'Transaction not found or not accessible.' });
  }
  if (!isAdmin) {
    return res.status(403).json({ error: 'Only an Admin of this transaction\'s society can verify it.' });
  }
  if (transaction.processing_status !== 'Submitted') {
    return res.status(409).json({
      error: `This transaction is already "${transaction.processing_status}" and cannot be verified again.`,
    });
  }

  const { data: updated, error: updateError } = await supabase
    .from('transactions')
    .update({
      processing_status: 'Verified',
      payment_status: 'Success',
      verified_by: req.user.id,
      verified_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (updateError) {
    return res.status(500).json({ error: updateError.message });
  }

  const { data: allocations, error: allocationsError } = await supabase
    .from('transaction_allocations')
    .select('billing_period_id')
    .eq('transaction_id', id);

  if (allocationsError) {
    return res.status(500).json({ error: allocationsError.message });
  }

  let closedPeriods = [];
  try {
    closedPeriods = await closeFullyPaidPeriods(
      supabase,
      [...new Set((allocations || []).map((a) => a.billing_period_id))]
    );
  } catch (err) {
    // Verification itself already succeeded and committed - surface the
    // period-closing failure separately rather than implying the whole
    // action failed and might need retrying (it does not).
    return res.status(500).json({
      error: `Transaction verified but closing paid-off periods failed: ${err.message}`,
      transaction: updated,
    });
  }

  const { error: auditError } = await supabase.from('audit_events').insert({
    society_id: transaction.society_id,
    actor_user_id: req.user.id,
    entity_type: 'transaction',
    entity_id: id,
    action: 'Verified',
    metadata: {
      amount: transaction.amount,
      utr_number: transaction.utr_number,
      payee_name: transaction.payee_name,
      closedPeriods,
    },
  });

  if (auditError) {
    return res.status(500).json({
      error: `Transaction verified but the audit log entry failed: ${auditError.message}`,
      transaction: updated,
      closedPeriods,
    });
  }

  res.json({ ...updated, closedPeriods });
});

// Admin-only: marks a submitted payment as not genuine (mismatched UTR,
// duplicate claim, amount doesn't match the real bank transfer, etc). Never
// touches billing_periods - a rejected transaction never counted toward any
// period in the first place, so there is nothing to reverse. A reason is
// required so the resident/committee has something concrete to act on,
// unlike a silent disappearance from the ledger.
router.post('/:id/reject', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id } = req.params;
  const { reason } = req.body || {};

  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'A non-empty reason is required to reject a transaction.' });
  }

  let transaction, isAdmin;
  try {
    ({ transaction, isAdmin } = await loadTransactionAndCheckAdmin(supabase, req.user.id, id));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (!transaction) {
    return res.status(404).json({ error: 'Transaction not found or not accessible.' });
  }
  if (!isAdmin) {
    return res.status(403).json({ error: 'Only an Admin of this transaction\'s society can reject it.' });
  }
  if (transaction.processing_status !== 'Submitted') {
    return res.status(409).json({
      error: `This transaction is already "${transaction.processing_status}" and cannot be rejected.`,
    });
  }

  const { data: updated, error: updateError } = await supabase
    .from('transactions')
    .update({
      processing_status: 'Rejected',
      payment_status: 'Failed',
      verified_by: req.user.id,
      verified_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (updateError) {
    return res.status(500).json({ error: updateError.message });
  }

  const { error: auditError } = await supabase.from('audit_events').insert({
    society_id: transaction.society_id,
    actor_user_id: req.user.id,
    entity_type: 'transaction',
    entity_id: id,
    action: 'Rejected',
    metadata: {
      amount: transaction.amount,
      utr_number: transaction.utr_number,
      payee_name: transaction.payee_name,
      reason: reason.trim(),
    },
  });

  if (auditError) {
    return res.status(500).json({
      error: `Transaction rejected but the audit log entry failed: ${auditError.message}`,
      transaction: updated,
    });
  }

  res.json(updated);
});

module.exports = router;
