// Verifies GET /society/:id/billing-periods?month=YYYY-MM
// (backend/src/routes/society.js): Admin/Committee view of every billing
// period across every house in a society for one selected month. Requires
// the server running (npm run dev) and the seed fixtures from
// supabase/seed.sql to already exist in the connected project (5 seeded
// houses with a current-month period each; the arrears house C-303 also
// has a Closed period 4 months back).
// Run with: node scripts/test-billing-by-month.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const SOCIETY_ID = '00000003-0000-0000-0000-000000000003';
const HOUSE_C303_ARREARS = '0000000f-0000-0000-0000-00000000000f';

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

function monthString(monthsAgo) {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
  return date.toISOString().slice(0, 7);
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
  const adminToken = await loginToken('admin@society.app', 'password');
  const testTag = `TESTBILLBYMONTH${Date.now()}`;
  const committeeEmail = `${testTag.toLowerCase()}committee@example.com`;
  const committeePassword = `Test${Date.now()}Pw!`;
  const createdMemberIds = [];
  const createdAuthUserIds = [];

  // --- Unauthenticated is rejected ---
  check(
    'unauthenticated GET is rejected (401)',
    (await get(`/society/${SOCIETY_ID}/billing-periods`, null)).status === 401
  );

  // --- A plain resident cannot view the society-wide report ---
  check(
    'a plain resident cannot view the society-wide billing-by-month report (403)',
    (await get(`/society/${SOCIETY_ID}/billing-periods`, residentToken)).status === 403
  );

  // --- Invalid month formats are rejected ---
  check(
    'month=2026-13 (invalid month number) is rejected (400)',
    (await get(`/society/${SOCIETY_ID}/billing-periods?month=2026-13`, adminToken)).status === 400
  );
  check(
    'month=July2026 (wrong shape) is rejected (400)',
    (await get(`/society/${SOCIETY_ID}/billing-periods?month=July2026`, adminToken)).status === 400
  );
  check(
    'month=2026-7 (not zero-padded) is rejected (400)',
    (await get(`/society/${SOCIETY_ID}/billing-periods?month=2026-7`, adminToken)).status === 400
  );

  // --- No month param defaults to the current month: all 5 seeded houses
  //     have a period this month ---
  const currentMonthView = await get(`/society/${SOCIETY_ID}/billing-periods`, adminToken);
  check(
    'omitting month defaults to the current calendar month and returns all 5 seeded houses\' periods',
    currentMonthView.status === 200 &&
      currentMonthView.body.month === `${monthString(0)}-01` &&
      Array.isArray(currentMonthView.body.periods) &&
      currentMonthView.body.periods.length === 5 &&
      currentMonthView.body.periods.every((p) => !!p.houses?.house_number),
    currentMonthView.body
  );

  // --- An explicit month with exactly one matching period (the arrears
  //     house's already-Closed month, 4 months back) ---
  const fourMonthsAgo = monthString(4);
  const fourMonthsAgoView = await get(`/society/${SOCIETY_ID}/billing-periods?month=${fourMonthsAgo}`, adminToken);
  check(
    'an explicit past month with exactly one matching period (arrears house, Closed) returns just that one',
    fourMonthsAgoView.status === 200 &&
      Array.isArray(fourMonthsAgoView.body.periods) &&
      fourMonthsAgoView.body.periods.length === 1 &&
      fourMonthsAgoView.body.periods[0].house_id === HOUSE_C303_ARREARS &&
      fourMonthsAgoView.body.periods[0].status === 'Closed',
    fourMonthsAgoView.body
  );

  // --- A month nothing was ever seeded for returns an empty array, not an
  //     error ---
  const farPastMonth = monthString(24);
  const farPastView = await get(`/society/${SOCIETY_ID}/billing-periods?month=${farPastMonth}`, adminToken);
  check(
    'a month with zero matching periods anywhere returns an empty array (not an error)',
    farPastView.status === 200 && Array.isArray(farPastView.body.periods) && farPastView.body.periods.length === 0,
    farPastView.body
  );

  // --- A Committee-only member (no is_admin) can view this too, same
  //     "Committee can view, only Admin can act" split already established
  //     for GET /society - created via the existing POST /members route,
  //     same pattern as test-society.js's own throwaway Committee fixture. ---
  const committeeMember = await post('/members', adminToken, {
    society_id: SOCIETY_ID,
    email: committeeEmail,
    password: committeePassword,
    is_committee_member: true,
  });
  check(
    'setup: created a throwaway Committee-only member',
    committeeMember.status === 201 && committeeMember.body.is_committee_member === true,
    committeeMember.body
  );
  if (committeeMember.body.id) createdMemberIds.push(committeeMember.body.id);
  if (committeeMember.body.auth_user_id) createdAuthUserIds.push(committeeMember.body.auth_user_id);

  const committeeToken = await loginToken(committeeEmail, committeePassword);
  const committeeView = await get(`/society/${SOCIETY_ID}/billing-periods`, committeeToken);
  check(
    'a Committee-only member CAN view the society-wide billing-by-month report (200)',
    committeeView.status === 200 && Array.isArray(committeeView.body.periods),
    committeeView.body
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // Cleanup: delete the throwaway auth user (society_members row cascades).
  for (const authUserId of createdAuthUserIds) {
    await supabaseAdmin.auth.admin.deleteUser(authUserId);
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
