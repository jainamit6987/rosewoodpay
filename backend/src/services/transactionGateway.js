const paysharp = require('./paysharp');
const { closeFullyPaidPeriods } = require('./billingPeriods');

// Terminal states for `data.status` coming back from PaySharp (either via
// their webhook, or GET /order/{orderId}) - see
// PAYSHARP_UPI_INTENT_INTEGRATION_PLAN.md and the UPI API reference. Not
// terminal: 'PENDING', 'ON PROGRESS' - those just update gateway_status
// with no processing_status change, same as a resident's self-reported UPI
// submission sits "Submitted" until an Admin acts.
const SUCCESS_STATUS = 'SUCCESS';
const FAILURE_STATUSES = ['FAILED', 'EXPIRED'];

// Amounts are compared in rupees with a small epsilon for floating-point
// rounding - PaySharp returns `amount` as a plain number, the same shape
// we sent when creating the order.
const AMOUNT_EPSILON = 0.01;

// Applies a PaySharp order's *current, API-confirmed* outcome to the
// matching `transactions` row. Shared by both routes/paysharpWebhook.js
// (their server-to-server push) and the polling fallback (GET
// /transactions/:id/status in routes/transactions.js) so the exact same
// outcome-application logic runs regardless of which path noticed the
// result first.
//
// SECURITY: takes only `orderId` (a string), never a caller-supplied
// status/amount payload. PaySharp does not sign or HMAC its webhook
// payloads (see the comment in routes/paysharpWebhook.js) - the `?secret=`
// query param is the only thing standing between a stranger and this
// function, and secrets can leak (a URL pasted into a dashboard, a proxy
// access log). Previously this function trusted the webhook body's own
// `status`/`amount` directly, which meant anyone who ever saw the secret
// could forge a `{ orderId, status: "SUCCESS" }` POST and auto-verify any
// pending order with no real UPI payment behind it at all. Fixed by
// treating a webhook delivery (or a poll) as nothing more than "something
// happened on this order, go check now" - the actual status and amount
// always come fresh from PaySharp's own GET /order/{orderId}, called with
// our server-side API token, which an attacker cannot forge.
//
// Always takes `supabaseAdmin` (the service-role client), never a caller's
// RLS-scoped client: a webhook call has no logged-in user/session at all,
// and the polling path needs the same auto-verify privilege a resident
// polling their own payment does not otherwise have (only an Admin can
// normally call POST /transactions/:id/verify) - PaySharp's own
// confirmation is what stands in for that human checkpoint here, per the
// "Auto-Verify immediately on webhook SUCCESS" decision in the plan doc.
//
// Idempotent: safe to call more than once for the same order (PaySharp
// retries webhooks - `attemptCount` - and the polling endpoint can race a
// webhook that already landed).
async function applyGatewayOutcome(supabaseAdmin, orderId) {
  if (!orderId) {
    throw new Error('applyGatewayOutcome called without an orderId.');
  }

  const { data: transaction, error: findError } = await supabaseAdmin
    .from('transactions')
    .select('id, society_id, amount, processing_status')
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
  // the polling endpoint racing a webhook that already landed. Also saves
  // an unnecessary PaySharp API call for a decision that's already final.
  if (['Verified', 'Rejected'].includes(transaction.processing_status)) {
    return { transaction, applied: false };
  }

  let gatewayData;
  try {
    gatewayData = await paysharp.getOrderStatus(orderId);
  } catch (err) {
    // Tagged so callers (routes/transactions.js) can tell "PaySharp itself
    // was unreachable/erroring" apart from "we reached PaySharp fine but
    // applying the result failed" - the former is a 502-shaped problem,
    // the latter a 500-shaped one.
    const wrapped = new Error(`Could not confirm order ${orderId} with PaySharp: ${err.message}`);
    wrapped.gatewayUnreachable = true;
    throw wrapped;
  }

  const { status, amount, utrNumber, paysharpReferenceNo, failureCode, failureReason } = gatewayData || {};

  if (status === SUCCESS_STATUS) {
    // Amount tampering guard: only auto-verify if PaySharp's own confirmed
    // amount matches what this transaction was created for. These should
    // always match in normal operation (PaySharp was given this exact
    // amount when the order was created via POST /transactions/upi-intent)
    // - a mismatch means something is very wrong (a forged/replayed order,
    // or a PaySharp-side inconsistency), so fail loudly and leave the
    // transaction Submitted for manual review rather than silently
    // verifying against the wrong figure.
    const confirmedAmount = Number(amount);
    const expectedAmount = Number(transaction.amount);
    if (!Number.isFinite(confirmedAmount) || Math.abs(confirmedAmount - expectedAmount) > AMOUNT_EPSILON) {
      throw new Error(
        `PaySharp-confirmed amount (${amount}) does not match stored transaction amount (${transaction.amount}) for order ${orderId} - refusing to auto-verify. Needs manual review.`
      );
    }

    const nowIso = new Date().toISOString();
    // `.eq('processing_status', 'Submitted')` makes this UPDATE an atomic
    // "claim" on the row, not just a write - a concurrent second caller
    // (the webhook firing again while a poll is also in flight, or a
    // genuinely duplicate/retried webhook delivery landing a second time
    // before the first one finished) will match ZERO rows here instead of
    // racing this one to also apply the same side effects (audit log
    // insert, closeFullyPaidPeriods) a second time. Race condition found
    // in the 2026-09-13 security audit (Medium).
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
        // human performed this action; PaySharp's own API confirmation is
        // what stands in for that checkpoint.
      })
      .eq('id', transaction.id)
      .eq('processing_status', 'Submitted')
      .select()
      .maybeSingle();

    if (updateError) throw new Error(updateError.message);
    if (!updated) {
      // Lost the race - some other concurrent call already claimed this
      // row and (or is about to) apply the exact same outcome. Re-read
      // and return its current state as a no-op rather than duplicating
      // any side effect below.
      const { data: current, error: reReadError } = await supabaseAdmin
        .from('transactions')
        .select()
        .eq('id', transaction.id)
        .single();
      if (reReadError) throw new Error(reReadError.message);
      return { transaction: current, applied: false };
    }

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

    // Same atomic-claim guard as the SUCCESS branch above.
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
      .eq('processing_status', 'Submitted')
      .select()
      .maybeSingle();

    if (updateError) throw new Error(updateError.message);
    if (!updated) {
      const { data: current, error: reReadError } = await supabaseAdmin
        .from('transactions')
        .select()
        .eq('id', transaction.id)
        .single();
      if (reReadError) throw new Error(reReadError.message);
      return { transaction: current, applied: false };
    }

    const { error: auditError } = await supabaseAdmin.from('audit_events').insert({
      society_id: transaction.society_id,
      actor_user_id: null,
      entity_type: 'transaction',
      action: 'Rejected',
      entity_id: transaction.id,
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

// PaySharp's own support confirmed (2026-10-10, in response to a direct
// question raised after a resident got stuck on an abandoned UPI Intent
// order) that an unclaimed/abandoned order is *always* resolved to
// FAILED/EXPIRED on their side within 10 minutes - there is no "forever
// pending" case on PaySharp's own end, even if nobody ever opens the UPI
// app at all. A 15-minute threshold here (not 10) is a deliberate 5-minute
// safety margin on top of PaySharp's own guarantee, not a second
// independent guess - this never marks anything failed on our own
// authority; it only decides when it's worth asking PaySharp again.
const STALE_GATEWAY_ORDER_MS = 15 * 60 * 1000;

// Opportunistic self-healing for abandoned PaySharp orders. Problem this
// solves: the mobile app's own poll (usePaysharpPayment.js) gives up after
// 3 minutes and never touches the database again, and PaySharp's webhook
// is the only other thing that would ever resolve a row left Submitted -
// if a resident simply closes the tab and never returns, and the webhook
// delivery is ever missed/delayed, that row (and the billing period it
// blocks via hasPendingSubmission/the new duplicate-order guard in
// routes/transactions.js) could sit stuck indefinitely with nothing to
// prompt a fresh check.
//
// Deliberately NOT a cron job / setInterval: this service runs on Cloud
// Run, which can scale this instance to zero between requests - an
// in-process timer is not guaranteed to ever fire. Instead, this piggybacks
// on routes that are already being called for an unrelated reason (GET
// /me when a resident opens their dues, GET /transactions/pending when an
// Admin opens the review queue) - the next time either happens after
// PaySharp's own 10-minute window has passed, this quietly re-confirms the
// real outcome before the page's own data is read, so the stale lock
// clears itself with zero new screens/buttons and no dependency on the
// webhook alone having worked.
//
// Scope the lookup to the caller's own houseIds/societyIds (never the
// whole table) - this always runs inside an already-authenticated request
// for a specific resident/admin's own data, so there's no reason to touch
// rows outside what that request already needed to look at anyway. Safe to
// call with neither filter (a no-op, matches zero rows) and safe to call
// when there is nothing stale (empty result, returns immediately). Errors
// on an individual order are logged and skipped rather than thrown - this
// is a courtesy reconciliation layered on top of the webhook's own primary
// job, never something that should be allowed to break the actual page a
// caller is loading.
async function reconcileStaleGatewayOrders(supabaseAdmin, { houseIds, societyIds } = {}) {
  if ((!houseIds || houseIds.length === 0) && (!societyIds || societyIds.length === 0)) {
    return;
  }

  let query = supabaseAdmin
    .from('transactions')
    .select('id, paysharp_order_id')
    .eq('payment_gateway', 'paysharp')
    .eq('processing_status', 'Submitted')
    .lt('created_at', new Date(Date.now() - STALE_GATEWAY_ORDER_MS).toISOString());

  if (houseIds && houseIds.length > 0) query = query.in('house_id', houseIds);
  if (societyIds && societyIds.length > 0) query = query.in('society_id', societyIds);

  const { data: staleOrders, error } = await query;
  if (error) {
    console.error('reconcileStaleGatewayOrders: lookup failed:', error.message);
    return;
  }
  if (!staleOrders || staleOrders.length === 0) return;

  for (const order of staleOrders) {
    try {
      await applyGatewayOutcome(supabaseAdmin, order.paysharp_order_id);
    } catch (err) {
      console.error(`reconcileStaleGatewayOrders: failed for order ${order.paysharp_order_id}:`, err.message);
    }
  }
}

module.exports = { applyGatewayOutcome, reconcileStaleGatewayOrders };
