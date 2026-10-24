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
// Also covers the fields added alongside that simplification, plus the
// 2026-10-24 4-way paymentStatus built from them:
//   currentMonthSettled - is the CURRENT month's own period Closed/Waived
//     (true) vs Open or never-billed at all (false).
//   paidThisMonth - the per-tile tick mark - a Verified Maintenance
//     transaction landed in this calendar month (by verified_at), which
//     is deliberately a DIFFERENT question from currentMonthSettled (a
//     house that pre-paid months in advance has currentMonthSettled=true
//     with paidThisMonth=false this month, since no transaction actually
//     happened now - confirmed directly with the user).
//   paymentStatus - one of paidCurrent/paidOld/paidAdvance/unpaid, the
//     2x2 of the above two booleans (see society.js's own comment on
//     the route for the exact mapping) - feeds the Houses screen's
//     tick/star/hollow-tick indicator and 4-category summary table
//     (paidCurrentCount/paidOldCount/paidAdvanceCount/unpaidCount in the
//     top-level response, replacing the old currentMonthPaidCount/
//     currentMonthPendingCount pair).
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

  // --- Setup: a throwaway house with BOTH a Closed current-month period
  //     AND a Verified Maintenance transaction landing this calendar
  //     month - the "clean" case (currentMonthSettled=true AND
  //     paidThisMonth=true), the 4th corner of the 2x2 that the two
  //     fixtures above don't individually cover - paymentStatus=paidCurrent. ---
  const paidCurrentTag = `TESTGRIDCUR${Date.now()}`.slice(0, 20);
  const { data: paidCurrentHouse, error: paidCurrentHouseError } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: SOCIETY_ID, house_number: paidCurrentTag, type: 'Flat', default_monthly_amount: 2200 })
    .select('id')
    .single();
  if (paidCurrentHouseError) {
    console.error('setup failed: could not create the paid-current throwaway house', paidCurrentHouseError.message);
  }
  const { error: paidCurrentPeriodError } = await supabaseAdmin.from('billing_periods').insert({
    society_id: SOCIETY_ID,
    house_id: paidCurrentHouse.id,
    period_month: currentPeriodMonth,
    base_amount: 2200,
    amount_due: 2200,
    status: 'Closed',
  });
  if (paidCurrentPeriodError) {
    console.error("setup failed: could not close the paid-current throwaway house's period", paidCurrentPeriodError.message);
  }
  const paidCurrentUtr = `TESTGRIDCURTXN${Date.now()}`;
  const { error: paidCurrentTxnError } = await supabaseAdmin.from('transactions').insert({
    society_id: SOCIETY_ID,
    house_id: paidCurrentHouse.id,
    submitted_by: '00000001-0000-0000-0000-000000000001',
    amount: 2200,
    utr_number: paidCurrentUtr,
    payment_status: 'Success',
    processing_status: 'Verified',
    transaction_type: 'Maintenance',
    direction: 'Cr',
    payment_mode: 'UPI',
    verified_by: '00000001-0000-0000-0000-000000000001',
    verified_at: now.toISOString(),
  });
  if (paidCurrentTxnError) {
    console.error(
      "setup failed: could not create the paid-current throwaway house's Verified transaction",
      paidCurrentTxnError.message
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
    'paidCurrentCount + paidOldCount + paidAdvanceCount + unpaidCount account for every house exactly once',
    typeof gridResponse.body.paidCurrentCount === 'number' &&
      typeof gridResponse.body.paidOldCount === 'number' &&
      typeof gridResponse.body.paidAdvanceCount === 'number' &&
      typeof gridResponse.body.unpaidCount === 'number' &&
      gridResponse.body.paidCurrentCount +
        gridResponse.body.paidOldCount +
        gridResponse.body.paidAdvanceCount +
        gridResponse.body.unpaidCount ===
        houses.length,
    {
      paidCurrentCount: gridResponse.body.paidCurrentCount,
      paidOldCount: gridResponse.body.paidOldCount,
      paidAdvanceCount: gridResponse.body.paidAdvanceCount,
      unpaidCount: gridResponse.body.unpaidCount,
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
      'currentMonthSettled=true but paidThisMonth=false (no transaction actually happened now) -> paymentStatus=paidAdvance',
    !!paidEntry &&
      paidEntry.overdueMonths === 0 &&
      paidEntry.currentMonthDue === false &&
      paidEntry.bucket === 'green' &&
      paidEntry.currentMonthSettled === true &&
      paidEntry.paidThisMonth === false &&
      paidEntry.paymentStatus === 'paidAdvance',
    paidEntry
  );

  const neverBilledEntry = findHouse(houses, neverBilledHouse.id);
  check(
    'a never-billed house (zero billing periods ever) still appears, defaulted to overdueMonths=0/currentMonthDue=false/bucket=green, ' +
      'currentMonthSettled=false and paidThisMonth=false -> paymentStatus=unpaid',
    !!neverBilledEntry &&
      neverBilledEntry.overdueMonths === 0 &&
      neverBilledEntry.currentMonthDue === false &&
      neverBilledEntry.bucket === 'green' &&
      neverBilledEntry.currentMonthSettled === false &&
      neverBilledEntry.paidThisMonth === false &&
      neverBilledEntry.paymentStatus === 'unpaid',
    neverBilledEntry
  );

  const paidThisMonthEntry = findHouse(houses, paidThisMonthHouse.id);
  check(
    'a house with a Verified Maintenance transaction this calendar month gets paidThisMonth=true, ' +
      'even with no billing_period behind it at all (currentMonthSettled stays false) -> paymentStatus=paidOld',
    !!paidThisMonthEntry &&
      paidThisMonthEntry.paidThisMonth === true &&
      paidThisMonthEntry.currentMonthSettled === false &&
      paidThisMonthEntry.paymentStatus === 'paidOld',
    paidThisMonthEntry
  );

  const paidCurrentEntry = findHouse(houses, paidCurrentHouse.id);
  check(
    'a house with BOTH a Closed current-month period AND a Verified transaction this calendar month ' +
      'gets currentMonthSettled=true and paidThisMonth=true -> paymentStatus=paidCurrent (the "clean" case)',
    !!paidCurrentEntry &&
      paidCurrentEntry.currentMonthSettled === true &&
      paidCurrentEntry.paidThisMonth === true &&
      paidCurrentEntry.paymentStatus === 'paidCurrent',
    paidCurrentEntry
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
  await supabaseAdmin.from('transactions').delete().eq('utr_number', paidCurrentUtr);
  if (paidHouse?.id) {
    await supabaseAdmin.from('houses').delete().eq('id', paidHouse.id);
  }
  if (neverBilledHouse?.id) {
    await supabaseAdmin.from('houses').delete().eq('id', neverBilledHouse.id);
  }
  if (paidThisMonthHouse?.id) {
    await supabaseAdmin.from('houses').delete().eq('id', paidThisMonthHouse.id);
  }
  if (paidCurrentHouse?.id) {
    await supabaseAdmin.from('houses').delete().eq('id', paidCurrentHouse.id);
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
