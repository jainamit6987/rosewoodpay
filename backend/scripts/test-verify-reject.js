// Verifies the Admin-only transaction verify/reject endpoints:
// - A resident cannot verify/reject their own (or anyone else's) transaction.
// - An Admin can verify a Submitted transaction; it flips to
//   processing_status=Verified/payment_status=Success, and any billing
//   period it fully covers closes automatically.
// - Verifying/rejecting a transaction a second time is rejected (409) -
//   these are one-way transitions out of Submitted.
// - An Admin can reject a Submitted transaction with a reason; it flips to
//   Rejected/Failed and never touches billing_periods (a rejected payment
//   never counted toward anything).
// - Rejecting without a reason is rejected (400).
// - Each action writes an audit_events row.
// Requires the server to be running (npm start/npm run dev) and the
// migration 20260725040000_add_audit_events_admin_insert_policy.sql applied.
// Run with: node scripts/test-verify-reject.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const HOUSE_A101 = '00000006-0000-0000-0000-000000000006'; // resident's assigned house
const HOUSE_R24 = '00000007-0000-0000-0000-000000000007'; // separate house, admin records on behalf

let passCount = 0;
let failCount = 0;

function check(label, condition, extra) {
  if (condition) {
    passCount += 1;
    console.log(`PASS - ${label}`);
  } else {
    failCount += 1;
    console.log(`FAIL - ${label}${extra ? ' -> ' + JSON.stringify(extra) : ''}`);
  }
}

async function loginToken(email, password) {
  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`login failed for ${email}: ${error.message}`);
  return data.session.access_token;
}

