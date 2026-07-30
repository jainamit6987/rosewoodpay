// Verifies GET /society/:id/pendency-report?month=YYYY-MM&house_id=...
// (backend/src/routes/society.js): Admin/Committee "who still owes money"
// report - every still-Open billing period with period_month <= the target
// month, grouped by house, with a totalOutstanding sum and an overdueMonths
// count (periods strictly before the target month). Fully-paid houses (no
// qualifying Open period) are omitted entirely - that is the point of this
// report versus the flat billing-periods-by-month list.
// Requires the server running (npm run dev) and the seed fixtures from
// supabase/seed.sql to already exist in the connected project: 4 houses
// with just a current-month Open period each (A-101, R-24, D-404, B-102),
// plus the arrears house C-303 with a Closed period 4 months back and Open
// periods for the 3 months after that through the current month.
// Run with: node scripts/test-pendency-report.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const SOCIETY_ID = '00000003-0000-0000-0000-000000000003';
const HOUSE_A101_RESIDENT = '00000006-0000-0000-0000-000000000006';
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

function findHouse(houses, houseId) {
  return (houses || []).find((h) => h.house_id === houseId);
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
  const testTag = `TESTPENDENCY${Date.now()}`;
  const committeeEmail = `${testTag.toLowerCase()}committee@example.com`;
  const committeePassword = `Test${Date.now()}Pw!`;
  const createdAuthUserIds = [];

  // --- Setup: a throwaway house that is fully paid up (its only period is
  //     already Closed) - the exact case this report must NOT surface. ---
  const paidHouseTag = `TESTPENDPAID${Date.now()}`.slice(0, 20);
  const { data: paidHouse, error: paidHouseError } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: SOCIETY_ID, house_number: paidHouseTag, type: 'Flat', default_monthly_amount: 1800 })
    .select('id')
    .single();
  if (paidHouseError) {
    console.error('setup failed: could not create throwaway paid house', paidHouseError.message);
  }
  const currentMonthDate = new Date();
  const currentPeriodMonth = new Date(
    Date.UTC(currentMonthDate.getUTCFullYear(), currentMonthDate.getUTCMonth(), 1)
  )
    .toISOString()
    .slice(0, 10);
  const { error: paidPeriodError } = await supabaseAdmin.from('billing_periods').insert({
    society_id: SOCIETY_ID,
    house_id: paidHouse.id,
    period_month: currentPeriodMonth,
    base_amount: 1800,
    amount_due: 1800,
    status: 'Closed',
  });
  if (paidPeriodError) {
    console.error('setup failed: could not create throwaway paid house\'s Closed period', paidPeriodError.message);
  }

  // --- Unauthenticated is rejected ---
  check(
    'unauthenticated GET is rejected (401)',
    (await get(`/society/${SOCIETY_ID}/pendency-report`, null)).status === 401
  );

  // --- A plain resident cannot view the pendency report ---
  check(
    'a plain resident cannot view the pendency report (403)',
    (await get(`/society/${SOCIETY_ID}/pendency-report`, residentToken)).status === 403
  );

  // --- Invalid month formats are rejected ---
  check(
    'month=2026-13 (invalid month number) is rejected (400)',
    (await get(`/society/${SOCIETY_ID}/pendency-report?month=2026-13`, adminToken)).status === 400
  );
  check(
    'month=July2026 (wrong shape) is rejected (400)',
    (await get(`/society/${SOCIETY_ID}/pendency-report?month=July2026`, adminToken)).status === 400
  );

  // --- Default (current month, no filters): every seeded house with a
  //     still-Open period appears, the fully-paid throwaway house does not. ---
  const currentReport = await get(`/society/${SOCIETY_ID}/pendency-report`, adminToken);
  const c303Current = findHouse(currentReport.body.houses, HOUSE_C303_ARREARS);
  const a101Current = findHouse(currentReport.body.houses, HOUSE_A101_RESIDENT);
  check(
    'default report (current month) returns 200 with month echoed back',
    currentReport.status === 200 && currentReport.body.month === `${monthString(0)}-01`,
    currentReport.body
  );
  check(
    'the arrears house (C-303) shows 4 open periods, correct total and overdue count',
    !!c303Current &&
      c303Current.openPeriods.length === 4 &&
      Number(c303Current.totalOutstanding) === 8800 &&
      c303Current.overdueMonths === 3,
    c303Current
  );
  check(
    'a house current on just this month (A-101) shows 1 open period, no overdue months',
    !!a101Current &&
      a101Current.openPeriods.length === 1 &&
      Number(a101Current.totalOutstanding) === 2200 &&
      a101Current.overdueMonths === 0,
    a101Current
  );
  check(
    'a fully-paid house (only a Closed period) is excluded from the report entirely',
    !findHouse(currentReport.body.houses, paidHouse.id),
    currentReport.body.houses
  );
  const houseNumbers = (currentReport.body.houses || []).map((h) => h.house_number);
  const sortedHouseNumbers = [...houseNumbers].sort((a, b) => a.localeCompare(b));
  check(
    'houses are returned sorted by house_number',
    JSON.stringify(houseNumbers) === JSON.stringify(sortedHouseNumbers),
    houseNumbers
  );

  // --- house_id narrows the report to just that one house ---
  const c303Only = await get(`/society/${SOCIETY_ID}/pendency-report?house_id=${HOUSE_C303_ARREARS}`, adminToken);
  check(
    'house_id filter narrows the report to just that one house',
    c303Only.status === 200 && c303Only.body.houses.length === 1 && c303Only.body.houses[0].house_id === HOUSE_C303_ARREARS,
    c303Only.body
  );

  // --- house_id for the fully-paid throwaway house returns an empty list,
  //     not an error and not a house with zero periods ---
  const paidHouseOnly = await get(`/society/${SOCIETY_ID}/pendency-report?house_id=${paidHouse.id}`, adminToken);
  check(
    'house_id for a fully-paid house returns an empty houses array, not an error',
    paidHouseOnly.status === 200 && Array.isArray(paidHouseOnly.body.houses) && paidHouseOnly.body.houses.length === 0,
    paidHouseOnly.body
  );

  // --- A past target month: only the arrears house has any Open period
  //     that old, and overdueMonths/totalOutstanding narrow accordingly ---
  const twoMonthsAgo = monthString(2);
  const twoMonthsAgoReport = await get(`/society/${SOCIETY_ID}/pendency-report?month=${twoMonthsAgo}`, adminToken);
  const c303TwoMonthsAgo = findHouse(twoMonthsAgoReport.body.houses, HOUSE_C303_ARREARS);
  check(
    'a past target month (2 months ago) surfaces only the arrears house, with just its qualifying periods',
    twoMonthsAgoReport.status === 200 &&
      twoMonthsAgoReport.body.houses.length === 1 &&
      !!c303TwoMonthsAgo &&
      c303TwoMonthsAgo.openPeriods.length === 2 &&
      Number(c303TwoMonthsAgo.totalOutstanding) === 4400 &&
      c303TwoMonthsAgo.overdueMonths === 1,
    twoMonthsAgoReport.body
  );

  // --- A month far enough back that nothing qualifies anywhere returns an
  //     empty array, not an error ---
  const farPastMonth = monthString(24);
  const farPastReport = await get(`/society/${SOCIETY_ID}/pendency-report?month=${farPastMonth}`, adminToken);
  check(
    'a month with zero qualifying periods anywhere returns an empty array (not an error)',
    farPastReport.status === 200 && Array.isArray(farPastReport.body.houses) && farPastReport.body.houses.length === 0,
    farPastReport.body
  );

  // --- A Committee-only member (no is_admin) can view this report too,
  //     same Admin-or-Committee split as the billing-periods-by-month view ---
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
  if (committeeMember.body.auth_user_id) createdAuthUserIds.push(committeeMember.body.auth_user_id);

  const committeeToken = await loginToken(committeeEmail, committeePassword);
  const committeeView = await get(`/society/${SOCIETY_ID}/pendency-report`, committeeToken);
  check(
    'a Committee-only member CAN view the pendency report (200)',
    committeeView.status === 200 && Array.isArray(committeeView.body.houses),
    committeeView.body
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // Cleanup: deleting the throwaway house cascades to its billing_periods;
  // deleting the throwaway auth user cascades its society_members row.
  if (paidHouse?.id) {
    await supabaseAdmin.from('houses').delete().eq('id', paidHouse.id);
  }
  for (const authUserId of createdAuthUserIds) {
    await supabaseAdmin.auth.admin.deleteUser(authUserId);
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
