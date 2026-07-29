const express = require('express');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

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

module.exports = router;
