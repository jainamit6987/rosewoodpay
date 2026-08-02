# PaySharp UPI Intent Payment Integration - Plan (not yet implemented)

Status: **Planning only.** No code has been written for this yet - all changes
explored during the planning session were reverted. This document exists so
the plan doesn't have to be re-derived when work actually starts on a feature
branch.

Source API docs: https://www.paysharp.in/developer/api/v1/upi/reference

## Why

Today, every UPI payment in this app (`WaterChargeScreen.js`,
`SubmitPaymentScreen.js`) works like this:

1. The app builds a raw `upi://pay?pa=...&pn=...&am=...&tn=...&cu=INR` link
   client-side, using the society's fixed `upi_vpa`/`upi_payee_name`, and
   opens it via `Linking.openURL()`.
2. The resident manually types the UTR/reference number they got from their
   UPI app's own confirmation screen.
3. That creates a `Submitted` transaction that sits in a queue until an
   **Admin manually verifies** it by eyeballing the UTR - there is no
   automated proof the payment actually happened; a typo'd or fabricated UTR
   is trusted until a human catches it.

PaySharp's **UPI Intent API** would let the backend create a real order tied
to a specific `orderId`, get back an `intentUrl` (plus `gpayUrl`/`phonepeUrl`
variants), and have **PaySharp's own webhook or status API definitively
confirm** success/failure (with the real UTR, amount, fee breakdown) -
removing the need to trust a resident's self-typed UTR and, per the decision
below, removing the manual Admin-review step for these payments entirely.

## Decisions already made (via AskQuestion, this session)

| Question | Decision |
|---|---|
| Which payment flows use this? | **Both** WaterCharge and Maintenance |
| What happens on webhook `SUCCESS`? | **Auto-Verify immediately** (same treatment as Cash today) - skip the manual Admin review queue |
| Do we have PaySharp credentials yet? | **No** - need to sign up and get sandbox tokens before this can be tested end-to-end |
| Is the backend publicly reachable for a webhook? | **Not yet decided** - currently local-only |

## PaySharp API surface relevant to us

All requests: `content-type: application/json`, `authorization: Bearer <token>`.
Sandbox and production each have their **own base URL and token**, obtained
from the PaySharp merchant dashboard (Settings -> Configuration).

- **`POST /order/intent`** - the one we actually need. Creates an order and
  returns `intentUrl` (generic UPI), `phonepeUrl`, `gpayUrl`, plus a
  `paysharpReferenceNo`. Request needs `orderId` (ours, unique, max 36
  chars - a `crypto.randomUUID()` fits exactly), `amount`, `customerId`,
  `customerMobileNo` (required, max 10 digits), optionally `customerName`/
  `customerEmail`, and `remarks` (max 35 chars, e.g. the orderId/invoice id).
- **`GET /order/{orderId}`** - polls current status: `SUCCESS`, `PENDING`,
  `ON PROGRESS`, `FAILED` (with `failureCode`/`failureReason`), `EXPIRED`.
  Same response shape as the webhook payload. This is our fallback path for
  environments where the webhook can't reach us yet (see Testing section).
- **Webhook** (`POST` to a URL we register in the PaySharp dashboard) - fires
  on payment completion. Must respond `200` with
  `{"code":200,"message":"success"}` or PaySharp will retry
  (`attemptCount` is included in the payload). **Not signed/HMAC'd** by
  PaySharp - our own secret token in the URL is the only thing stopping a
  stranger from POSTing fake success events (see below).
- Not planned for this pass: `/order/qrcode` (dynamic QR), `/order/request`
  (collect request to a VPA), `/vpa/validate`. These solve different UX
  problems (in-person QR scan, requesting a specific known VPA to pay) that
  aren't part of this ask; can revisit later if needed.

## Architecture plan

### 1. Database migration

Add to `transactions` (new migration, e.g.
`supabase/migrations/<timestamp>_add_paysharp_gateway_fields_to_transactions.sql`):

- `payment_gateway VARCHAR(20)` - `'paysharp'` or `NULL`. `NULL` for every
  existing row (Cash, self-reported UPI, society expenses).
- `paysharp_order_id VARCHAR(36)` - **our own** generated order id, sent to
  PaySharp as `orderId` and echoed back on every webhook/status call; this is
  what both the webhook and the polling fallback use to find the row.
  Unique (partial index, since it's `NULL` for non-gateway rows).
- `paysharp_reference_no VARCHAR(64)` - PaySharp's own reference, for
  support/reconciliation.
- `gateway_status VARCHAR(20)` - mirrors PaySharp's own vocabulary
  (`PENDING`/`ON PROGRESS`/`SUCCESS`/`FAILED`/`EXPIRED`) - kept separate from
  `processing_status` since PaySharp's states don't map 1:1 onto the
  existing `chk_processing_status` values, and a row can sit
  `gateway_status='PENDING'` while `processing_status='Submitted'` for a
  while, same as a resident's self-reported UPI submission does today.
- `gateway_failure_reason TEXT` - PaySharp's own `failureReason` (e.g.
  "Collect Expired"), so an auto-rejected payment shows the resident *why*,
  the way an Admin's manual `/reject` already requires a typed `reason`.
