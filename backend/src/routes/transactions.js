const crypto = require('crypto');
const express = require('express');
const authenticate = require('../middleware/authenticate');
const supabaseAdmin = require('../config/supabaseAdmin');
const { closeFullyPaidPeriods } = require('../services/billingPeriods');
const paysharp = require('../services/paysharp');
const { applyGatewayOutcome } = require('../services/transactionGateway');

const router = express.Router();

// Postgres error codes we translate into specific HTTP responses instead of
// a generic 500, so the mobile client can show the resident something
// useful instead of "something went wrong".
const PG_UNIQUE_VIOLATION = '23505';
const PG_INSUFFICIENT_PRIVILEGE = '42501';

// Kept in sync with the chk_transaction_type CHECK constraint added in
// 20260725030000_add_transaction_type_and_multiple_rule.sql and extended in
// 20260803000000_add_water_charge_transaction_type.sql. MAINTENANCE_TYPE and
// WATER_CHARGE_TYPE are both a resident paying the society (house-linked,
// Cr); the three EXPENSE_TYPES are the society paying someone else (a
// vendor, an employee) and take the entirely separate, house-less path near
// the top of this handler - see
// 20260726010000_society_expenses_house_optional.sql. WATER_CHARGE_TYPE
// shares Maintenance's house-linked path (below) but deliberately skips its
// FIFO billing_periods allocation and base-amount-multiple rule - see
// 20260803000000's own comment for why this is "pay-as-you-go", not
// pre-billed like a billing period.
const TRANSACTION_TYPES = ['Maintenance', 'WaterCharge', 'UtilityBill', 'Salary', 'Other'];
const MAINTENANCE_TYPE = 'Maintenance';
const WATER_CHARGE_TYPE = 'WaterCharge';
const EXPENSE_TYPES = ['UtilityBill', 'Salary', 'Other'];
const OTHER_TYPE = 'Other';

// Kept in sync with the chk_direction/chk_direction_matches_type CHECK
// constraints added in 20260807000000_add_direction_and_month_end_closing.sql,
// which replaced the Month-End Closing report's old "infer Cr/Dr purely
// from transaction_type" logic. Maintenance/WaterCharge are unconditionally
// forced to 'Cr' and UtilityBill/Salary are unconditionally forced to 'Dr'
// below, regardless of any caller input - only Other actually reads a
// caller-supplied direction, since it is the one type that can genuinely be
// either a miscellaneous receipt (Cr, e.g. a refund/interest credit) or a
// miscellaneous payment (Dr, e.g. a donation given/misc purchase).
const DIRECTIONS = ['Cr', 'Dr'];

// Kept in sync with the chk_payment_mode CHECK constraint, extended in
// 20260802000000_extend_expense_payment_modes_and_description.sql. UPI is
// every existing/default row (a resident self-reporting their own UPI
// payment); Cash/NEFT_IMPS/Cheque can each apply to a resident's
// Maintenance payment OR a society-level expense - see that migration's
// own comment for the full reasoning on why Cash is no longer
// Maintenance-only.
const PAYMENT_MODES = ['UPI', 'Cash', 'NEFT_IMPS', 'Cheque'];
const CASH_MODE = 'Cash';

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

// --- Shared house/allocation helpers ---------------------------------
// Extracted so the new POST /upi-intent below can reuse the exact same
// house lookup, active-assignment check, whole-month-multiple rule, and
// FIFO billing-period allocation as the existing POST / handler, without
// duplicating ~90 lines of the trickiest logic in this file (concurrent
// period auto-generation included). Each returns either
// `{ errorStatus, errorBody }` (caller should respond with those two
// verbatim) or its own success shape - never both.

async function lookupHouse(supabase, house_id) {
  const { data: house, error: houseError } = await supabase
    .from('houses')
    .select('id, society_id, default_monthly_amount')
    .eq('id', house_id)
    .maybeSingle();

  if (houseError) {
    return { errorStatus: 500, errorBody: { error: houseError.message } };
  }
  if (!house) {
    return { errorStatus: 404, errorBody: { error: 'House not found or not accessible.' } };
  }
  return { house };
}

