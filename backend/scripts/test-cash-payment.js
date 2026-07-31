// Verifies the payment_mode column added in
// 20260731000000_add_payment_mode_to_transactions.sql and the matching
// app-layer rules in routes/transactions.js's POST / handler:
//   - payment_mode defaults to 'UPI' and must be one of UPI/Cash.
//   - 'Cash' is Admin-only (not Committee, not the resident themselves,
//     even for their own house) and only valid for Maintenance payments.
//   - 'Cash' needs no utr_number/raw_shared_payload/proof_file_path.
//   - 'Cash' is auto-Verified immediately (processing_status/payment_
//     status/verified_by/verified_at all set at insert time, no separate
//     /verify call needed) and closes any billing period it fully covers,
//     same as a normal /verify would.
// Uses an isolated throwaway house (not any shared seeded fixture) so this
// never risks mutating billing_periods other tests depend on being in a
// particular state. Requires the server to be running (npm start). Run
// with: node scripts/test-cash-payment.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const SOCIETY_ID = '00000003-0000-0000-0000-000000000003';
const RESIDENT_MEMBER_ID = '00000005-0000-0000-0000-000000000005';
const HOUSE_A101 = '00000006-0000-0000-0000-000000000006';
const BASE_AMOUNT = 2200;

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
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  const residentToken = await loginToken('resident@society.app', 'password');
  const adminToken = await loginToken('admin@society.app', 'password');
  const tag = `TESTCASH${Date.now()}`.slice(0, 20);

  const createdAuthUserIds = [];
  const createdMemberIds = [];

  // --- Setup: an isolated throwaway house with one Active resident, so
  // this test never touches a shared seeded house's billing_periods. ---
  const { data: throwawayHouse, error: houseInsertError } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: SOCIETY_ID, house_number: tag, type: 'Flat', default_monthly_amount: BASE_AMOUNT })
    .select('id')
    .single();
  if (houseInsertError) {
    console.error('setup failed: could not create throwaway house', houseInsertError.message);
    process.exit(1);
  }
  await supabaseAdmin.from('resident_house_assignments').insert({
    society_member_id: RESIDENT_MEMBER_ID,
    house_id: throwawayHouse.id,
    status: 'Active',
    approved_at: new Date().toISOString(),
  });

  // --- A throwaway Committee-only member, to prove Cash is stricter than
  // "Admin or Committee" - it is Admin-only, same level as /:id/verify. ---
  const committeeEmail = `${tag.toLowerCase()}committee@example.com`;
  const committeeMember = await post('/members', adminToken, {
    society_id: SOCIETY_ID,
    email: committeeEmail,
    name: 'Test Committee Member',
    password: 'TestPass123!',
    is_committee_member: true,
  });
  if (committeeMember.body.id) createdMemberIds.push(committeeMember.body.id);
  if (committeeMember.body.auth_user_id) createdAuthUserIds.push(committeeMember.body.auth_user_id);
  const committeeToken = await loginToken(committeeEmail, 'TestPass123!');

  const unauth = await post('/transactions', null, {
    house_id: throwawayHouse.id,
    amount: BASE_AMOUNT,
    payment_mode: 'Cash',
  });
  check('unauthenticated Cash submission is rejected (401)', unauth.status === 401, unauth);

  const residentAttempt = await post('/transactions', residentToken, {
    house_id: throwawayHouse.id,
    amount: BASE_AMOUNT,
    payment_mode: 'Cash',
  });
  // The resident is not even assigned to this throwaway house, but the
  // point being tested is Cash's own Admin-only gate specifically - it
  // must reject before ever reaching the assignment check.
  check(
    'a resident cannot submit a Cash payment, even nominally on their own behalf (403)',
    residentAttempt.status === 403 && /Admin/i.test(residentAttempt.body.error || ''),
    residentAttempt
  );

  const committeeAttempt = await post('/transactions', committeeToken, {
    house_id: throwawayHouse.id,
    amount: BASE_AMOUNT,
    payment_mode: 'Cash',
  });
  check(
    'a Committee-only member cannot submit a Cash payment - Cash is Admin-only, not Admin-or-Committee (403)',
    committeeAttempt.status === 403,
    committeeAttempt
  );

  const badMode = await post('/transactions', adminToken, {
    house_id: throwawayHouse.id,
    amount: BASE_AMOUNT,
    payment_mode: 'Card',
  });
  check('an unrecognized payment_mode is rejected (400)', badMode.status === 400, badMode);

  const cashWithWrongType = await post('/transactions', adminToken, {
    society_id: SOCIETY_ID,
    amount: 999,
    payment_mode: 'Cash',
    transaction_type: 'UtilityBill',
    payee_name: 'Test Vendor',
  });
  check(
    'Cash combined with a non-Maintenance transaction_type is rejected (400)',
    cashWithWrongType.status === 400 && /only valid for Maintenance/i.test(cashWithWrongType.body.error || ''),
    cashWithWrongType
  );

  // --- The actual happy path: Admin records a Cash payment for this
  // resident's dues, with no utr_number/proof/payload at all. ---
  const cashPayment = await post('/transactions', adminToken, {
    house_id: throwawayHouse.id,
    amount: BASE_AMOUNT,
    payment_mode: 'Cash',
  });
  check(
    'Admin recording a Cash payment with no UTR/proof/payload succeeds (201)',
    cashPayment.status === 201,
    cashPayment
  );
  check(
    'the Cash payment is auto-Verified immediately, not left Submitted',
    cashPayment.body.processing_status === 'Verified' &&
      cashPayment.body.payment_status === 'Success' &&
      !!cashPayment.body.verified_by &&
      !!cashPayment.body.verified_at,
    cashPayment.body
  );
  check('the stored payment_mode is Cash', cashPayment.body.payment_mode === 'Cash', cashPayment.body);
  check(
    'the response reports the fully-paid period as closed (same shape as /:id/verify)',
    Array.isArray(cashPayment.body.closedPeriods) && cashPayment.body.closedPeriods.length === 1,
    cashPayment.body
  );

  const { data: closedPeriod } = await supabaseAdmin
    .from('billing_periods')
    .select('status')
    .eq('house_id', throwawayHouse.id)
    .single();
  check(
    'the billing period itself is now Closed in the database, with no separate /verify call ever made',
    closedPeriod?.status === 'Closed',
    closedPeriod
  );

  const { data: auditRows } = await supabaseAdmin
    .from('audit_events')
    .select('id, metadata')
    .eq('entity_type', 'transaction')
    .eq('entity_id', cashPayment.body.id)
    .eq('action', 'Verified');
  check(
    'the Cash payment wrote its own audit_events row (auto_verified, payment_mode recorded)',
    (auditRows || []).length === 1 &&
      auditRows[0].metadata?.auto_verified === true &&
      auditRows[0].metadata?.payment_mode === 'Cash',
    auditRows
  );

  // --- Regression: an ordinary resident UPI submission (existing flow,
  // untouched house/amount) still defaults payment_mode to 'UPI'. ---
  const upiRegression = await post('/transactions', residentToken, {
    house_id: HOUSE_A101,
    amount: BASE_AMOUNT,
    utr_number: `${tag}UPI`,
  });
  check(
    'omitting payment_mode on an ordinary UPI submission still defaults to UPI (no regression)',
    upiRegression.status === 201 && upiRegression.body.payment_mode === 'UPI',
    upiRegression.body
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // --- Cleanup ---
  if (upiRegression.body.id) {
    await supabaseAdmin.from('transactions').delete().eq('id', upiRegression.body.id);
  }
  // audit_events has no FK to transactions, so the Cash payment's own audit
  // row needs an explicit delete. The transaction row itself must also be
  // deleted explicitly, and *before* the house: transaction_allocations.
  // billing_period_id is ON DELETE RESTRICT (by design - see
  // 20260725020000_add_transaction_allocations_and_default_rate.sql), so a
  // straight `DELETE FROM houses` cascading into billing_periods while an
  // allocation still points at one of its periods fails outright. Deleting
  // the transaction first cascades its allocation away (that FK IS
  // CASCADE), leaving the house's cascade to billing_periods/
  // resident_house_assignments clean.
  if (cashPayment.body.id) {
    await supabaseAdmin.from('audit_events').delete().eq('entity_id', cashPayment.body.id);
    await supabaseAdmin.from('transactions').delete().eq('id', cashPayment.body.id);
  }
  await supabaseAdmin.from('houses').delete().eq('id', throwawayHouse.id);
  if (createdMemberIds.length > 0) {
    await supabaseAdmin.from('audit_events').delete().in('entity_id', createdMemberIds);
    await supabaseAdmin.from('society_members').delete().in('id', createdMemberIds);
  }
  for (const authUserId of createdAuthUserIds) {
    await supabaseAdmin.auth.admin.deleteUser(authUserId).catch(() => {});
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
