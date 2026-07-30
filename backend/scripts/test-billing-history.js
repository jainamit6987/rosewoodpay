// Verifies GET /houses/:houseId/billing-periods (backend/src/routes/houses.js):
// returns every billing period for a house regardless of status (Open,
// Closed, Waived), newest month first, visible to the house's own
// resident(s) and to any Admin/Committee member of the same society - but
// not to an unrelated resident. Requires the server running (npm run dev)
// and the seed fixtures from supabase/seed.sql (arrears@society.app, house
// C-303 with 1 Closed + 4 Open periods) to already exist in the connected
// project.
// Run with: node scripts/test-billing-history.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const SOCIETY_ID = '00000003-0000-0000-0000-000000000003';
const RESIDENT_MEMBER_ID = '00000005-0000-0000-0000-000000000005';
const HOUSE_C303_ARREARS = '0000000f-0000-0000-0000-00000000000f';
const HOUSE_A101_RESIDENT = '00000006-0000-0000-0000-000000000006';
const FAKE_HOUSE_ID = '00000000-aaaa-bbbb-cccc-000000000000';

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

async function get(path, token) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function post(path, token, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  const residentToken = await loginToken('resident@society.app', 'password');
  const arrearsToken = await loginToken('arrears@society.app', 'password');
  const adminToken = await loginToken('admin@society.app', 'password');

  // --- Unauthenticated is rejected ---
  check(
    'unauthenticated GET is rejected (401)',
    (await get(`/houses/${HOUSE_C303_ARREARS}/billing-periods`, null)).status === 401
  );

  // --- A nonexistent house id is a clean 404, not a 500 ---
  const missing = await get(`/houses/${FAKE_HOUSE_ID}/billing-periods`, adminToken);
  check('a nonexistent house id returns 404', missing.status === 404, missing.body);

  // --- The arrears resident sees their own house's full history: 5 periods
  //     total (1 Closed + 4 Open), newest month first ---
  const ownHistory = await get(`/houses/${HOUSE_C303_ARREARS}/billing-periods`, arrearsToken);
  const statuses = (ownHistory.body || []).map((p) => p.status);
  const isNewestFirst =
    Array.isArray(ownHistory.body) &&
    ownHistory.body.every(
      (period, index) =>
        index === 0 || new Date(period.period_month) <= new Date(ownHistory.body[index - 1].period_month)
    );

  check(
    'arrears resident sees all 5 periods for their own house (1 Closed + 4 Open)',
    ownHistory.status === 200 &&
      Array.isArray(ownHistory.body) &&
      ownHistory.body.length === 5 &&
      statuses.filter((s) => s === 'Closed').length === 1 &&
      statuses.filter((s) => s === 'Open').length === 4,
    ownHistory.body
  );
  check('arrears resident\'s history is ordered newest-month-first', isNewestFirst, ownHistory.body);

  // --- An unrelated resident (assigned only to A-101) gets an empty list
  //     for C-303, not an error - matches the existing transactions
  //     endpoint's "RLS filters silently" behavior ---
  const unrelated = await get(`/houses/${HOUSE_C303_ARREARS}/billing-periods`, residentToken);
  check(
    'an unrelated resident gets an empty array for a house they are not assigned to (not an error)',
    unrelated.status === 200 && Array.isArray(unrelated.body) && unrelated.body.length === 0,
    unrelated.body
  );

  // --- That same resident sees their own single-period house fine ---
  const ownSingle = await get(`/houses/${HOUSE_A101_RESIDENT}/billing-periods`, residentToken);
  check(
    'resident sees their own house\'s (single-period) history',
    ownSingle.status === 200 && Array.isArray(ownSingle.body) && ownSingle.body.length === 1,
    ownSingle.body
  );

  // --- Admin sees full history for a house they do not personally live in ---
  const adminView = await get(`/houses/${HOUSE_C303_ARREARS}/billing-periods`, adminToken);
  check(
    'Admin sees the full 5-period history for any house in their society',
    adminView.status === 200 && Array.isArray(adminView.body) && adminView.body.length === 5,
    adminView.body
  );

  // --- hasPendingSubmission: an Open period with a Submitted (not yet
  //     Verified/Rejected) payment against it is flagged here too, same as
  //     GET /me - see routes/houses.js. Uses an isolated throwaway house
  //     (not the real seeded ones above) so this doesn't depend on, or
  //     disturb, any of their real fixture state. ---
  const throwawayTag = `TESTBILLHIST${Date.now()}`.slice(0, 20);
  const { data: throwawayHouse } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: SOCIETY_ID, house_number: throwawayTag, type: 'Flat', default_monthly_amount: 2200 })
    .select('id')
    .single();
  await supabaseAdmin.from('resident_house_assignments').insert({
    society_member_id: RESIDENT_MEMBER_ID,
    house_id: throwawayHouse.id,
    status: 'Active',
    approved_at: new Date().toISOString(),
  });
  const currentMonth = new Date();
  const periodMonth = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  await supabaseAdmin.from('billing_periods').insert({
    society_id: SOCIETY_ID,
    house_id: throwawayHouse.id,
    period_month: periodMonth,
    base_amount: 2200,
    amount_due: 2200,
    status: 'Open',
  });

  const beforePayment = await get(`/houses/${throwawayHouse.id}/billing-periods`, residentToken);
  check(
    'before any payment, hasPendingSubmission is false',
    beforePayment.status === 200 && beforePayment.body?.[0]?.hasPendingSubmission === false,
    beforePayment.body
  );

  const testUtr = `TESTBILLHIST${Date.now()}`;
  const payment = await post('/transactions', residentToken, {
    house_id: throwawayHouse.id,
    amount: 2200,
    utr_number: testUtr,
  });
  check('setup: payment against the throwaway period submitted (201)', payment.status === 201, payment.body);

  const afterSubmit = await get(`/houses/${throwawayHouse.id}/billing-periods`, residentToken);
  check(
    'once Submitted, hasPendingSubmission flips true (status itself stays "Open", not a new value)',
    afterSubmit.status === 200 &&
      afterSubmit.body?.[0]?.hasPendingSubmission === true &&
      afterSubmit.body?.[0]?.status === 'Open',
    afterSubmit.body
  );

  const reject = await post(`/transactions/${payment.body.id}/reject`, adminToken, {
    reason: 'test-billing-history cleanup',
  });
  check('setup: that payment is rejected (200)', reject.status === 200, reject.body);

  const afterReject = await get(`/houses/${throwawayHouse.id}/billing-periods`, residentToken);
  check(
    'once Rejected, hasPendingSubmission flips back to false',
    afterReject.status === 200 && afterReject.body?.[0]?.hasPendingSubmission === false,
    afterReject.body
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // Delete the transaction before the house - see test-me-pending-submission
  // .js for why the order matters (transaction_allocations.billing_period_id
  // is ON DELETE RESTRICT).
  await supabaseAdmin.from('transactions').delete().like('utr_number', 'TESTBILLHIST%');
  await supabaseAdmin.from('houses').delete().eq('id', throwawayHouse.id);

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