- A `CHECK` tying `paysharp_order_id`/`payment_gateway` to always be set
  together (never one without the other).

No RLS policy changes expected - plain additional columns, read/written
through the existing INSERT/SELECT/UPDATE policies (residents own rows,
Admins their society's); the webhook itself bypasses RLS entirely via the
service-role client, same as billing-period auto-generation already does.

**Reminder**: per this repo's established pattern (see prior progress log
entries), this sandbox has no direct Postgres access - migrations get pasted
into the Supabase Studio SQL Editor by the user, not applied via `supabase
db push`.

### 2. Backend config (`backend/src/config/env.js`, `.env.example`)

Add, all **optional** (not in the `required` array - a missing PaySharp env
var should not stop the whole backend from booting):

- `PAYSHARP_BASE_URL` - from the merchant dashboard; also determines
  sandbox vs. production.
- `PAYSHARP_API_TOKEN` - ditto, separate value per environment.
- `PAYSHARP_WEBHOOK_SECRET` - **our own** secret (e.g.
  `openssl rand -hex 32`), appended as `?secret=...` on the webhook URL we
  register with PaySharp. Needed because PaySharp does not sign/HMAC its
  webhook payloads - this is the only thing preventing a stranger from
  POSTing a fake "payment succeeded" event.

### 3. New backend code

- **`backend/src/services/billingPeriods.js`** - extract the existing
  `closeFullyPaidPeriods()` helper out of `routes/transactions.js` (currently
  private to that file) so the new gateway-outcome path can reuse it without
  duplicating the "does this period's total verified allocations now cover
  its amount_due" logic.
- **`backend/src/services/paysharp.js`** - thin API client:
  - `isConfigured()` - true only if both `PAYSHARP_BASE_URL` and
    `PAYSHARP_API_TOKEN` are set.
  - `createIntentOrder(order)` -> `POST /order/intent`.
  - `getOrderStatus(orderId)` -> `GET /order/{orderId}`.
  - Uses Node's global `fetch` (Node 22 here, no need for axios).
- **`backend/src/services/transactionGateway.js`** -
  `applyGatewayOutcome(supabaseAdmin, data)`, shared by both the webhook and
  the polling endpoint below:
  - Looks up the transaction by `paysharp_order_id` (service-role client,
    no user/session context available in a webhook call).
  - No-ops idempotently if the transaction is already `Verified`/`Rejected`
    (PaySharp retries webhooks - `attemptCount` - so this must be safe to
    call more than once for the same outcome).
  - On `SUCCESS`: sets `processing_status='Verified'`,
    `payment_status='Success'`, stores the real `utr_number` from PaySharp,
    calls `closeFullyPaidPeriods`, writes an `audit_events` row
    (`auto_verified: true, gateway: 'paysharp'`) - mirrors the existing Cash
    auto-verify path in `routes/transactions.js`.
  - On `FAILED`/`EXPIRED`: sets `processing_status='Rejected'`,
    `payment_status='Failed'`, stores `gateway_failure_reason`, writes a
    matching audit event.
  - On `PENDING`/`ON PROGRESS`: just updates `gateway_status`, no processing
    status change yet.