// Explicit assignment check, independent of whether any billing_periods
// exist yet for this house - a brand-new or fully-caught-up house may have
// zero periods, and callers still need to distinguish "legitimately
// nothing to see yet" from "not assigned to this house at all". RLS scopes
// this to the caller's own assignment (for residents) or any assignment in
// their society (for admins/committee), so a non-empty result here always
// means the caller is legitimately allowed to deal with this house.
async function checkActiveHouseAssignment(supabase, house_id) {
  const { data: houseAssignments, error: assignmentError } = await supabase
    .from('resident_house_assignments')
    .select('id')
    .eq('house_id', house_id)
    .eq('status', 'Active')
    .limit(1);

  if (assignmentError) {
    return { errorStatus: 500, errorBody: { error: assignmentError.message } };
  }
  if (!houseAssignments || houseAssignments.length === 0) {
    return {
      errorStatus: 403,
      errorBody: {
        error: 'No active house assignment visible for this house. Confirm you have an approved, active assignment to it.',
      },
    };
  }
  return {};
}

// Applies the Maintenance-only whole-month-multiple rule, then computes
// the FIFO billing-period allocation for Maintenance (WaterCharge always
// returns an empty, unallocated array - see this file's own comment near
// the transaction_type constants on why it is deliberately "pay-as-you-go"
// rather than pre-billed like Maintenance).
async function computeAllocations(supabase, house, transactionType, amount) {
  if (transactionType === MAINTENANCE_TYPE) {
    if (!house.default_monthly_amount) {
      return {
        errorStatus: 409,
        errorBody: {
          error:
            'This house has no default monthly amount configured, so maintenance payments cannot be validated. Ask an admin to configure a rate first.',
        },
      };
    }
    if (!isWholeMultiple(amount, Number(house.default_monthly_amount))) {
      return {
        errorStatus: 400,
        errorBody: {
          error: `Maintenance payments must be a whole-month multiple of the base amount (${house.default_monthly_amount}). Partial-month payments are not allowed - pay for one or more full months (e.g. ${house.default_monthly_amount}, ${2 * house.default_monthly_amount}, ${3 * house.default_monthly_amount}).`,
        },
      };
    }
  }

  const allocations = [];

  if (transactionType === MAINTENANCE_TYPE) {
    const { data: housePeriods, error: periodsError } = await supabase
      .from('billing_periods')
      .select('id, period_month, status, amount_due')
      .eq('house_id', house.id)
      .order('period_month', { ascending: true });

    if (periodsError) {
      return { errorStatus: 500, errorBody: { error: periodsError.message } };
    }

    // FIFO allocation across as many sequential periods as this payment
    // covers: walk the oldest still-Open periods first, consuming each
    // one's own amount_due from the submitted total (not a flat rate,
    // since a rate change could mean periods differ), and auto-generate
    // further periods - using the house's trusted default_monthly_amount,
    // never the unverified submitted amount - once the existing ones run
    // out. This one mechanism covers a single month's payment, clearing
    // several months of arrears in one lump payment, and paying ahead of
    // schedule.
    const openPeriods = housePeriods.filter((period) => period.status === 'Open');
    let cursorMonth = housePeriods.length > 0 ? housePeriods[housePeriods.length - 1].period_month : null;

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
            house_id: house.id,
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
              .eq('house_id', house.id)
              .eq('period_month', nextMonthDate)
              .single();
            if (existingError) {
              return { errorStatus: 500, errorBody: { error: existingError.message } };
            }
            period = existing;
          } else {
            return { errorStatus: 500, errorBody: { error: generateError.message } };
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
      return {
        errorStatus: 409,
        errorBody: {
          error:
            'This amount covers more than the periods available, and no default monthly amount is configured on this house to generate further ones. Ask an admin to configure a rate.',
        },
      };
    }
  }

  return { allocations };
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
    payment_mode,
    description,
    direction,
  } = req.body || {};

  if (amount === undefined || amount === null) {
    return res.status(400).json({ error: 'amount is required.' });
  }

  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number.' });
  }

  // Defaults to UPI - every existing client/seed/test row that predates
  // this field is exactly that (a resident self-reporting their own UPI
  // payment), so the default keeps them meaningful without a backfill.
  const resolvedPaymentMode = payment_mode || 'UPI';
  if (!PAYMENT_MODES.includes(resolvedPaymentMode)) {
    return res.status(400).json({ error: `payment_mode must be one of: ${PAYMENT_MODES.join(', ')}.` });
  }

  // Cash has no UTR to report and nothing to screenshot/forward - the
  // Admin recording it (checked further below, once house_id resolves to a
  // society) is themselves the attestation that it happened, the same
  // reasoning already used for UtilityBill/Salary/Other expenses just
  // below. Every other mode still needs at least one piece of evidence.
  if (resolvedPaymentMode !== CASH_MODE && !utr_number && !raw_shared_payload && !proof_file_path) {
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
  if (EXPENSE_TYPES.includes(resolvedTransactionType)) {
    // Only Other can actually choose its direction - see the DIRECTIONS
    // comment above. Defaults to 'Dr' when omitted so every existing
    // client/seed/test row that predates this field (an Other expense)
    // keeps behaving exactly as it did before this field existed.
    let resolvedDirection;
    if (resolvedTransactionType === OTHER_TYPE) {
      resolvedDirection = direction || 'Dr';
      if (!DIRECTIONS.includes(resolvedDirection)) {
        return res.status(400).json({ error: `direction must be one of: ${DIRECTIONS.join(', ')}.` });
      }
    } else {
      resolvedDirection = 'Dr';
    }

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
        error:
          resolvedDirection === 'Cr'
            ? 'payee_name is required for Other income transactions (who or what this money came from).'
            : 'payee_name is required for non-Maintenance transactions (who or what was paid).',
      });
    }
    if (!description || typeof description !== 'string' || !description.trim()) {
      return res.status(400).json({
        error: 'description is required for non-Maintenance transactions (what this payment was for).',
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
        direction: resolvedDirection,
        payment_mode: resolvedPaymentMode,
        payee_name: payee_name.trim(),
        description: description.trim(),
        processing_status: 'Verified',
        payment_status: 'Success',
        verified_by: req.user.id,
        verified_at: nowIso,
      })
      .select()
      .single();

    if (insertError) {
      if (insertError.code === PG_UNIQUE_VIOLATION) {
        return res.status(409).json({ error: 'This reference number has already been submitted for this society.' });
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
        payment_mode: transaction.payment_mode,
        payee_name: transaction.payee_name,
        description: transaction.description,
        transaction_type: transaction.transaction_type,
        direction: transaction.direction,
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
    return res.status(400).json({ error: `house_id is required for ${resolvedTransactionType} payments.` });
  }

  // society_id is derived from the house, never trusted from the request
  // body, so a caller cannot submit into a society they are not a member of.
  const houseResult = await lookupHouse(supabase, house_id);
  if (houseResult.errorStatus) {
    return res.status(houseResult.errorStatus).json(houseResult.errorBody);
  }
  const { house } = houseResult;

  // Cash is deliberately Admin-only, not Committee - the same authorization
  // level as /:id/verify itself (see loadTransactionAndCheckAdmin below),
  // since recording one effectively performs that verification inline
  // rather than leaving it Submitted for a separate review. Checked here,
  // once house_id has resolved to a real society, rather than earlier -
  // this reads the caller's own row (always visible regardless of status
  // via the ungated "own record" policy), so status='Active' must be
  // checked explicitly too, same reasoning as every other raw is_admin
  // check in this file.
  if (resolvedPaymentMode === CASH_MODE) {
    const { data: cashAdminMembership, error: cashAdminError } = await supabase
      .from('society_members')
      .select('id')
      .eq('society_id', house.society_id)
      .eq('auth_user_id', req.user.id)
      .eq('is_admin', true)
      .eq('status', 'Active')
      .maybeSingle();

    if (cashAdminError) {
      return res.status(500).json({ error: cashAdminError.message });
    }
    if (!cashAdminMembership) {
      return res.status(403).json({ error: 'Only an Admin of this house\'s society can record a Cash payment.' });
    }
  }

  // Explicit assignment check, independent of whether any billing_periods
  // exist yet for this house - a brand-new or fully-caught-up house may
  // have zero periods, and we still need to distinguish "legitimately
  // nothing to see yet" from "not assigned to this house at all" before
  // deciding whether to auto-generate anything below. RLS scopes this to
  // the caller's own assignment (for residents) or any assignment in their
  // society (for admins/committee), so a non-empty result here always
  // means the caller is legitimately allowed to deal with this house.
  const assignmentResult = await checkActiveHouseAssignment(supabase, house_id);
  if (assignmentResult.errorStatus) {
    return res.status(assignmentResult.errorStatus).json(assignmentResult.errorBody);
  }

  // Base-amount-multiple rule (Maintenance only) plus the FIFO
  // billing-period allocation - see computeAllocations above.
  // WaterCharge deliberately never touches billing_periods at all - see
  // 20260803000000_add_water_charge_transaction_type.sql's own comment on
  // why this is "pay-as-you-go" rather than pre-billed like Maintenance -
  // allocations stays empty for it, all the way through to the
  // transaction_allocations insert below (skipped entirely when empty).
  const allocationsResult = await computeAllocations(supabase, house, resolvedTransactionType, amount);
  if (allocationsResult.errorStatus) {
    return res.status(allocationsResult.errorStatus).json(allocationsResult.errorBody);
  }
  const allocations = allocationsResult.allocations;

  // Cash is auto-Verified at insert time, same as the society-expense
  // branch above and for the same reason: the Admin recording it (checked
  // above) is already the attestation that it happened, so there is no
  // separate untrusted self-report to double-check afterward the way a
  // resident's own UPI/UTR claim needs to be.
  const cashVerifiedAtIso = resolvedPaymentMode === CASH_MODE ? new Date().toISOString() : null;

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
      direction: 'Cr', // Maintenance/WaterCharge are always a resident paying the society - see DIRECTIONS comment above.
      payment_mode: resolvedPaymentMode,
      description: description ? description.trim() : null,
      ...(resolvedPaymentMode === CASH_MODE
        ? {
            processing_status: 'Verified',
            payment_status: 'Success',
            verified_by: req.user.id,
            verified_at: cashVerifiedAtIso,
          }
        : {}),
    })
    .select()
    .single();

  if (insertError) {
    if (insertError.code === PG_UNIQUE_VIOLATION) {
      return res.status(409).json({ error: 'This reference number has already been submitted for this society.' });
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
  //
  // allocations is always empty for WaterCharge (see above) - skipping the
  // insert entirely rather than calling .insert([]) sidesteps relying on
  // PostgREST's own empty-array-insert behavior, which is not guaranteed
  // to return a clean empty success the same way a non-empty insert does.
  let insertedAllocations = [];
  if (allocations.length > 0) {
    const { data, error: allocationError } = await supabase
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
    insertedAllocations = data;
  }

  // Cash was inserted already-Verified above, so it needs the same
  // period-closing + audit-log side effects /:id/verify normally performs
  // on a Submitted transaction - nothing will ever call verify on this row
  // since it never sits in Submitted to begin with.
  if (resolvedPaymentMode === CASH_MODE) {
    let closedPeriods = [];
    try {
      closedPeriods = await closeFullyPaidPeriods(
        supabase,
        [...new Set(allocations.map((a) => a.billing_period_id))]
      );
    } catch (err) {
      return res.status(500).json({
        error: `Cash payment recorded but closing paid-off periods failed: ${err.message}`,
        transaction,
        allocations: insertedAllocations,
      });
    }

    const { error: cashAuditError } = await supabase.from('audit_events').insert({
      society_id: transaction.society_id,
      actor_user_id: req.user.id,
      entity_type: 'transaction',
      entity_id: transaction.id,
      action: 'Verified',
      metadata: {
        amount: transaction.amount,
        payment_mode: CASH_MODE,
        closedPeriods,
        auto_verified: true,
      },
    });

    if (cashAuditError) {
      return res.status(500).json({
        error: `Cash payment recorded but the audit log entry failed: ${cashAuditError.message}`,
        transaction,
        allocations: insertedAllocations,
        closedPeriods,
      });
    }

    return res.status(201).json({ ...transaction, allocations: insertedAllocations, closedPeriods });
  }

  res.status(201).json({ ...transaction, allocations: insertedAllocations });
});

