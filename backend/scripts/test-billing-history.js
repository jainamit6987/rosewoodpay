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

const BASE_URL = `http://localhost:${env.port}`;
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

  console.log(`\n${passCount} passed, ${failCount} failed.`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
