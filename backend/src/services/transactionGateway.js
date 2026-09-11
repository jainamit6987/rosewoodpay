const { closeFullyPaidPeriods } = require('./billingPeriods');

// Terminal states for `data.status` coming back from PaySharp (either via
// their webhook, or GET /order/{orderId}) - see
// PAYSHARP_UPI_INTENT_INTEGRATION_PLAN.md and the UPI API reference. Not
// terminal: 'PENDING', 'ON PROGRESS' - those just update gateway_status
// with no processing_status change, same as a resident's self-reported UPI
// submission sits "Submitted" until an Admin acts.
const SUCCESS_STATUS = 'SUCCESS';
const FAILURE_STATUSES = ['FAILED', 'EXPIRED'];

// Applies a PaySharp order outcome to the matching `transactions` row.
// Shared by both routes/paysharpWebhook.js (their server-to-server push)
// and the polling fallback (GET /transactions/:id/status in
// routes/transactions.js) so the exact same outcome-application logic runs
// regardless of which path noticed the result first.
//
// Always takes `supabaseAdmin` (the service-role client), never a caller's
// RLS-scoped client: a webhook call has no logged-in user/session at all,
// and the polling path needs the same auto-verify privilege a resident
// polling their own payment does not otherwise have (only an Admin can
// normally call POST /transactions/:id/verify) - PaySharp's own
// confirmation is what stands in for that human checkpoint here, per the
// "Auto-Verify immediately on webhook SUCCESS" decision in the plan doc.
//
// `data` is PaySharp's own response/webhook body (already unwrapped from
// their `{code,message,data}` envelope by services/paysharp.js, or the
// webhook's own top-level fields - both shapes line up per their docs).
// Idempotent: safe to call more than once for the same outcome (PaySharp
// retries webhooks - `attemptCount` - and the polling endpoint can race a
// webhook that already landed).
async function applyGatewayOutcome(supabaseAdmin, data) {
  const { orderId, status, amount, utrNumber, paysharpReferenceNo, failureCode, failureReason } = data || {};

  if (!orderId) {
    throw new Error('applyGatewayOutcome called without an orderId.');
  }

  const { data: transaction, error: findError } = await supabaseAdmin
    .from('transactions')
    .select('id, society_id, processing_status')
    .eq('paysharp_order_id', orderId)
    .maybeSingle();

  if (findError) throw new Error(findError.message);
  if (!transaction) {
    // Not one of ours (or the orderId is stale/unrecognized) - nothing to
    // do. Not an error: PaySharp retries webhooks, and callers should
    // still ack 200 even here rather than triggering more retries for an
    // order we will never recognize.
    return { transaction: null, applied: false };
  }

  // Already terminal - no-op. Covers both a duplicate webhook delivery and
  // the polling endpoint racing a webhook that already landed.
  if (['Verified', 'Rejected'].includes(transaction.processing_status)) {
    return { transaction, applied: false };
  }

  if (status === SUCCESS_STATUS) {
    const nowIso = new Date().toISOString();
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('transactions')
      .update({
        processing_status: 'Verified',
        payment_status: 'Success',
        utr_number: utrNumber || null,
        paysharp_reference_no: paysharpReferenceNo || null,
        gateway_status: SUCCESS_STATUS,
        verified_at: nowIso,
        // verified_by (a auth.users FK) is deliberately left NULL - unlike
        // an Admin's manual Verify or an Admin-recorded Cash payment, no
        // human performed this action; PaySharp's own webhook/status
        // confirmation is what stands in for that checkpoint.
      })
      .eq('id', transaction.id)
      .select()
      .single();

    if (updateError) throw new Error(updateError.message);

    const { data: allocations, error: allocationsError } = await supabaseAdmin
      .from('transaction_allocations')
      .select('billing_period_id')
      .eq('transaction_id', transaction.id);
    if (allocationsError) throw new Error(allocationsError.message);

    const closedPeriods = await closeFullyPaidPeriods(
      supabaseAdmin,
      [...new Set((allocations || []).map((a) => a.billing_period_id))]
    );

    const { error: auditError } = await supabaseAdmin.from('audit_events').insert({
      society_id: transaction.society_id,
      actor_user_id: null,
      entity_type: 'transaction',
      entity_id: transaction.id,
      action: 'Verified',
      metadata: {
        amount,
        utr_number: utrNumber,
        paysharp_reference_no: paysharpReferenceNo,
        closedPeriods,
        auto_verified: true,
        gateway: 'paysharp',
      },
    });
    if (auditError) throw new Error(auditError.message);

    return { transaction: updated, applied: true, closedPeriods };
  }

  if (FAILURE_STATUSES.includes(status)) {
    const nowIso = new Date().toISOString();
    const reasonText = failureReason || (status === 'EXPIRED' ? 'Payment link/intent expired.' : 'Payment failed.');

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('transactions')
      .update({
        processing_status: 'Rejected',
        payment_status: 'Failed',
        gateway_status: status,
        gateway_failure_reason: reasonText,
        // Also copied into the existing rejection_reason column (see
        // 20260807010000_add_rejection_reason_to_transactions.sql) so it
        // surfaces on the same resident-facing receipt/history views a
        // manually-rejected payment already does, with no separate
        // gateway-aware UI needed there.
        rejection_reason: reasonText,
        verified_at: nowIso,
      })
      .eq('id', transaction.id)
      .select()
      .single();

    if (updateError) throw new Error(updateError.message);

    const { error: auditError } = await supabaseAdmin.from('audit_events').insert({
      society_id: transaction.society_id,
      actor_user_id: null,
      entity_type: 'transaction',
      entity_id: transaction.id,
      action: 'Rejected',
      metadata: {
        reason: reasonText,
        failureCode: failureCode || null,
        gateway: 'paysharp',
        gateway_status: status,
      },
    });
    if (auditError) throw new Error(auditError.message);

    return { transaction: updated, applied: true };
  }

  // PENDING / ON PROGRESS (or any other in-flight status PaySharp might
  // send) - just mirror their own status, no processing_status change yet.
  const { data: updated, error: updateError } = await supabaseAdmin
    .from('transactions')
    .update({ gateway_status: status || null })
    .eq('id', transaction.id)
    .select()
    .single();

  if (updateError) throw new Error(updateError.message);

  return { transaction: updated, applied: false };
}

module.exports = { applyGatewayOutcome };