// Backend-initiated PaySharp UPI Intent order - the automated-confirmation
// counterpart to POST /'s manual "build a upi://pay link ourselves +
// resident types the UTR" flow, per PAYSHARP_UPI_INTENT_INTEGRATION_PLAN.md.
// Maintenance/WaterCharge only - Cash and the society-expense types
// (UtilityBill/Salary/Other) don't apply here at all, since there is no
// "gateway payment" concept for either (Cash has no UPI leg; expenses are
// the society paying someone else, not a resident paying in). Reuses the
// exact same house lookup, active-assignment check, and (for Maintenance)
// whole-month-multiple validation + FIFO allocation as POST / above via
// the shared helpers, so the two paths can never validate a submission
// differently.
router.post('/upi-intent', authenticate, async (req, res) => {
  const { house_id, amount, transaction_type, customer_mobile_no, customer_name, customer_email } = req.body || {};

  if (amount === undefined || amount === null) {
    return res.status(400).json({ error: 'amount is required.' });
  }
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number.' });
  }

  const resolvedTransactionType = transaction_type || MAINTENANCE_TYPE;
  if (![MAINTENANCE_TYPE, WATER_CHARGE_TYPE].includes(resolvedTransactionType)) {
    return res.status(400).json({
      error: `transaction_type must be one of: ${MAINTENANCE_TYPE}, ${WATER_CHARGE_TYPE}. A PaySharp UPI Intent order is only for a resident paying the society, not Cash or a society expense.`,
    });
  }

  if (!house_id) {
    return res.status(400).json({ error: `house_id is required for ${resolvedTransactionType} payments.` });
  }

  const supabase = req.supabase;

  const houseResult = await lookupHouse(supabase, house_id);
  if (houseResult.errorStatus) {
    return res.status(houseResult.errorStatus).json(houseResult.errorBody);
  }
  const { house } = houseResult;

  const assignmentResult = await checkActiveHouseAssignment(supabase, house_id);
  if (assignmentResult.errorStatus) {
    return res.status(assignmentResult.errorStatus).json(assignmentResult.errorBody);
  }

  const allocationsResult = await computeAllocations(supabase, house, resolvedTransactionType, amount);
  if (allocationsResult.errorStatus) {
    return res.status(allocationsResult.errorStatus).json(allocationsResult.errorBody);
  }
  const allocations = allocationsResult.allocations;

  // The caller's own society_members row in this house's society - source
  // of the customerName/customerMobileNo fallback PaySharp needs, and of
  // `customerId`. Deliberately the CALLER's own membership, not the
  // house's - this endpoint is for a resident paying via their own phone
  // (the intent link opens on whichever device calls this), so an Admin
  // wanting to record a payment on a different resident's behalf should
  // keep using the manual POST / flow, not this one.
  const { data: membership, error: membershipError } = await supabase
    .from('society_members')
    .select('id, name, phone_number')
    .eq('auth_user_id', req.user.id)
    .eq('society_id', house.society_id)
    .eq('status', 'Active')
    .maybeSingle();

  if (membershipError) {
    return res.status(500).json({ error: membershipError.message });
  }
  if (!membership) {
    return res.status(403).json({ error: "No active membership found for you in this house's society." });
  }

  // PaySharp requires exactly 10 digits - strips anything else (spaces,
  // +91, dashes) and takes the last 10, same normalization a resident's
  // pasted-in number would typically need. phone_number is optional/
  // self-service (see 20260725010000_add_phone_number_to_society_members.sql)
  // so it will not always be on file - callers can pass customer_mobile_no
  // explicitly to cover that gap (e.g. a one-time prompt in the mobile UI).
  const rawMobileNo = customer_mobile_no || membership.phone_number || '';
  const resolvedMobileNo = String(rawMobileNo).replace(/\D/g, '').slice(-10);
  if (resolvedMobileNo.length !== 10) {
    return res.status(400).json({
      error:
        'A 10-digit customer_mobile_no is required by PaySharp and none is on file for you. Pass customer_mobile_no in the request body, or ask an admin to set your phone number first.',
    });
  }

  // Checked here - after every validation that only depends on our own
  // data, but before anything PaySharp-specific (order id, the actual API
  // call) - so a request with genuinely bad input still gets its real 400/
  // 403/404/409 even while PaySharp itself is unconfigured (e.g. this
  // sandbox, before credentials exist), and a misconfigured backend still
  // fails cleanly for an otherwise-valid request instead of a confusing
  // failure partway through order creation.
  if (!paysharp.isConfigured()) {
    return res.status(503).json({
      error:
        'PaySharp is not configured on this backend (PAYSHARP_BASE_URL/PAYSHARP_API_TOKEN missing). Use the manual UPI flow (POST /transactions) instead.',
    });
  }

  // Ours, unique, max 36 chars per PaySharp's own limit - a
  // crypto.randomUUID() fits exactly and doubles as `remarks` (their
  // "recommend passing orderId/invoiceId" guidance), truncated to their
  // 35-char remarks limit (one less than orderId's own 36).
  const orderId = crypto.randomUUID();

  let intentOrder;
  try {
    intentOrder = await paysharp.createIntentOrder({
      orderId,
      amount,
      customerId: membership.id,
      customerName: customer_name || membership.name || undefined,
      customerMobileNo: resolvedMobileNo,
      customerEmail: customer_email || req.user.email || undefined,
      remarks: orderId.slice(0, 35),
    });
  } catch (err) {
    return res.status(502).json({ error: `PaySharp order creation failed: ${err.message}` });
  }

  const { data: transaction, error: insertError } = await supabase
    .from('transactions')
    .insert({
      society_id: house.society_id,
      house_id,
      submitted_by: req.user.id,
      amount,
      transaction_type: resolvedTransactionType,
      direction: 'Cr', // Maintenance/WaterCharge are always a resident paying the society - see DIRECTIONS comment above.
      payment_mode: 'UPI',
      payment_gateway: 'paysharp',
      paysharp_order_id: orderId,
      paysharp_reference_no: intentOrder.paysharpReferenceNo || null,
      gateway_status: 'PENDING',
    })
    .select()
    .single();

  if (insertError) {
    // The PaySharp order already exists at this point (orphaned from our
    // side, but harmless - it will simply expire unpaid, or a paid one can
    // be manually reconciled via paysharp_order_id below). Surfaced with
    // the order id so support can find it either way.
    if (insertError.code === PG_INSUFFICIENT_PRIVILEGE || insertError.message?.includes('row-level security')) {
      return res.status(403).json({
        error: 'Not allowed to submit for this house. It must be an approved, active house assignment.',
      });
    }
    return res.status(500).json({
      error: `PaySharp order ${orderId} was created but recording the transaction failed: ${insertError.message}. Contact support with this order id.`,
    });
  }

  // Same "skip insert entirely when empty" reasoning as POST / above -
  // allocations is always empty for WaterCharge.
  let insertedAllocations = [];
  if (allocations.length > 0) {
    const { data, error: allocationError } = await supabase
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
    insertedAllocations = data;
  }

  res.status(201).json({
    ...transaction,
    allocations: insertedAllocations,
    intentUrl: intentOrder.intentUrl,
    gpayUrl: intentOrder.gpayUrl,
    phonepeUrl: intentOrder.phonepeUrl,
    // paytmUrl/bhimUrl/amazonPayUrl are ours, not PaySharp's - see
    // deriveAdditionalUpiAppUrls's own comment in services/paysharp.js.
    ...paysharp.deriveAdditionalUpiAppUrls(intentOrder.intentUrl),
  });
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
      'id, society_id, house_id, submitted_by, amount, transaction_type, direction, utr_number, payment_mode, payee_name, description, txn_date, processing_status, created_at, houses(house_number), transaction_allocations(billing_period_id, amount_allocated, billing_periods(period_month))'
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
      `id, society_id, house_id, submitted_by, amount, transaction_type, direction, utr_number, payment_mode, payee_name, description, txn_date, payment_status, processing_status, verified_by, verified_at, created_at, houses(house_number), ${allocationsEmbed}(billing_period_id, amount_allocated)`
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
      'id, house_id, submitted_by, amount, transaction_type, direction, utr_number, payment_mode, description, txn_date, payment_status, processing_status, verified_at, created_at, houses(house_number), transaction_allocations(billing_period_id, amount_allocated, billing_periods(period_month))'
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

// closeFullyPaidPeriods now lives in services/billingPeriods.js (imported
// at the top of this file) - extracted so the new PaySharp gateway-outcome
// path (services/transactionGateway.js) can reuse it without duplicating
// this logic. Behavior is unchanged.

// Polling fallback/reconciliation check for a PaySharp gateway order,
// alongside their webhook (routes/paysharpWebhook.js) - what lets the
// mobile app confirm a payment even when no public webhook is reachable
// yet (local/dev testing), and doubles as a safety net in production too
// (see PAYSHARP_UPI_INTENT_INTEGRATION_PLAN.md). Available to anyone who
// can already see this transaction (the resident who submitted it, a
// co-assignee of the same house, or an Admin/Committee member of its
// society) - same visibility every other transaction read already has,
// nothing gateway-specific about who may check on it.
router.get('/:id/status', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id } = req.params;

  // RLS-scoped read first - both confirms the caller can actually see this
  // transaction and gives a clean 404 rather than leaking existence
  // otherwise, before any PaySharp call is made.
  const { data: transaction, error: transactionError } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (transactionError) {
    return res.status(500).json({ error: transactionError.message });
  }
  if (!transaction) {
    return res.status(404).json({ error: 'Transaction not found or not accessible.' });
  }

  // Already terminal, or not a gateway-owned row at all (self-reported
  // UPI/Cash/expense) - nothing to poll, return as-is.
  if (['Verified', 'Rejected'].includes(transaction.processing_status)) {
    return res.json(transaction);
  }
  if (transaction.payment_gateway !== 'paysharp' || !transaction.paysharp_order_id) {
    return res.json(transaction);
  }

  if (!paysharp.isConfigured()) {
    return res.status(503).json({
      error: 'PaySharp is not configured on this backend right now, so its status cannot be polled.',
      transaction,
    });
  }

  let gatewayData;
  try {
    gatewayData = await paysharp.getOrderStatus(transaction.paysharp_order_id);
  } catch (err) {
    return res.status(502).json({ error: `Could not reach PaySharp for order status: ${err.message}`, transaction });
  }

  // Uses supabaseAdmin, not the caller's RLS-scoped client, same reasoning
  // as the webhook path - applying a SUCCESS outcome auto-Verifies the
  // transaction, a privilege a resident polling their own payment does not
  // otherwise have (only an Admin can normally call POST /:id/verify).
  // Visibility was already confirmed by the RLS-scoped read above, so this
  // does not leak anything the caller could not already see.
  try {
    const { transaction: updated } = await applyGatewayOutcome(supabaseAdmin, {
      orderId: transaction.paysharp_order_id,
      ...gatewayData,
    });
    return res.json(updated || transaction);
  } catch (err) {
    return res.status(500).json({
      error: `Fetched PaySharp status but applying it failed: ${err.message}`,
      transaction,
    });
  }
});

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
      // Resident-readable copy of the same string below - see
      // 20260807010000_add_rejection_reason_to_transactions.sql for why this
      // duplicates rather than replaces the audit_events entry.
      rejection_reason: reason.trim(),
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
