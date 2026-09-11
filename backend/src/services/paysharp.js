const env = require('../config/env');

// Thin client for PaySharp's UPI Intent API
// (https://www.paysharp.in/developer/api/v1/upi/reference - confirmed
// against the live doc on 2026-09-11). Sandbox and production each have
// their own base URL + token (env.paysharpBaseUrl / env.paysharpApiToken,
// see PAYSHARP_BASE_URL/PAYSHARP_API_TOKEN in backend/.env) - whichever
// pair is actually set determines sandbox vs. production; there is no
// separate flag for it here.
//
// Every PaySharp response is wrapped as `{ code, message, data: {...} }`
// (HTTP status itself is always 200 per their own docs - `code` is the
// real success/failure signal, e.g. 6001 "order already exists", 6002
// "order not found"). Callers in this module only ever get back the inner
// `data` object on success, or a thrown Error carrying PaySharp's own
// `message` otherwise - the rest of the backend never has to unwrap that
// envelope itself.

function isConfigured() {
  return Boolean(env.paysharpBaseUrl && env.paysharpApiToken);
}

async function request(method, path, body) {
  if (!isConfigured()) {
    // Callers (routes/transactions.js) are expected to check
    // isConfigured() themselves first and return a clean 503 - this is a
    // backstop, not the primary UX, so a plain thrown Error is fine here.
    throw new Error('PaySharp is not configured (PAYSHARP_BASE_URL/PAYSHARP_API_TOKEN missing).');
  }

  const url = `${env.paysharpBaseUrl}${path}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.paysharpApiToken}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (networkError) {
    throw new Error(`Could not reach PaySharp at ${url}: ${networkError.message}`);
  }

  const json = await response.json().catch(() => ({}));

  // PaySharp's own "API Success and Error Messages" doc: HTTP status is
  // 200 even for most documented errors - `code === 200` is the actual
  // success signal. Still also guard on `response.ok` in case a network
  // intermediary (proxy, load balancer) returns a real non-200 HTTP status
  // PaySharp itself never would.
  if (!response.ok || json.code !== 200) {
    const error = new Error(json.message || `PaySharp request failed with HTTP status ${response.status}.`);
    error.paysharpCode = json.code;
    throw error;
  }

  return json.data;
}

// POST /order/intent - creates an order and returns `intentUrl` (generic
// UPI deep link), plus `gpayUrl`/`phonepeUrl` variants and
// `paysharpReferenceNo`. `orderId` must be ours, unique, max 36 chars (a
// crypto.randomUUID() fits exactly) - PaySharp returns error code 6001
// ("order exists with the same orderId") on a repeat.
function createIntentOrder({ orderId, amount, customerId, customerName, customerMobileNo, customerEmail, remarks }) {
  return request('POST', '/order/intent', {
    orderId,
    amount,
    customerId,
    ...(customerName ? { customerName } : {}),
    customerMobileNo,
    ...(customerEmail ? { customerEmail } : {}),
    remarks,
  });
}

// GET /order/{orderId} - current status: SUCCESS / PENDING / ON PROGRESS /
// FAILED (+ failureCode/failureReason) / EXPIRED. Same response shape as
// the webhook payload (minus `attemptCount`, which per PaySharp's own docs
// is "Only returned for webhook response").
function getOrderStatus(orderId) {
  return request('GET', `/order/${encodeURIComponent(orderId)}`);
}

module.exports = { isConfigured, createIntentOrder, getOrderStatus };
