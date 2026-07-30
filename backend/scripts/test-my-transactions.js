// Verifies GET /transactions/mine (backend/src/routes/transactions.js): the
// aggregated "all my transactions, across every house I'm assigned to"
// endpoint. Requires the server running (npm run dev) and the seed
// fixtures from supabase/seed.sql to already exist in the connected
// project (owner2@society.app / B-102 + R-24, tenant@society.app / R-24,
// arrears@society.app / C-303, admin@society.app / D-404).
// Run with: node scripts/test-my-transactions.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');

const BASE_URL = `http://localhost:${env.port}`;
const HOUSE_R24 = '00000007-0000-0000-0000-000000000007';
const HOUSE_B102 = '0000000c-0000-0000-0000-00000000000c';
const HOUSE_C303_ARREARS = '0000000f-0000-0000-0000-00000000000f';
const HOUSE_D404_ADMIN = '00000012-0000-0000-0000-000000000012';

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
  const owner2Token = await loginToken('owner2@society.app', 'password');
  const tenantToken = await loginToken('tenant@society.app', 'password');
  const arrearsToken = await loginToken('arrears@society.app', 'password');
  const adminToken = await loginToken('admin@society.app', 'password');

  // --- Unauthenticated is rejected ---
  check('unauthenticated GET is rejected (401)', (await get('/transactions/mine', null)).status === 401);

  // --- Owner2 is assigned to two houses (B-102 they live in, R-24 they rent
  //     out to Tenant) and never submitted anything themselves for R-24 -
  //     GET /mine should still aggregate the Tenant's R-24 transaction into
  //     Owner2's own list, proving this is assignment-scoped, not
  //     submitted_by-scoped ---
  const owner2 = await get('/transactions/mine', owner2Token);
  const owner2HouseIds = (owner2.body || []).map((t) => t.house_id);
  check(
    'Owner2 sees transactions aggregated across both their houses (B-102 and R-24), including the Tenant\'s R-24 payment they never submitted',
    owner2.status === 200 &&
      Array.isArray(owner2.body) &&
      owner2HouseIds.includes(HOUSE_R24) &&
      owner2.body.some((t) => t.utr_number === 'SEEDTENANTR24PAYMENT'),
    owner2.body
  );
  check(
    'none of Owner2\'s results belong to a house they are not assigned to',
    owner2HouseIds.every((id) => id === HOUSE_R24 || id === HOUSE_B102),
    owner2HouseIds
  );

  // --- Tenant is assigned only to R-24, and DID submit that payment
  //     themselves - should see it via /mine too ---
  const tenant = await get('/transactions/mine', tenantToken);
  check(
    'Tenant (assigned only to R-24) sees their own R-24 payment via /mine',
    tenant.status === 200 &&
      Array.isArray(tenant.body) &&
      tenant.body.every((t) => t.house_id === HOUSE_R24) &&
      tenant.body.some((t) => t.utr_number === 'SEEDTENANTR24PAYMENT'),
    tenant.body
  );

  // --- The arrears resident's seeded Verified catch-up payment shows up ---
  const arrears = await get('/transactions/mine', arrearsToken);
  check(
    'arrears resident (assigned only to C-303) sees their own seeded payment via /mine',
    arrears.status === 200 &&
      Array.isArray(arrears.body) &&
      arrears.body.every((t) => t.house_id === HOUSE_C303_ARREARS) &&
      arrears.body.some((t) => t.utr_number === 'SEEDARREARSPAYMENT1'),
    arrears.body
  );

  // --- Each allocation names the actual billing period it covers (not just
  //     a billing_period_id a UI can't label), via a nested embed through
  //     transaction_allocations into billing_periods - the seeded catch-up
  //     payment covers exactly the one period 4 months back ---
  const arrearsPayment = (arrears.body || []).find((t) => t.utr_number === 'SEEDARREARSPAYMENT1');
  check(
    'the seeded catch-up payment\'s allocation names its own billing period\'s period_month',
    arrearsPayment?.transaction_allocations?.length === 1 &&
      typeof arrearsPayment.transaction_allocations[0].billing_periods?.period_month === 'string',
    arrearsPayment
  );

  // --- Admin's own /mine reflects their personal house (D-404) only, not
  //     the society's UtilityBill expense (house_id null) or any other
  //     resident's house - proving this stays personal-assignment-scoped
  //     even for an account that also has admin powers ---
  const admin = await get('/transactions/mine', adminToken);
  const adminHouseIds = (admin.body || []).map((t) => t.house_id);
  check(
    'Admin\'s own /mine is scoped to their personal house assignment (D-404) only, excluding the house-less society expense',
    admin.status === 200 && Array.isArray(admin.body) && adminHouseIds.every((id) => id === HOUSE_D404_ADMIN),
    admin.body
  );

  // --- Results are ordered newest-first ---
  const isNewestFirst = (owner2.body || []).every(
    (t, index) => index === 0 || new Date(t.created_at) <= new Date(owner2.body[index - 1].created_at)
  );
  check('results are ordered newest-first', isNewestFirst, owner2.body);

  console.log(`\n${passCount} passed, ${failCount} failed.`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