- **`backend/src/routes/transactions.js`** changes:
  - Extract the FIFO billing-period allocation loop (currently inline in
    `POST /`) into a reusable function, so the new endpoint below doesn't
    duplicate ~60 lines of the trickiest logic in this file (concurrent
    period auto-generation, etc).
  - **New `POST /transactions/upi-intent`** (Maintenance/WaterCharge only -
    Cash/expenses don't apply here): same house lookup, active-assignment
    check, and (for Maintenance) whole-month-multiple validation as today;
    computes allocations the same way; if `paysharp.isConfigured()` is
    false, returns a clear `503` rather than a confusing failure; otherwise
    calls PaySharp to create the order, inserts the transaction as
    `Submitted` / `gateway_status='PENDING'` / `payment_mode='UPI'` with the
    new gateway columns set, and returns
    `{ transaction, intentUrl, gpayUrl, phonepeUrl }` to the client.
  - **New `GET /transactions/:id/status`**: if the transaction is already
    terminal (`Verified`/`Rejected`), returns it as-is; if still pending and
    gateway-owned, calls PaySharp's `getOrderStatus` and runs it through
    `applyGatewayOutcome`, then returns the refreshed row. This is what lets
    the mobile app confirm a payment by polling even when no public webhook
    is reachable yet (dev/local testing) - and doubles as a safety
    reconciliation path in production too.
- **New `backend/src/routes/paysharpWebhook.js`**, mounted at
  `/webhooks/paysharp` in `index.js`, **not** behind the existing
  `authenticate` middleware (this is a server-to-server call from PaySharp,
  not a logged-in user's request). Validates `req.query.secret` against
  `PAYSHARP_WEBHOOK_SECRET`, calls `applyGatewayOutcome` via the
  service-role client, and always acks
  `{"code":200,"message":"success"}` on a recognized/handled outcome.

### 4. Mobile app changes

- **`WaterChargeScreen.js`** and **`SubmitPaymentScreen.js`**: add a new
  "Pay via UPI (instant)" path alongside the existing manual one (kept as a
  fallback for when the gateway is down/unconfigured):
  1. Call `POST /transactions/upi-intent`.
  2. `Linking.openURL(intentUrl)` (or offer separate GPay/PhonePe-specific
     buttons using `gpayUrl`/`phonepeUrl`) - same direct-`openURL`-no-
     `canOpenURL` pattern already used by the existing manual flow (see
     `SubmitPaymentScreen.js`'s own comment on why `canOpenURL` needs a
     custom dev client on Android 11+ and is deliberately avoided).
  3. Show a "waiting for confirmation" state and poll
     `GET /transactions/:id/status` every few seconds until it resolves to
     `Verified`/`Rejected`, or the user navigates away.
- No native/config changes expected - this only uses `fetch()` and
  `Linking.openURL()`, both already relied on elsewhere in this Expo-managed
  (non-ejected) project. **Testable via plain Expo Go**, no build/APK/EAS
  step needed (see Testing below).

### 5. Tests & docs

- New `backend/scripts/test-paysharp-upi-intent.js`, following this repo's
  existing test-script pattern (throwaway house/member fixtures, `check()`
  helper, cleanup at the end) - validation errors (bad amount, wrong
  transaction type, non-Maintenance/WaterCharge type), and the `503`-when-
  unconfigured behavior. Full success-path assertions need real sandbox
  credentials (see Testing below) and would be added once those exist.
- Append an entry to `Society_App_Progress_Log.md` once implemented,
  matching every prior entry's format.

## What's still needed before implementation can start for real

1. A PaySharp merchant account with **sandbox** `PAYSHARP_BASE_URL` +
   `PAYSHARP_API_TOKEN` (production ones later, before go-live).
2. A decision on webhook hosting - either deploy the backend somewhere with
   a public HTTPS URL, or use a tunnel (e.g. ngrok) for local dev. Not a
   hard blocker to *start* building (the polling fallback works without
   it), but needed before the webhook path itself can be exercised.

## Testing plan (answers from this session's Q&A)

### Do we need a phone for end-to-end testing?

**Mostly no.** PaySharp's own sandbox explicitly supports "simulate payments
from the sandbox environment" (per their site) - meaning the entire
backend flow can be verified on this PC alone:

- Order creation (`POST /order/intent`) - plain HTTP call, curl/Postman/script.
- Simulating a successful or failed payment - done from PaySharp's sandbox
  dashboard (or via their special test VPAs for the Collection Request API:
  `pstest2@yesb`, `pstest4@yesb`, `pstest6@yesb`, `pstest7@yesb`,
  `pstest8@yesb`, `pstest9@yesb` - any other VPA returns `false` in sandbox).
  This triggers a real webhook call to our backend.
- The webhook handler, `applyGatewayOutcome`, auto-verify logic, billing
  period closing, audit log - all exercised by that simulated webhook call,
  no phone involved.
- The polling endpoint (`GET /transactions/:id/status`) - calls PaySharp's
  own `GET /order/{orderId}`, also just an HTTP call.

**The one thing that genuinely needs a phone**: tapping "Pay via UPI" in the
mobile app and having it actually launch GPay/PhonePe with the amount
pre-filled (`Linking.openURL('upi://...')`). Windows has no handler for the
`upi://` scheme, so this specific deep-link/UX step can't be verified on
desktop. An Android emulator is not a good substitute either - real UPI apps
require SIM-based OTP verification during setup, which an emulator can't do.

**Recommended order**: build and validate the entire backend flow first
using PaySharp's sandbox simulate-payment feature (no phone needed), then do
one short final smoke test on a real phone just to confirm the button opens
the right UPI app with the right amount.

### Does the smoke test require packaging/installing the app?

**No.** This is a standard managed Expo project (`mobile/package.json`/
`app.json` - plain `expo start`, no `expo-dev-client`, not ejected to bare
workflow). The UPI intent feature only needs `fetch()` (already used
everywhere) and `Linking.openURL()` (already used by the existing manual UPI
flow, deliberately written to avoid `Linking.canOpenURL()` specifically
because *that* API needs a custom dev client on Android 11+ - see
`SubmitPaymentScreen.js`'s own comment). So the smoke test is just the same
workflow already used for every other feature in this app:

1. `npx expo start` on this PC (backend running too, `EXPO_PUBLIC_BACKEND_URL`
   pointing at this PC's LAN IP - already set up per the progress log).
2. Open **Expo Go** (from the Play Store/App Store, no custom build) on a
   real phone and scan the QR code.
3. Phone and PC on the same Wi-Fi/LAN.
4. Make sure the phone actually has a UPI app (GPay/PhonePe/Paytm) installed
   and logged into a real account - Expo Go itself doesn't need to know
   anything about UPI, it just hands the link to the OS.

No APK, no EAS build, no packaging step required.
