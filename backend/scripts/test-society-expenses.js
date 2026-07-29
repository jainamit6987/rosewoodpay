// Verifies the society-expense feature added in
// 20260726010000_society_expenses_house_optional.sql: UtilityBill/Salary/
// Other transactions are the society paying someone (a vendor, an
// employee), never something a house owes, so they:
//   - never take a house_id (rejected outright if one is provided);
//   - require payee_name and society_id instead;
//   - are Admin-only (a resident, even one with an active house
//     assignment, cannot submit one);
//   - skip billing_periods/transaction_allocations entirely;
//   - are still enforced at the DB level, not just the app layer - a raw
//     insert that pairs a non-Maintenance type with a house_id must fail
//     the CHECK constraint even when it bypasses RLS entirely (service
//     role);
//   - are recorded already-Verified, not Submitted - discussed and
//     confirmed with the user: unlike Maintenance (where Verify/Reject
//     gates whether a billing period gets credited), an expense has no
//     analogous debt to leave uncleared, and the money is already gone by
//     the time an Admin types it in, so a self-reviewed Submitted
//     checkpoint here would be theater. This also means they never appear
//     in GET /transactions/pending, and re-verifying/rejecting one is
//     rejected (409) exactly like any other already-Verified transaction.
// Requires the server to be running (npm start/npm run dev) and this
// migration applied. Run with: node scripts/test-society-expenses.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const SOCIETY_ID = '00000003-0000-0000-0000-000000000003';
const HOUSE_A101 = '00000006-0000-0000-0000-000000000006';

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
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function get(path, token) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function main() {
  const residentToken = await loginToken('resident@society.app', 'password');
  const adminToken = await loginToken('admin@society.app', 'password');
  const testUtr = `TESTEXPENSE${Date.now()}`;

  // --- Validation ---
  const noAuth = await post('/transactions', null, {
    society_id: SOCIETY_ID,
    amount: 3500,
    utr_number: `${testUtr}NOAUTH`,
    transaction_type: 'UtilityBill',
    payee_name: 'BEST Electricity',
  });
  check('unauthenticated expense submission is rejected (401)', noAuth.status === 401, noAuth);

  const missingPayee = await post('/transactions', adminToken, {
    society_id: SOCIETY_ID,
    amount: 3500,
    utr_number: `${testUtr}NOPAYEE`,
    transaction_type: 'UtilityBill',
  });
  check(
    'missing payee_name is rejected (400)',
    missingPayee.status === 400 && /payee_name/i.test(missingPayee.body.error || ''),
    missingPayee
  );

  const missingSociety = await post('/transactions', adminToken, {
    amount: 3500,
    utr_number: `${testUtr}NOSOCIETY`,
    transaction_type: 'Salary',
    payee_name: 'Ramesh - Security Guard',
  });
  check(
    'missing society_id is rejected (400)',
    missingSociety.status === 400 && /society_id/i.test(missingSociety.body.error || ''),
    missingSociety
  );

  const withHouseId = await post('/transactions', adminToken, {
    society_id: SOCIETY_ID,
    house_id: HOUSE_A101,
    amount: 3500,
    utr_number: `${testUtr}WITHHOUSE`,
    transaction_type: 'UtilityBill',
    payee_name: 'BEST Electricity',
  });
  check(
    'providing house_id for an expense type is rejected (400)',
    withHouseId.status === 400 && /house_id must not be provided/i.test(withHouseId.body.error || ''),
    withHouseId
  );

  // --- Admin-only ---
  const residentAttempt = await post('/transactions', residentToken, {
    society_id: SOCIETY_ID,
    amount: 3500,
    utr_number: `${testUtr}RESIDENT`,
    transaction_type: 'UtilityBill',
    payee_name: 'BEST Electricity',
  });
  check(
    'a resident (not an Admin) cannot submit a society expense, even with an active house assignment (403)',
    residentAttempt.status === 403,
    residentAttempt
  );

  // --- Happy path: Admin records a UtilityBill expense, auto-Verified ---
  const utilityBill = await post('/transactions', adminToken, {
    society_id: SOCIETY_ID,
    amount: 3500,
    utr_number: `${testUtr}UTILITY`,
    transaction_type: 'UtilityBill',
    payee_name: 'BEST Electricity',
  });
  check(
    'Admin recording a UtilityBill expense succeeds (201), house_id null, no allocations, already Verified',
    utilityBill.status === 201 &&
      utilityBill.body.house_id === null &&
      utilityBill.body.payee_name === 'BEST Electricity' &&
      Array.isArray(utilityBill.body.allocations) &&
      utilityBill.body.allocations.length === 0 &&
      utilityBill.body.processing_status === 'Verified' &&
      utilityBill.body.payment_status === 'Success' &&
      utilityBill.body.verified_by === utilityBill.body.submitted_by,
    utilityBill.body
  );

  // --- Happy path: Admin records a Salary expense (no utr_number, uses raw_shared_payload as proof instead) ---
  const salary = await post('/transactions', adminToken, {
    society_id: SOCIETY_ID,
    amount: 12000,
    raw_shared_payload: 'Cash paid to security guard for June, receipt signed.',
    transaction_type: 'Salary',
    payee_name: 'Ramesh - Security Guard',
  });
  check(
    'Admin recording a Salary expense with no UTR (proof via raw_shared_payload) succeeds (201), already Verified',
    salary.status === 201 &&
      salary.body.transaction_type === 'Salary' &&
      salary.body.house_id === null &&
      salary.body.processing_status === 'Verified',
    salary.body
  );

  // --- DB-level enforcement, independent of the app layer: a raw insert
  // via the service-role client (bypasses RLS entirely) pairing a
  // non-Maintenance type with a house_id must still fail, proving the
  // CHECK constraint - not just this route's validation - is what actually
  // guarantees the invariant.
  const { error: rawInsertError } = await supabaseAdmin.from('transactions').insert({
    society_id: SOCIETY_ID,
    house_id: HOUSE_A101,
    submitted_by: '00000001-0000-0000-0000-000000000001',
    amount: 500,
    transaction_type: 'Other',
    payee_name: 'Should never be allowed',
    utr_number: `${testUtr}RAWBAD`, // utr_number is VARCHAR(32) - stay within that, not just readable
  });
  check(
    'a raw DB insert pairing a non-Maintenance type with a house_id violates the CHECK constraint even with RLS bypassed',
    !!rawInsertError && /chk_house_id_required_for_maintenance_only/i.test(rawInsertError.message || ''),
    rawInsertError
  );

  const { error: rawInsertNoPayeeError } = await supabaseAdmin.from('transactions').insert({
    society_id: SOCIETY_ID,
    house_id: null,
    submitted_by: '00000001-0000-0000-0000-000000000001',
    amount: 500,
    transaction_type: 'Other',
    utr_number: `${testUtr}RAWNOPAY`, // utr_number is VARCHAR(32) - stay within that, not just readable
  });
  check(
    'a raw DB insert of a non-Maintenance type with no payee_name violates the CHECK constraint',
    !!rawInsertNoPayeeError && /chk_payee_name_required_for_expenses/i.test(rawInsertNoPayeeError.message || ''),
    rawInsertNoPayeeError
  );

  // --- Never shows up in the admin review queue - it's already Verified,
  // not Submitted, so there is nothing left for that queue to surface.
  const pending = await get('/transactions/pending', adminToken);
  const pendingUtility = (pending.body || []).find((t) => t.id === utilityBill.body.id);
  check(
    'the auto-Verified UtilityBill expense does NOT appear in GET /transactions/pending',
    pending.status === 200 && !pendingUtility,
    pending.body
  );

  // --- Re-verifying/rejecting an already-auto-Verified expense is
  // rejected exactly like any other already-Verified transaction (409) -
  // proves there is no separate review step to invoke, not just that
  // nothing invokes one today.
  const reVerify = await post(`/transactions/${utilityBill.body.id}/verify`, adminToken);
  check(
    're-verifying an already-Verified expense is rejected (409)',
    reVerify.status === 409,
    reVerify
  );

  const rejectAfterAutoVerify = await post(`/transactions/${salary.body.id}/reject`, adminToken, {
    reason: 'trying to reject an already-Verified expense',
  });
  check(
    'rejecting an already-Verified expense is rejected (409)',
    rejectAfterAutoVerify.status === 409,
    rejectAfterAutoVerify
  );

  // --- Recording each expense itself wrote the audit_events row (at
  // creation, not via a separate verify call) including payee_name.
  const { data: auditRows } = await supabaseAdmin
    .from('audit_events')
    .select('action, entity_id, metadata')
    .in('entity_id', [utilityBill.body.id, salary.body.id]);
  check(
    'recording both expenses wrote an audit_events row (action=Verified, auto_verified=true) including payee_name',
    (auditRows || []).some(
      (r) =>
        r.entity_id === utilityBill.body.id &&
        r.action === 'Verified' &&
        r.metadata?.payee_name === 'BEST Electricity' &&
        r.metadata?.auto_verified === true
    ) &&
      (auditRows || []).some(
        (r) =>
          r.entity_id === salary.body.id &&
          r.action === 'Verified' &&
          r.metadata?.payee_name === 'Ramesh - Security Guard' &&
          r.metadata?.auto_verified === true
      ),
    auditRows
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // Cleanup. The Salary row has no utr_number (its proof is
  // raw_shared_payload instead), so it needs an explicit id-based delete -
  // the utr_number-pattern delete below would never catch it.
  await supabaseAdmin.from('audit_events').delete().in('entity_id', [utilityBill.body.id, salary.body.id]);
  await supabaseAdmin.from('transactions').delete().like('utr_number', 'TESTEXPENSE%');
  if (salary.body.id) {
    await supabaseAdmin.from('transactions').delete().eq('id', salary.body.id);
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
