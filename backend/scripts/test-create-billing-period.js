// Verifies POST /houses/:houseId/billing-periods (backend/src/routes/houses.js):
// Admin-only direct creation of the next sequential billing period(s) for a
// house, ahead of any payment. Requires the server running (npm run dev)
// and the seed fixtures from supabase/seed.sql to already exist in the
// connected project (house R-24 - the only seeded house whose sole period
// is the current month, giving this test a clean, predictable "next month"
// to create without colliding with any other script's fixtures).
// Run with: node scripts/test-create-billing-period.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const HOUSE_R24 = '00000007-0000-0000-0000-000000000007';
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

async function post(path, token, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function monthsAheadOfNow(period_month, monthsAhead) {
  const now = new Date();
  const expected = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsAhead, 1));
  return new Date(period_month).toISOString().slice(0, 10) === expected.toISOString().slice(0, 10);
}

async function main() {
  const residentToken = await loginToken('resident@society.app', 'password');
  const adminToken = await loginToken('admin@society.app', 'password');

  // Baseline cleanup in case a previous failed run left rows behind - R-24
  // is expected to have exactly its one seeded current-month period before
  // this test starts.
  await supabaseAdmin
    .from('billing_periods')
    .delete()
    .eq('house_id', HOUSE_R24)
    .neq('period_month', new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10));

  // --- Unauthenticated is rejected ---
  check(
    'unauthenticated POST is rejected (401)',
    (await post(`/houses/${HOUSE_R24}/billing-periods`, null, {})).status === 401
  );

  // --- A plain resident cannot create one, even for their own house ---
  check(
    'a plain resident cannot create a billing period, even for their own house (403)',
    (await post(`/houses/${HOUSE_A101_RESIDENT}/billing-periods`, residentToken, {})).status === 403
  );

  // --- A nonexistent house id is a clean 404 ---
  check(
    'a nonexistent house id returns 404',
    (await post(`/houses/${FAKE_HOUSE_ID}/billing-periods`, adminToken, {})).status === 404
  );

  // --- Invalid months values are rejected ---
  check(
    'months=0 is rejected (400)',
    (await post(`/houses/${HOUSE_R24}/billing-periods`, adminToken, { months: 0 })).status === 400
  );
  check(
    'months=1.5 is rejected (400)',
    (await post(`/houses/${HOUSE_R24}/billing-periods`, adminToken, { months: 1.5 })).status === 400
  );
  check(
    'months=25 (over the cap) is rejected (400)',
    (await post(`/houses/${HOUSE_R24}/billing-periods`, adminToken, { months: 25 })).status === 400
  );

  // --- Admin creates exactly the next sequential month (R-24's only
  //     existing period is the current month) ---
  const createOne = await post(`/houses/${HOUSE_R24}/billing-periods`, adminToken, {});
  check(
    'Admin creates the next month\'s period (201), Open, using the house\'s default_monthly_amount',
    createOne.status === 201 &&
      Array.isArray(createOne.body) &&
      createOne.body.length === 1 &&
      createOne.body[0].status === 'Open' &&
      Number(createOne.body[0].amount_due) === 2500 &&
      monthsAheadOfNow(createOne.body[0].period_month, 1),
    createOne.body
  );

  // --- Calling again with months=3 creates the next 3 sequential months
  //     after that (months+2, +3, +4), not a duplicate of the one just made ---
  const createThree = await post(`/houses/${HOUSE_R24}/billing-periods`, adminToken, { months: 3 });
  check(
    'a second call with months=3 creates 3 more periods, continuing the sequence (no gap, no duplicate)',
    createThree.status === 201 &&
      Array.isArray(createThree.body) &&
      createThree.body.length === 3 &&
      monthsAheadOfNow(createThree.body[0].period_month, 2) &&
      monthsAheadOfNow(createThree.body[1].period_month, 3) &&
      monthsAheadOfNow(createThree.body[2].period_month, 4),
    createThree.body
  );

  // --- Genuinely racing two concurrent requests for the same next month is
  //     the only realistic way the unique-violation-catch branch is ever
  //     reached (a normal sequential call always resumes fresh from the
  //     house's own latest row and can never collide with itself, so a
  //     pre-inserted "decoy" row would just get treated as the new latest
  //     and skipped past rather than collided with). Fire both at once and
  //     assert the outcome stays consistent either way it resolves: no
  //     duplicate period_month, no 500, and every created row accounted for. ---
  const [raceA, raceB] = await Promise.all([
    post(`/houses/${HOUSE_R24}/billing-periods`, adminToken, { months: 1 }),
    post(`/houses/${HOUSE_R24}/billing-periods`, adminToken, { months: 1 }),
  ]);
  const raceStatusesOk = [raceA.status, raceB.status].every((s) => s === 201 || s === 409);
  const raceMonthsCreated = [
    ...(Array.isArray(raceA.body) ? raceA.body : []),
    ...(Array.isArray(raceB.body) ? raceB.body : []),
  ]
    .filter((p) => p && p.period_month)
    .map((p) => p.period_month);
  const noDuplicateMonths = new Set(raceMonthsCreated).size === raceMonthsCreated.length;
  check(
    'two concurrent requests for the same next month never both succeed with a duplicate, and neither 500s',
    raceStatusesOk && noDuplicateMonths,
    { raceA: raceA.body, raceB: raceB.body }
  );

  // --- Audit trail ---
  const { data: auditRows } = await supabaseAdmin
    .from('audit_events')
    .select('id')
    .eq('entity_type', 'billing_period')
    .eq('action', 'Created')
    .contains('metadata', { house_id: HOUSE_R24 });
  check('billing period creation wrote at least one audit_events row', (auditRows || []).length >= 2, auditRows);

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // Cleanup: remove every period this test created, leaving only the one
  // seed.sql itself describes for R-24 (the current month).
  await supabaseAdmin
    .from('billing_periods')
    .delete()
    .eq('house_id', HOUSE_R24)
    .neq('period_month', new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10));

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
