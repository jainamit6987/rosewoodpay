const express = require('express');
const env = require('../config/env');
const supabaseAdmin = require('../config/supabaseAdmin');
const { applyGatewayOutcome } = require('../services/transactionGateway');

const router = express.Router();

// PaySharp's UPI webhook - registered in their merchant dashboard
// (Settings -> Configuration) as
// POST https://<our-public-host>/webhooks/paysharp?secret=<PAYSHARP_WEBHOOK_SECRET>.
// Fires on payment completion with the same shape as GET /order/{orderId}
// (see services/paysharp.js), plus an `attemptCount`.
//
// Deliberately NOT behind the `authenticate` middleware - this is a
// server-to-server call from PaySharp, not a logged-in user's request, and
// there is no user session/bearer token to check. PaySharp does not sign/
// HMAC its webhook payloads at all (confirmed in
// PAYSHARP_UPI_INTENT_INTEGRATION_PLAN.md and their own docs), so the
// `?secret=` query param is the ONLY thing stopping a stranger from
// POSTing a fake "payment succeeded" event here - treat it as seriously as
// an API key.
router.post('/', async (req, res) => {
  if (!env.paysharpWebhookSecret) {
    // Not configured yet - reject outright rather than silently accepting
    // unauthenticated webhook calls with nothing to check them against.
    return res.status(503).json({ error: 'PAYSHARP_WEBHOOK_SECRET is not configured on this backend.' });
  }
  if (req.query.secret !== env.paysharpWebhookSecret) {
    return res.status(401).json({ error: 'Invalid or missing webhook secret.' });
  }

  try {
    await applyGatewayOutcome(supabaseAdmin, req.body || {});
  } catch (err) {
    // Still ack 200 below even on an internal failure here - per
    // PaySharp's own docs, a non-200 response makes them retry
    // (`attemptCount`), which is the right behavior for a transient
    // failure on our side (e.g. a momentary DB hiccup), but we cannot
    // distinguish that from a permanent one from here. Logged server-side
    // for follow-up; GET /transactions/:id/status (the polling fallback)
    // is the safety net if a webhook outcome is ever missed entirely.
    console.error('paysharp webhook: applyGatewayOutcome failed for body', req.body, err);
  }

  // Must respond 200 with exactly this shape - see the UPI Webhook section
  // of https://www.paysharp.in/developer/api/v1/upi/reference - or
  // PaySharp will keep retrying this same delivery.
  res.status(200).json({ code: 200, message: 'success' });
});

module.exports = router;
