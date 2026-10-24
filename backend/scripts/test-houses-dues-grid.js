// Verifies GET /society/:id/houses-dues-grid (backend/src/routes/society.js):
// the Houses screen's color-coded grid data source. Admin/Committee only.
// Unlike GET /society/:id/pendency-report (which deliberately OMITS a
// fully-paid house entirely - it's a "who still owes money" list), this
// endpoint returns EVERY house in the society, each stamped with
// overdueMonths, currentMonthDue, and a server-computed color bucket.
//
// Color rule under test (see duesBucket() in society.js) - simplified
// 2026-10-13, no more day-of-month grace period:
//   periodsDue = overdueMonths + (currentMonthDue ? 1 : 0)
//   periodsDue <= 1 -> green | === 2 -> yellow | >= 3 -> red.
//
// Also covers the two new fields added alongside that simplification:
//   currentMonthSettled - is the CURRENT month's own period Closed/Waived
//     (true) vs Open or never-billed at all (false) - feeds the Houses
//     screen's "Paid / Pending" legend count (currentMonthPaidCount/
//     currentMonthPendingCount in the top-level response).
//   paidThisMonth - the per-tile tick mark - a Verified Maintenance
//     transaction landed in this calendar month (by verified_at), which
//     is deliberately a DIFFERENT question from currentMonthSettled (a
//     house that pre-paid months in advance has currentMonthSettled=true
//     with paidThisMonth=false this month, since no transaction actually
//     happened now - confirmed directly with the user).
//
// Requires the server running (npm run dev) and the seed fixtures from
// supabase/seed.sql to already exist in the connected project: A-101 (just
// a current-month Open period) and C-303 (arrears: a Closed period 4
// months back, Open periods for the 3 months after that through the
// current month - i.e. overdueMonths=3, currentMonthDue=true).
// Run with: node scripts/test-houses-dues-grid.js
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

// Mirrors society.js's own (simplified, no-grace-period) duesBucket().
function expectedBucket(overdueMonths, currentMonthDue) {
  const periodsDue = overdueMonths + (currentMonthDue ? 1 : 0);
  if (periodsDue <= 1) return 'green';
  if (periodsDue === 2) return 'yellow';
  return 'red';
}

// Mirrors society.js's own compareHouseNumbers (2026-10-24: plain
// localeCompare used to be correct-enough for this check, but that's
// exactly the naive-text-sort bug this endpoint itself was just fixed
// for - "1" < "10" < "100" < "101" < "11" < "2", and G/F/S/T floors
// sorting alphabetically rather than Ground/First/Second/Terrace order).
const FLOOR_PREFIX_RANK = { '': 0, G: 1, F: 2, S: 3, T: 4 };
function parseHouseNumber(houseNumber) {
  const match = /^([A-Za-z]*)(\d+)$/.exec(String(houseNumber || '').trim());
  if (!match) return { floorRank: Number.MAX_SAFE_INTEGER, number: Number.MAX_SAFE_INTEGER };
  const [, prefix, digits] = match;
  const floorRank = FLOOR_PREFIX_RANK[prefix.toUpperCase()];
  return { floorRank: floorRank === undefined ? Number.MAX_SAFE_INTEGER - 1 : floorRank, number: Number(digits) };
}
function expectedCompareHouseNumbers(a, b) {
  const pa = parseHouseNumber(a);
  const pb = parseHouseNumber(b);
  if (pa.floorRank !== pb.floorRank) return pa.floorRank - pb.floorRank;
  return pa.number - pb.number;
}

