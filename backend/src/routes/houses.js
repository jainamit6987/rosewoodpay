const express = require('express');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

const PG_UNIQUE_VIOLATION = '23505';
const MAX_MONTHS_PER_REQUEST = 24; // guardrail against a fat-fingered "months" value, not a real business rule

// Same "walk forward one month from the house's own last row, or from the
// current month if it has none yet" logic as the auto-generation path in
// routes/transactions.js (there is no shared utils module in this codebase
// yet, so these three helpers are deliberately duplicated rather than
// importing from a sibling route file). Kept identical on purpose: whichever
// path creates a period next continues the same unbroken monthly sequence,
// so the FIFO cursor logic over there is never left with an unexplained gap.
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

// Lists a house's transactions for anyone with visibility into that house -
// not just the person who submitted each one. This is the consumer of the
// "widen transaction visibility to co-assignees" RLS policy: an owner whose
// tenant pays the bill (or vice versa) can now see the shared house's
// payment status through req.supabase, without a manual authorization
// check here - RLS decides what comes back.
router.get('/:houseId/transactions', authenticate, async (req, res) => {
  const { houseId } = req.params;
  const supabase = req.supabase;

  // houses RLS lets any member of the same society see the house row, so
  // this only distinguishes "does not exist / not in your society" from a
  // real house - it does not by itself confirm the caller is assigned to it.
  const { data: house, error: houseError } = await supabase
    .from('houses')
    .select('id')
    .eq('id', houseId)
    .maybeSingle();

  if (houseError) {
    return res.status(500).json({ error: houseError.message });
  }
  if (!house) {
    return res.status(404).json({ error: 'House not found or not accessible.' });
  }

  // transaction_allocations is embedded via its FK to transactions, so each
  // transaction shows exactly which billing period(s) it covers - a single
  // payment can span more than one (arrears catch-up, advance payments).
  const { data: transactions, error: transactionsError } = await supabase
    .from('transactions')
    .select(
      'id, house_id, submitted_by, amount, transaction_type, utr_number, txn_date, payment_status, processing_status, verified_at, created_at, transaction_allocations(billing_period_id, amount_allocated)'
    )
    .eq('house_id', houseId)
    .order('created_at', { ascending: false });

  if (transactionsError) {
    return res.status(500).json({ error: transactionsError.message });
  }

  // An empty array here is the expected, non-error outcome for a resident
  // with no active assignment to this house - the transactions RLS policy
  // filters silently rather than raising an error.
  res.json(transactions);
});

// Full billing history for a house - every period regardless of status
// (Open, Closed, Waived), not just the still-owing ones GET /me returns.
// This is the "all periods" screen from the workflow doc: GET /me
// deliberately only surfaces Open periods (it feeds the pay-dues flow), so
// a resident has had no way to see a month they already paid off, or one
// waived by the society, without this separate endpoint. Same visibility
// model as GET /:houseId/transactions above - RLS (the existing
// "Residents can view billing periods for their assigned flats" /
// "Admins and Committee can view billing periods" policies) decides what
// comes back, this route only distinguishes "house not visible at all"
// from a real result.
router.get('/:houseId/billing-periods', authenticate, async (req, res) => {
  const { houseId } = req.params;
  const supabase = req.supabase;

  const { data: house, error: houseError } = await supabase
    .from('houses')
    .select('id')
    .eq('id', houseId)
    .maybeSingle();

  if (houseError) {
    return res.status(500).json({ error: houseError.message });
  }
  if (!house) {
    return res.status(404).json({ error: 'House not found or not accessible.' });
  }

  // Newest month first, matching the transactions history endpoint's
  // newest-first ordering - a history view reads top-down as "here's the
  // most recent, and here's how it built up".
  const { data: billingPeriods, error: periodsError } = await supabase
    .from('billing_periods')
    .select('id, period_month, base_amount, amount_due, status')
    .eq('house_id', houseId)
    .order('period_month', { ascending: false });

  if (periodsError) {
    return res.status(500).json({ error: periodsError.message });
  }

  // Same as above: an empty array is the normal outcome for a resident with
  // no visible assignment to this house, not an error condition.
  res.json(billingPeriods);
});

