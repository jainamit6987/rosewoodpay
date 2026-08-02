// Verifies the new WaterCharge transaction_type added in
// 20260803000000_add_water_charge_transaction_type.sql:
//   - it is now a valid transaction_type, house-linked like Maintenance
//     (house_id required), but deliberately pay-as-you-go - no whole-
//     month-multiple rule, no billing_periods/FIFO allocation at all
//     (see routes/transactions.js's own comment on why).
//   - a resident can submit one via UPI for their own house, arbitrary
//     amount, and it sits Submitted -> Admin Verify/Reject, exactly like a
//     Maintenance UPI payment - but ends up with zero allocations and
//     never touches billing_periods either way.
//   - Cash is still Admin-only (same gate as every other Cash payment),
//     and auto-Verifies immediately with zero allocations/closedPeriods.
//   - GET /society/:id/transaction-report tags it Cr, with a synthesized
//     "House <no> - Water Charge (<description>)" line.
// Uses an isolated throwaway house (not any shared seeded fixture) so the
// "billing_periods stays completely untouched" assertions below can't be
// confused by some other test's own periods on a shared house. Requires
// the server running (npm run dev). Run with:
//   node scripts/test-water-charge.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const SOCIETY_ID = '00000003-0000-0000-0000-000000000003';
const RESIDENT_MEMBER_ID = '00000005-0000-0000-0000-000000000005';
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
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function get(path, token) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function currentMonthQueryParam() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function main() {
  const residentToken = await loginToken('resident@society.app', 'password');
  const adminToken = await loginToken('admin@society.app', 'password');
  const tag = `TESTWATER${Date.now()}`.slice(0, 20);

  const createdAuthUserIds = [];
  const createdMemberIds = [];
  const createdTransactionIds = [];

  // --- Setup: an isolated throwaway house, deliberately with NO
  //     default_monthly_amount configured on it at all - WaterCharge must
  //     work regardless (unlike Maintenance, it never reads that column). ---
  const { data: throwawayHouse, error: houseInsertError } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: SOCIETY_ID, house_number: tag, type: 'Flat', default_monthly_amount: null })
    .select('id, house_number')
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

  // --- transaction_type validation ---
  const invalidTypeAttempt = await post('/transactions', residentToken, {
    house_id: throwawayHouse.id,
    amount: 100,
    transaction_type: 'NotARealType',
    utr_number: `${tag}BADTYPE`,
  });
  check(
    'an unrecognized transaction_type is still rejected (400) - the check constraint sync is real, not just wide open',
    invalidTypeAttempt.status === 400 && /transaction_type must be one of/i.test(invalidTypeAttempt.body.error || ''),
    invalidTypeAttempt.body
  );

  const validTypeAttempt = await post('/transactions', residentToken, {
    house_id: throwawayHouse.id,
    amount: 100,
    transaction_type: 'WaterCharge',
    utr_number: `${tag}TYPECHECK`,
  });
  if (validTypeAttempt.body.id) createdTransactionIds.push(validTypeAttempt.body.id);
  check(
    'WaterCharge itself is now a recognized transaction_type (201, not the "must be one of" 400)',
    validTypeAttempt.status === 201,
    validTypeAttempt.body
  );

  check(
    'house_id is still required for WaterCharge, same as Maintenance (400)',
    (
      await post('/transactions', adminToken, {
        amount: 100,
        transaction_type: 'WaterCharge',
        payment_mode: 'Cash',
      })
    ).status === 400
  );

  // --- No whole-month-multiple rule at all: an arbitrary, non-round
  //     amount (never a multiple of any base rate) is accepted outright,
  //     and this house has no default_monthly_amount configured to begin
  //     with - Maintenance would reject this house outright (409), but
  //     WaterCharge never reads that column. ---
  const arbitraryAmount = 137.5;
  // A water charge is tied to the specific day the extra water was
  // used/paid, never a month or billing cycle - txn_date is a plain date,
  // deliberately not any period_month-shaped value, and the mobile client
  // now always sends one (defaulting to today, no picker yet - see
  // WaterChargeScreen.js/HouseDashboardScreen.js). Fixed to a specific past
  // date here, not "today", so this assertion can't coincidentally pass by
  // matching whatever verified_at/created_at would have fallen back to.
  const waterChargeTxnDate = '2026-07-15';
  const upiSubmission = await post('/transactions', residentToken, {
    house_id: throwawayHouse.id,
    amount: arbitraryAmount,
    transaction_type: 'WaterCharge',
    payment_mode: 'UPI',
    utr_number: `${tag}UPI`,
    txn_date: waterChargeTxnDate,
    description: 'Extra water tanker in July',
  });
  if (upiSubmission.body.id) createdTransactionIds.push(upiSubmission.body.id);
  check(
    'a resident submits an arbitrary (non-whole-month-multiple) amount via UPI for their own house (201)',
    upiSubmission.status === 201,
    upiSubmission.body
  );
  check(
    'the specific txn_date supplied is stored as-is (a plain date, not a month/billing-cycle value)',
    // txn_date comes back as a full timestamp (column is TIMESTAMPTZ, not
    // DATE) - only the date portion is ever meaningful/compared here.
    (upiSubmission.body.txn_date || '').slice(0, 10) === waterChargeTxnDate,
    upiSubmission.body
  );
  check(
    'it sits Submitted (not auto-Verified) - same review gate as a Maintenance UPI payment',
    upiSubmission.body.processing_status === 'Submitted',
    upiSubmission.body
  );
  check(
    'it has zero allocations - never touches billing_periods at all',
    Array.isArray(upiSubmission.body.allocations) && upiSubmission.body.allocations.length === 0,
    upiSubmission.body
  );
  check(
    'the stored transaction_type is WaterCharge and description is kept',
    upiSubmission.body.transaction_type === 'WaterCharge' && upiSubmission.body.description === 'Extra water tanker in July',
    upiSubmission.body
  );

  const { data: periodsAfterUpi } = await supabaseAdmin
    .from('billing_periods')
    .select('id')
    .eq('house_id', throwawayHouse.id);
  check(
    'no billing_periods row was created for this house as a side effect of the UPI submission',
    (periodsAfterUpi || []).length === 0,
    periodsAfterUpi
  );

  // --- Cash is still Admin-only for WaterCharge, same gate as everywhere
  //     else (not Committee, not the resident themselves) ---
  const residentCashAttempt = await post('/transactions', residentToken, {
    house_id: throwawayHouse.id,
    amount: 100,
    transaction_type: 'WaterCharge',
    payment_mode: 'Cash',
  });
  check(
    'a resident cannot record a Cash WaterCharge payment, even for their own house (403)',
    residentCashAttempt.status === 403 && /Admin/i.test(residentCashAttempt.body.error || ''),
    residentCashAttempt.body
  );

  const committeeCashAttempt = await post('/transactions', committeeToken, {
    house_id: throwawayHouse.id,
    amount: 100,
    transaction_type: 'WaterCharge',
    payment_mode: 'Cash',
  });
  check(
    'a Committee-only member cannot record a Cash WaterCharge payment either (403)',
    committeeCashAttempt.status === 403,
    committeeCashAttempt.body
  );

  // --- Admin records a Cash WaterCharge directly - auto-Verified, no
  //     description required (unlike an expense), no allocations either ---
  const cashAmount = 300;
  const cashPayment = await post('/transactions', adminToken, {
    house_id: throwawayHouse.id,
    amount: cashAmount,
    transaction_type: 'WaterCharge',
    payment_mode: 'Cash',
  });
  if (cashPayment.body.id) createdTransactionIds.push(cashPayment.body.id);
  check(
    'Admin records a Cash WaterCharge payment with no description at all (201)',
    cashPayment.status === 201,
    cashPayment.body
  );
  check(
    'the Cash WaterCharge payment is auto-Verified immediately',
    cashPayment.body.processing_status === 'Verified' && !!cashPayment.body.verified_at,
    cashPayment.body
  );
  check(
    'the Cash WaterCharge response reports zero closedPeriods (nothing to close, ever)',
    Array.isArray(cashPayment.body.closedPeriods) && cashPayment.body.closedPeriods.length === 0,
    cashPayment.body
  );

  const { data: periodsAfterCash } = await supabaseAdmin
    .from('billing_periods')
    .select('id')
    .eq('house_id', throwawayHouse.id);
  check(
    'still zero billing_periods rows for this house after both payments combined',
    (periodsAfterCash || []).length === 0,
    periodsAfterCash
  );

  // --- Admin verifies the earlier Submitted UPI payment - same /:id/verify
  //     as Maintenance, gracefully closing zero periods (empty allocations) ---
  const verifyResult = await post(`/transactions/${upiSubmission.body.id}/verify`, adminToken);
  check(
    'Admin can verify the Submitted UPI WaterCharge payment (200), closing zero periods',
    verifyResult.status === 200 &&
      verifyResult.body.processing_status === 'Verified' &&
      Array.isArray(verifyResult.body.closedPeriods) &&
      verifyResult.body.closedPeriods.length === 0,
    verifyResult.body
  );

  // --- GET /society/:id/transaction-report tags both as Cr, with a
  //     synthesized "House <no> - Water Charge (...)" description ---
  const report = await get(
    `/society/${SOCIETY_ID}/transaction-report?month=${currentMonthQueryParam()}`,
    adminToken
  );
  const reportRowUpi = (report.body.transactions || []).find((r) => r.id === upiSubmission.body.id);
  const reportRowCash = (report.body.transactions || []).find((r) => r.id === cashPayment.body.id);
  check(
    'the transaction report includes the verified UPI WaterCharge row, tagged Cr with its description',
    report.status === 200 &&
      !!reportRowUpi &&
      reportRowUpi.direction === 'Cr' &&
      reportRowUpi.description === `House ${throwawayHouse.house_number} - Water Charge (Extra water tanker in July)`,
    { report: report.body, reportRowUpi }
  );
  check(
    'the transaction report includes the Cash WaterCharge row, tagged Cr with a plain fallback description',
    !!reportRowCash && reportRowCash.direction === 'Cr' && reportRowCash.description === `House ${throwawayHouse.house_number} - Water Charge`,
    reportRowCash
  );
  check(
    'the report displays the UPI row\'s own supplied txn_date (a specific day), not verified_at - it fell in a different month entirely (July) yet still surfaces correctly here since filtering is by verified_at, display is by txn_date',
    (reportRowUpi?.txn_date || '').slice(0, 10) === waterChargeTxnDate,
    reportRowUpi
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // --- Cleanup ---
  for (const transactionId of createdTransactionIds) {
    await supabaseAdmin.from('audit_events').delete().eq('entity_id', transactionId);
    await supabaseAdmin.from('transactions').delete().eq('id', transactionId);
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