function findHouse(houses, houseId) {
  return (houses || []).find((h) => h.id === houseId);
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
  const testTag = `TESTGRID${Date.now()}`;
  const committeeEmail = `${testTag.toLowerCase()}committee@example.com`;
  const committeePassword = `Test${Date.now()}Pw!`;
  const createdAuthUserIds = [];

  const now = new Date();
  const currentPeriodMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);

  // --- Setup: a fully-paid throwaway house (only a Closed period) - the
  //     exact case the pendency-report omits but this endpoint must NOT. ---
  const paidHouseTag = `TESTGRIDPAID${Date.now()}`.slice(0, 20);
  const { data: paidHouse, error: paidHouseError } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: SOCIETY_ID, house_number: paidHouseTag, type: 'Flat', default_monthly_amount: 1800 })
    .select('id')
    .single();
  if (paidHouseError) {
    console.error('setup failed: could not create the fully-paid throwaway house', paidHouseError.message);
  }
  const { error: paidPeriodError } = await supabaseAdmin.from('billing_periods').insert({
    society_id: SOCIETY_ID,
    house_id: paidHouse.id,
    period_month: currentPeriodMonth,
    base_amount: 1800,
    amount_due: 1800,
    status: 'Closed',
  });
  if (paidPeriodError) {
    console.error('setup failed: could not close the fully-paid throwaway house\'s period', paidPeriodError.message);
  }

  // --- Setup: a throwaway house with NO billing period at all, ever - the
  //     "never been billed yet" case, which must default to overdueMonths=0,
  //     currentMonthDue=false, not be omitted or error out - and, per the
  //     user's explicit 2-bucket decision (2026-10-13), must count as
  //     Pending for the legend, not Paid, since there is nothing to call
  //     "settled" here. ---
  const neverBilledTag = `TESTGRIDNB${Date.now()}`.slice(0, 20);
  const { data: neverBilledHouse, error: neverBilledError } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: SOCIETY_ID, house_number: neverBilledTag, type: 'Flat', default_monthly_amount: 1500 })
    .select('id')
    .single();
  if (neverBilledError) {
    console.error('setup failed: could not create the never-billed throwaway house', neverBilledError.message);
  }

  // --- Setup: a throwaway house with a Verified Maintenance transaction
  //     landing THIS calendar month - the paidThisMonth tick under test.
  //     Deliberately has no billing_period at all behind it (the tick is
  //     transaction-based, not period-based - it must not require one). ---
  const paidThisMonthTag = `TESTGRIDTXN${Date.now()}`.slice(0, 20);
  const { data: paidThisMonthHouse, error: paidThisMonthHouseError } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: SOCIETY_ID, house_number: paidThisMonthTag, type: 'Flat', default_monthly_amount: 2000 })
    .select('id')
    .single();
  if (paidThisMonthHouseError) {
    console.error(
      'setup failed: could not create the paid-this-month throwaway house',
      paidThisMonthHouseError.message
    );
  }
  const paidThisMonthUtr = `TESTGRIDPAIDTXN${Date.now()}`;
  const { error: paidThisMonthTxnError } = await supabaseAdmin.from('transactions').insert({
    society_id: SOCIETY_ID,
    house_id: paidThisMonthHouse.id,
    submitted_by: '00000001-0000-0000-0000-000000000001',
    amount: 2000,
    utr_number: paidThisMonthUtr,
    payment_status: 'Success',
    processing_status: 'Verified',
    transaction_type: 'Maintenance',
    direction: 'Cr',
    payment_mode: 'UPI',
    verified_by: '00000001-0000-0000-0000-000000000001',
    verified_at: now.toISOString(),
  });
  if (paidThisMonthTxnError) {
    console.error(
      "setup failed: could not create the paid-this-month throwaway house's Verified transaction",
      paidThisMonthTxnError.message
    );
  }

  // --- Unauthenticated is rejected ---
  check(
    'unauthenticated GET is rejected (401)',
    (await get(`/society/${SOCIETY_ID}/houses-dues-grid`, null)).status === 401
  );

  // --- A plain resident cannot view the grid ---
  check(
    'a plain resident cannot view the houses dues grid (403)',
    (await get(`/society/${SOCIETY_ID}/houses-dues-grid`, residentToken)).status === 403
  );

  // --- The real grid response ---
  const gridResponse = await get(`/society/${SOCIETY_ID}/houses-dues-grid`, adminToken);
  check(
    'Admin GET returns 200 with an asOfDate/currentMonth matching today and a houses array',
    gridResponse.status === 200 &&
      gridResponse.body.asOfDate === now.toISOString().slice(0, 10) &&
      gridResponse.body.currentMonth === currentPeriodMonth &&
      Array.isArray(gridResponse.body.houses),
    gridResponse.body
  );

  const houses = gridResponse.body.houses || [];

  check(
    'currentMonthPaidCount + currentMonthPendingCount account for every house exactly once',
    typeof gridResponse.body.currentMonthPaidCount === 'number' &&
      typeof gridResponse.body.currentMonthPendingCount === 'number' &&
      gridResponse.body.currentMonthPaidCount + gridResponse.body.currentMonthPendingCount === houses.length,
    {
      currentMonthPaidCount: gridResponse.body.currentMonthPaidCount,
      currentMonthPendingCount: gridResponse.body.currentMonthPendingCount,
      housesLength: houses.length,
    }
  );

  // A-101/C-303's exact overdueMonths drift over real calendar time (both
  // are long-lived shared seed fixtures - see test-pendency-report.js's
  // own note on this) - rather than hardcoding a count tied to whenever
  // the seed was first created, cross-check against the pendency-report
  // endpoint's own independently-computed overdueMonths for the SAME
  // house, live, right now. That endpoint already defines overdueMonths
  // identically ("Open periods strictly before the current month") - this
  // asserts our two endpoints agree on the live DB state, which stays
  // correct no matter how much further the fixture drifts.
  async function liveExpectation(houseId) {
    const report = await get(`/society/${SOCIETY_ID}/pendency-report?house_id=${houseId}`, adminToken);
    const entry = (report.body.houses || [])[0];
    const overdueMonths = entry ? entry.overdueMonths : 0;
    const currentMonthDue = !!entry && entry.openPeriods.some((p) => p.period_month === currentPeriodMonth);
    return { overdueMonths, currentMonthDue };
  }

  const a101 = findHouse(houses, HOUSE_A101_RESIDENT);
  const a101Expected = await liveExpectation(HOUSE_A101_RESIDENT);
  check(
    "A-101 matches the pendency-report's own live overdueMonths/currentMonthDue, and bucket matches the simplified rule",
    !!a101 &&
      a101.overdueMonths === a101Expected.overdueMonths &&
      a101.currentMonthDue === a101Expected.currentMonthDue &&
      a101.bucket === expectedBucket(a101Expected.overdueMonths, a101Expected.currentMonthDue),
    { a101, a101Expected }
  );

  const c303 = findHouse(houses, HOUSE_C303_ARREARS);
  const c303Expected = await liveExpectation(HOUSE_C303_ARREARS);
  check(
    "C-303 (arrears fixture) matches the pendency-report's own live overdueMonths/currentMonthDue, bucket=red (3+ periods due)",
    !!c303 &&
      c303.overdueMonths === c303Expected.overdueMonths &&
      c303.currentMonthDue === c303Expected.currentMonthDue &&
      c303.bucket === 'red' &&
      c303Expected.overdueMonths + (c303Expected.currentMonthDue ? 1 : 0) >= 3,
    { c303, c303Expected }
  );

  const paidEntry = findHouse(houses, paidHouse.id);
  check(
    'a fully-paid house (unlike the pendency-report) IS included here, with overdueMonths=0, currentMonthDue=false, bucket=green, ' +
      'currentMonthSettled=true (its current-month period is Closed) but paidThisMonth=false (no transaction actually happened now)',
    !!paidEntry &&
      paidEntry.overdueMonths === 0 &&
      paidEntry.currentMonthDue === false &&
      paidEntry.bucket === 'green' &&
      paidEntry.currentMonthSettled === true &&
      paidEntry.paidThisMonth === false,
    paidEntry
  );

  const neverBilledEntry = findHouse(houses, neverBilledHouse.id);
  check(
    'a never-billed house (zero billing periods ever) still appears, defaulted to overdueMonths=0/currentMonthDue=false/bucket=green, ' +
      'but currentMonthSettled=false (counts as Pending, not Paid, per the 2-bucket decision) and paidThisMonth=false',
    !!neverBilledEntry &&
      neverBilledEntry.overdueMonths === 0 &&
      neverBilledEntry.currentMonthDue === false &&
      neverBilledEntry.bucket === 'green' &&
      neverBilledEntry.currentMonthSettled === false &&
      neverBilledEntry.paidThisMonth === false,
    neverBilledEntry
  );

  const paidThisMonthEntry = findHouse(houses, paidThisMonthHouse.id);
  check(
    'a house with a Verified Maintenance transaction this calendar month gets paidThisMonth=true, ' +
      'even with no billing_period behind it at all (currentMonthSettled stays false)',
    !!paidThisMonthEntry && paidThisMonthEntry.paidThisMonth === true && paidThisMonthEntry.currentMonthSettled === false,
    paidThisMonthEntry
  );

  check(
    'every house carries its owner_number and status fields through unchanged',
    !!a101 && 'house_number' in a101 && 'owner_name' in a101 && 'status' in a101,
    a101
  );

  const houseNumbers = houses.map((h) => h.house_number);
  const sortedHouseNumbers = [...houseNumbers].sort(expectedCompareHouseNumbers);
  check(
    'houses are returned in natural numeric/floor order (1,2,...,10,...; G<F<S<T), not plain alphabetic',
    JSON.stringify(houseNumbers) === JSON.stringify(sortedHouseNumbers),
    houseNumbers
  );

  // --- A Committee-only member (no is_admin) can view this too, same
  //     Admin-or-Committee split as every other report in this file. ---
  const committeeMember = await post('/members', adminToken, {
    society_id: SOCIETY_ID,
    email: committeeEmail,
    name: 'Test Committee Member',
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
  const committeeView = await get(`/society/${SOCIETY_ID}/houses-dues-grid`, committeeToken);
  check(
    'a Committee-only member CAN view the houses dues grid (200)',
    committeeView.status === 200 && Array.isArray(committeeView.body.houses),
    committeeView.body
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // Cleanup: transactions before the house they belong to (ON DELETE
  // RESTRICT if ever allocated - see test-billing-history.js's own note),
  // then deleting each throwaway house cascades to its billing_periods.
  await supabaseAdmin.from('transactions').delete().eq('utr_number', paidThisMonthUtr);
  if (paidHouse?.id) {
    await supabaseAdmin.from('houses').delete().eq('id', paidHouse.id);
  }
  if (neverBilledHouse?.id) {
    await supabaseAdmin.from('houses').delete().eq('id', neverBilledHouse.id);
  }
  if (paidThisMonthHouse?.id) {
    await supabaseAdmin.from('houses').delete().eq('id', paidThisMonthHouse.id);
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
