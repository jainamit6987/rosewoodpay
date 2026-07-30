// Verifies GET /transactions/report (backend/src/routes/transactions.js):
// Admin/Committee full, all-status, society-wide transaction report with
// optional status/house_id/transaction_type/from/to filters. Requires the
// server running (npm run dev) and the seed fixtures from
// supabase/seed.sql (SEEDTENANTR24PAYMENT, a Submitted Maintenance
// transaction on R-24; SEEDUTILITYBILL1, an already-Verified UtilityBill
// expense with no house_id).
// Run with: node scripts/test-transaction-report.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');

const BASE_URL = `http://localhost:${env.port}`;
const HOUSE_R24 = '00000007-0000-0000-0000-000000000007';
const HOUSE_A101_RESIDENT = '00000006-0000-0000-0000-000000000006';

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
  const adminToken = await loginToken('admin@society.app', 'password');

  // --- Unauthenticated is rejected ---
  check('unauthenticated GET is rejected (401)', (await get('/transactions/report', null)).status === 401);

  // --- A plain resident cannot view the full report ---
  check(
    'a plain resident cannot view the transaction report (403)',
    (await get('/transactions/report', residentToken)).status === 403
  );

  // --- Invalid filter values are rejected ---
  check(
    'an invalid status filter is rejected (400)',
    (await get('/transactions/report?status=NotARealStatus', adminToken)).status === 400
  );
  check(
    'an invalid transaction_type filter is rejected (400)',
    (await get('/transactions/report?transaction_type=NotARealType', adminToken)).status === 400
  );
  check(
    'an invalid from date is rejected (400)',
    (await get('/transactions/report?from=not-a-date', adminToken)).status === 400
  );
  check(
    'an invalid to date is rejected (400)',
    (await get('/transactions/report?to=not-a-date', adminToken)).status === 400
  );

  // --- No filters: the whole society's report, every status included ---
  const fullReport = await get('/transactions/report', adminToken);
  const fullIds = (fullReport.body || []).map((t) => t.id);
  const seedTenantPayment = (fullReport.body || []).find((t) => t.utr_number === 'SEEDTENANTR24PAYMENT');
  const seedUtilityBill = (fullReport.body || []).find((t) => t.utr_number === 'SEEDUTILITYBILL1');
  check(
    'no filters returns the full society report, including both a Submitted Maintenance payment and an already-Verified house-less expense',
    fullReport.status === 200 &&
      Array.isArray(fullReport.body) &&
      !!seedTenantPayment &&
      seedTenantPayment.processing_status === 'Submitted' &&
      !!seedUtilityBill &&
      seedUtilityBill.processing_status === 'Verified' &&
      seedUtilityBill.house_id === null,
    { seedTenantPayment, seedUtilityBill }
  );

  // --- status filter: Verified-only excludes the still-Submitted seeded
  //     payment, includes the seeded expense ---
  const verifiedOnly = await get('/transactions/report?status=Verified', adminToken);
  check(
    'status=Verified excludes the Submitted seeded payment and includes the Verified seeded expense',
    verifiedOnly.status === 200 &&
      Array.isArray(verifiedOnly.body) &&
      verifiedOnly.body.every((t) => t.processing_status === 'Verified') &&
      !verifiedOnly.body.some((t) => t.utr_number === 'SEEDTENANTR24PAYMENT') &&
      verifiedOnly.body.some((t) => t.utr_number === 'SEEDUTILITYBILL1'),
    verifiedOnly.body
  );

  // --- house_id filter: only R-24's transactions ---
  const r24Only = await get(`/transactions/report?house_id=${HOUSE_R24}`, adminToken);
  check(
    'house_id filter returns only that house\'s transactions',
    r24Only.status === 200 && Array.isArray(r24Only.body) && r24Only.body.every((t) => t.house_id === HOUSE_R24),
    r24Only.body
  );

  // --- house_id filter for an unrelated house returns none of R-24's rows ---
  const a101Only = await get(`/transactions/report?house_id=${HOUSE_A101_RESIDENT}`, adminToken);
  check(
    'a different house_id filter never leaks R-24\'s transactions',
    a101Only.status === 200 && !a101Only.body.some((t) => t.utr_number === 'SEEDTENANTR24PAYMENT'),
    a101Only.body
  );

  // --- transaction_type filter ---
  const utilityBillsOnly = await get('/transactions/report?transaction_type=UtilityBill', adminToken);
  check(
    'transaction_type=UtilityBill returns only UtilityBill transactions, including the seeded one',
    utilityBillsOnly.status === 200 &&
      utilityBillsOnly.body.every((t) => t.transaction_type === 'UtilityBill') &&
      utilityBillsOnly.body.some((t) => t.utr_number === 'SEEDUTILITYBILL1'),
    utilityBillsOnly.body
  );

  // --- from/to date range: a window far in the past excludes everything ---
  const farPastWindow = await get('/transactions/report?from=2000-01-01&to=2000-01-31', adminToken);
  check(
    'a from/to window far in the past returns an empty array, not an error',
    farPastWindow.status === 200 && Array.isArray(farPastWindow.body) && farPastWindow.body.length === 0,
    farPastWindow.body
  );

  // --- from/to date range: a window covering today includes the seeded
  //     rows (created_at defaults to NOW() at seed time / whenever the live
  //     project was seeded, but is always <= today) ---
  const today = new Date().toISOString().slice(0, 10);
  const todayWindow = await get(`/transactions/report?to=${today}T23:59:59Z`, adminToken);
  check(
    'a to= filter set to end-of-today still includes both seeded rows',
    todayWindow.status === 200 &&
      todayWindow.body.some((t) => t.utr_number === 'SEEDTENANTR24PAYMENT') &&
      todayWindow.body.some((t) => t.utr_number === 'SEEDUTILITYBILL1'),
    todayWindow.body
  );

  // --- Results are ordered newest-first ---
  const orderingOk = (fullReport.body || []).every((t, i, arr) => {
    if (i === 0) return true;
    return new Date(arr[i - 1].created_at).getTime() >= new Date(t.created_at).getTime();
  });
  check('results are ordered newest-first', orderingOk, fullReport.body?.slice(0, 3));

  console.log(`\n${passCount} passed, ${failCount} failed.`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