async function post(path, token, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function main() {
  const residentToken = await loginToken('resident@society.app', 'password');
  const adminToken = await loginToken('admin@society.app', 'password');

  // --- Set up two fresh Submitted transactions to act on: one to verify,
  // one to reject - deliberately on two *different* houses. Billing periods
  // only close on verification, not on submission, so two transactions
  // against the same house would both resolve to the same still-open
  // period (whichever submitted first does not "reserve" it) - using
  // separate houses keeps the verify and reject assertions below from
  // interfering with each other's billing period.
  const verifyUtr = `TESTVERIFYRJ${Date.now()}`;
  const rejectUtr = `TESTVERIFYRJ${Date.now()}REJ`;

  const toVerify = await post('/transactions', residentToken, {
    house_id: HOUSE_A101,
    amount: 2200,
    utr_number: verifyUtr,
  });
  const toReject = await post('/transactions', adminToken, {
    house_id: HOUSE_R24,
    amount: 2500,
    utr_number: rejectUtr,
  });

  check(
    'setup: both test transactions submitted successfully',
    toVerify.status === 201 && toReject.status === 201,
    { toVerify, toReject }
  );

  const verifyPeriodId = toVerify.body.allocations?.[0]?.billing_period_id;
  const rejectPeriodId = toReject.body.allocations?.[0]?.billing_period_id;

  // Capture the pre-test status of the period we're about to verify, so
  // cleanup can restore it exactly rather than assuming it was 'Open'.
  const { data: periodBefore } = await supabaseAdmin
    .from('billing_periods')
    .select('status')
    .eq('id', verifyPeriodId)
    .maybeSingle();

  // --- Authorization checks, before any real state change ---
  const noAuthVerify = await post(`/transactions/${toVerify.body.id}/verify`, null);
  check('unauthenticated verify is rejected (401)', noAuthVerify.status === 401, noAuthVerify);

  const residentVerify = await post(`/transactions/${toVerify.body.id}/verify`, residentToken);
  check(
    'resident cannot verify their own transaction (403)',
    residentVerify.status === 403,
    residentVerify
  );

  // Targets toVerify (on the resident's own house, A-101) rather than
  // toReject (on R-24, which this resident has no assignment to at all) -
  // RLS filters out a transaction with no visibility as a 404 "not found",
  // same as everywhere else in this codebase (see houses.js), which would
  // make this assertion pass for the wrong reason if it targeted toReject.
  const residentReject = await post(`/transactions/${toVerify.body.id}/reject`, residentToken, {
    reason: 'trying as a resident',
  });
  check(
    'resident cannot reject a transaction they can see but do not administer (403)',
    residentReject.status === 403,
    residentReject
  );

  // --- Reject: missing reason ---
  const rejectNoReason = await post(`/transactions/${toReject.body.id}/reject`, adminToken, {});
  check('reject without a reason is rejected (400)', rejectNoReason.status === 400, rejectNoReason);

  // --- Verify: happy path ---
  const verifyResult = await post(`/transactions/${toVerify.body.id}/verify`, adminToken);
  check(
    'admin verifying a Submitted transaction succeeds (200, Verified/Success)',
    verifyResult.status === 200 &&
      verifyResult.body.processing_status === 'Verified' &&
      verifyResult.body.payment_status === 'Success' &&
      verifyResult.body.verified_by,
    verifyResult
  );
  check(
    'verify closes the billing period it fully covers',
    Array.isArray(verifyResult.body.closedPeriods) && verifyResult.body.closedPeriods.includes(verifyPeriodId),
    verifyResult.body
  );

  const { data: periodAfterVerify } = await supabaseAdmin
    .from('billing_periods')
    .select('status')
    .eq('id', verifyPeriodId)
    .maybeSingle();
  check(
    'the billing period itself is now Closed in the database',
    periodAfterVerify?.status === 'Closed',
    periodAfterVerify
  );

  // --- Verify: cannot re-verify or reject an already-Verified transaction ---
  const reVerify = await post(`/transactions/${toVerify.body.id}/verify`, adminToken);
  check('re-verifying an already-Verified transaction is rejected (409)', reVerify.status === 409, reVerify);

  const rejectAfterVerify = await post(`/transactions/${toVerify.body.id}/reject`, adminToken, {
    reason: 'too late',
  });
  check(
    'rejecting an already-Verified transaction is rejected (409)',
    rejectAfterVerify.status === 409,
    rejectAfterVerify
  );

  // --- Reject: happy path ---
  const rejectResult = await post(`/transactions/${toReject.body.id}/reject`, adminToken, {
    reason: 'UTR does not match any real bank transfer',
  });
  check(
    'admin rejecting a Submitted transaction succeeds (200, Rejected/Failed)',
    rejectResult.status === 200 &&
      rejectResult.body.processing_status === 'Rejected' &&
      rejectResult.body.payment_status === 'Failed',
    rejectResult
  );

  const { data: periodAfterReject } = await supabaseAdmin
    .from('billing_periods')
    .select('status')
    .eq('id', rejectPeriodId)
    .maybeSingle();
  check(
    'rejecting never closes the billing period it would have covered',
    periodAfterReject?.status === 'Open',
    periodAfterReject
  );

  // --- Audit trail ---
  const { data: auditRows } = await supabaseAdmin
    .from('audit_events')
    .select('action, entity_id')
    .in('entity_id', [toVerify.body.id, toReject.body.id]);
  check(
    'both actions wrote an audit_events row',
    (auditRows || []).some((r) => r.entity_id === toVerify.body.id && r.action === 'Verified') &&
      (auditRows || []).some((r) => r.entity_id === toReject.body.id && r.action === 'Rejected'),
    auditRows
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // Cleanup: remove the audit rows and test transactions (allocations
  // cascade), then restore the verified period to its pre-test status so
  // this script leaves no visible trace on the seeded house.
  await supabaseAdmin.from('audit_events').delete().in('entity_id', [toVerify.body.id, toReject.body.id]);
  await supabaseAdmin.from('transactions').delete().like('utr_number', 'TESTVERIFYRJ%');
  if (verifyPeriodId && periodBefore) {
    await supabaseAdmin.from('billing_periods').update({ status: periodBefore.status }).eq('id', verifyPeriodId);
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
