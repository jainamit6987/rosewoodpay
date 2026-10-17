const crypto = require('crypto');
const express = require('express');
const env = require('../config/env');
const supabaseAdmin = require('../config/supabaseAdmin');
const { applyGatewayOutcome } = require('../services/transactionGateway');

const router = express.Router();

// Constant-time secret comparison - a plain `!==` leaks how many leading
// bytes matched via response-time differences (a timing side-channel).
// Real-world exploitability against a 32+ byte random secret is low, but
// this is a $0 fix for a payment-verification gate, so no reason not to.
function secretsMatch(provided, expected) {
  const providedBuf = Buffer.from(String(provided || ''));
  const expectedBuf = Buffer.from(String(expected || ''));
  // timingSafeEqual throws if lengths differ, so compare lengths first -
  // still safe, since revealing *length* alone (not content) leaks far
  // less than revealing content byte-by-byte would.
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

// PaySharp's UPI webhook - registered in their merchant dashboard
// (Settings -> Configuration -> Webhook), set to trigger for "All Cases"
// (not Success-only - applyGatewayOutcome below auto-REJECTs on
// FAILED/EXPIRED too, which would otherwise lose its fast path and fall
// back entirely to the slower GET /transactions/:id/status polling path).
// Fires on payment completion with the same shape as GET /order/{orderId}
// (see services/paysharp.js), plus an `attemptCount`.
//
// Auth (2026-10-17, revised): PaySharp's dashboard turned out to support a
// genuine "Bearer Auth" webhook option after all - this now checks the
// `Authorization: Bearer <PAYSHARP_WEBHOOK_SECRET>` header as the primary
// path, closing a real gap the original `?secret=` query-param approach
// had: Cloud Run's own automatic request logs capture the full request
// path INCLUDING query strings by default, so that secret used to sit in
// plaintext in Cloud Logging on every single webhook delivery, visible to
// anyone with a Logs Viewer+ IAM role. A header is not captured by that
// same default request logging. The query param is still accepted as a
// fallback purely so the sandbox webhook (still registered the old way)
// keeps working untouched - reconfigure sandbox to Bearer Auth too
// whenever convenient, then this fallback can be deleted.
//
// Deliberately NOT behind the `authenticate` middleware - this is a
// server-to-server call from PaySharp, not a logged-in user's request, and
// there is no user session/bearer token to check. PaySharp does not sign/
// HMAC its webhook payloads at all (confirmed in
// PAYSHARP_UPI_INTENT_INTEGRATION_PLAN.md and their own docs), so this
// secret is the ONLY thing stopping a stranger from POSTing a fake
// "payment succeeded" event here - treat it as seriously as an API key.
function extractBearerToken(authorizationHeader) {
  const header = authorizationHeader || '';
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

router.post('/', async (req, res) => {
  if (!env.paysharpWebhookSecret) {
    // Not configured yet - reject outright rather than silently accepting
    // unauthenticated webhook calls with nothing to check them against.
    return res.status(503).json({ error: 'PAYSHARP_WEBHOOK_SECRET is not configured on this backend.' });
  }
  const providedSecret = extractBearerToken(req.headers.authorization) || req.query.secret;
  if (!secretsMatch(providedSecret, env.paysharpWebhookSecret)) {
    return res.status(401).json({ error: 'Invalid or missing webhook secret.' });
  }

  // Only the orderId is ever taken from the webhook body - never its
  // status/amount/utrNumber. See the SECURITY comment on
  // applyGatewayOutcome (services/transactionGateway.js) for why: PaySharp
  // does not sign webhook payloads, so the body itself cannot be trusted
  // as the source of truth, only as a "go check now" trigger. The actual
  // outcome always comes from PaySharp's own GET /order/{orderId}, fetched
  // inside applyGatewayOutcome with our server-side API token.
  const orderId = req.body?.orderId;

  try {
    await applyGatewayOutcome(supabaseAdmin, orderId);
  } catch (err) {
    // Security/reliability audit finding (Medium, 2026-09-13): this used
    // to always ack 200 even here, which meant a genuinely transient
    // failure on our side (a momentary DB hiccup, PaySharp's own status
    // API briefly erroring) was silently swallowed - PaySharp's own docs
    // say a non-200 response makes them retry (`attemptCount`), so always
    // acking 200 was throwing away that free retry mechanism for exactly
    // the failures it exists to handle. Now returns 500 on any real
    // failure so PaySharp retries; GET /transactions/:id/status (the
    // polling fallback) remains the safety net if a webhook outcome is
    // ever missed entirely regardless.
    //
    // Only orderId + the error message are logged, never the full request
    // body - it can contain UTR numbers and other payment metadata that
    // shouldn't sit in plaintext application logs (Cloud Run's log viewer
    // is broader-access than this data warrants).
    console.error(`paysharp webhook: applyGatewayOutcome failed for order ${orderId}:`, err.message);
    return res.status(500).json({ error: 'Failed to process webhook - please retry.' });
  }

  // Must respond 200 with exactly this shape - see the UPI Webhook section
  // of https://www.paysharp.in/developer/api/v1/upi/reference - or
  // PaySharp will keep retrying this same delivery. Only reached on a
  // genuine success/safe-no-op (unrecognized orderId, already-terminal
  // row, etc.) above - see the catch block for the failure path.
  res.status(200).json({ code: 200, message: 'success' });
});

module.exports = router;
