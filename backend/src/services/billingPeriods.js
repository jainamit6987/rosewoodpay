// Extracted out of routes/transactions.js (previously private to that
// file) so the new PaySharp gateway-outcome path
// (services/transactionGateway.js) can reuse the exact same "does this
// period's total verified allocations now cover its amount_due" logic
// without duplicating it - the reasoning here is unchanged from before
// this file existed.

// After marking a transaction Verified, checks every billing period it has
// an allocation against and closes any period whose *total* verified
// allocations (across every transaction that has ever paid into it, not
// just this one - a period can in principle be topped up by more than one
// payment) now cover its amount_due. Left as "Open" if still short, so a
// partial/underpayment does not incorrectly close a period.
//
// `supabase` can be either the caller's RLS-scoped client (existing
// /:id/verify and Cash-at-insert-time callers) or the service-role client
// (the new PaySharp gateway-outcome path, which has no user session to
// scope to) - both expose the same query surface this function relies on.
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

module.exports = { closeFullyPaidPeriods };