// Admin-only: directly creates the next `months` sequential billing
// period(s) for a house, ahead of any payment - the "create billing record
// for a house (next month or future months for advance payment)" gap from
// the workflow doc. Before this, the *only* way a billing_periods row ever
// came into existence was as a side effect inside POST /transactions, when
// a payment covered more months than were currently Open - which meant a
// brand-new house had no visible dues at all until its first payment, and
// there was no way to get a period onto a resident's dues screen ahead of
// time (e.g. so they can see and pre-pay next month before it starts).
//
// Deliberately does not accept an arbitrary target period_month from the
// request - only "how many months forward" - because the FIFO allocation
// cursor in POST /transactions always resumes from the house's own latest
// existing period + 1 month; letting an admin jump straight to an arbitrary
// future month would leave a permanent, silently-never-filled gap behind it
// that nothing else in this codebase expects or fills in later. One month
// at a time, walking forward from whatever already exists, is the only
// shape that stays consistent with that cursor.
router.post('/:houseId/billing-periods', authenticate, async (req, res) => {
  const { houseId } = req.params;
  const { months } = req.body || {};
  const supabase = req.supabase;

  const monthsToCreate = months === undefined ? 1 : months;
  if (
    typeof monthsToCreate !== 'number' ||
    !Number.isInteger(monthsToCreate) ||
    monthsToCreate < 1 ||
    monthsToCreate > MAX_MONTHS_PER_REQUEST
  ) {
    return res.status(400).json({
      error: `months must be a whole number between 1 and ${MAX_MONTHS_PER_REQUEST}.`,
    });
  }

  const { data: house, error: houseError } = await supabase
    .from('houses')
    .select('id, society_id, default_monthly_amount')
    .eq('id', houseId)
    .maybeSingle();

  if (houseError) {
    return res.status(500).json({ error: houseError.message });
  }
  if (!house) {
    return res.status(404).json({ error: 'House not found or not accessible.' });
  }

  // Reads the caller's own row, always visible regardless of status via the
  // deliberately-ungated "own record" policy - same reasoning as every other
  // raw is_admin check elsewhere in this codebase, status='Active' must be
  // checked here explicitly rather than relying on RLS to have filtered it.
  const { data: adminMembership, error: adminError } = await supabase
    .from('society_members')
    .select('id')
    .eq('society_id', house.society_id)
    .eq('auth_user_id', req.user.id)
    .eq('is_admin', true)
    .eq('status', 'Active')
    .maybeSingle();

  if (adminError) {
    return res.status(500).json({ error: adminError.message });
  }
  if (!adminMembership) {
    return res.status(403).json({ error: 'Only an Admin of this house\'s society can create a billing period.' });
  }

  if (!house.default_monthly_amount) {
    return res.status(409).json({
      error: 'This house has no default monthly amount configured, so a billing period cannot be created. Set one first.',
    });
  }

  const { data: existingPeriods, error: existingError } = await supabase
    .from('billing_periods')
    .select('period_month')
    .eq('house_id', houseId)
    .order('period_month', { ascending: false })
    .limit(1);

  if (existingError) {
    return res.status(500).json({ error: existingError.message });
  }

  let cursorMonth = existingPeriods && existingPeriods.length > 0 ? existingPeriods[0].period_month : null;
  const created = [];

  for (let i = 0; i < monthsToCreate; i += 1) {
    const nextMonth = cursorMonth ? addMonths(cursorMonth, 1) : startOfCurrentMonthUtc();
    const nextMonthDate = toDateOnly(nextMonth);

    const { data: inserted, error: insertError } = await supabase
      .from('billing_periods')
      .insert({
        society_id: house.society_id,
        house_id: houseId,
        period_month: nextMonthDate,
        base_amount: house.default_monthly_amount,
        amount_due: house.default_monthly_amount,
        status: 'Open',
      })
      .select('id, period_month, base_amount, amount_due, status')
      .single();

    if (insertError) {
      // A concurrent request (or a leftover row from an earlier partial
      // call) already created this exact month - stop here rather than
      // erroring out on an otherwise-successful batch; whatever was created
      // before this point in the loop is still returned.
      if (insertError.code === PG_UNIQUE_VIOLATION) {
        break;
      }
      return res.status(500).json({
        error: `Created ${created.length} of ${monthsToCreate} requested period(s) before failing: ${insertError.message}`,
        created,
      });
    }

    created.push(inserted);
    cursorMonth = inserted.period_month;
  }

  if (created.length === 0) {
    return res.status(409).json({
      error: 'Every requested month already has a billing period for this house - nothing new to create.',
    });
  }

  const { error: auditError } = await supabase.from('audit_events').insert({
    society_id: house.society_id,
    actor_user_id: req.user.id,
    entity_type: 'billing_period',
    entity_id: created[0].id,
    action: 'Created',
    metadata: {
      house_id: houseId,
      periods_created: created.map((p) => ({ id: p.id, period_month: p.period_month })),
      requested_months: monthsToCreate,
    },
  });

  if (auditError) {
    return res.status(500).json({
      error: `Billing period(s) created but the audit log entry failed: ${auditError.message}`,
      created,
    });
  }

  res.status(201).json(created);
});

module.exports = router;
