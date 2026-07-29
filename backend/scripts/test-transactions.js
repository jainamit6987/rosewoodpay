// Action 5 verification: a resident can create a valid pending transaction,
// while invalid house, billing-period, duplicate, and unauthorized
// submissions are all rejected. Requires the server to be running
// (npm start) on the port in .env. Run with: node scripts/test-transactions.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const HOUSE_A101 = '00000006-0000-0000-0000-000000000006'; // resident's assigned house
const HOUSE_R24 = '00000007-0000-0000-0000-000000000007'; // not assigned to the resident

function currentMonthStartDateOnly() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

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
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function main() {
  const residentToken = await loginToken('resident@society.app', 'password');
  const adminToken = await loginToken('admin@society.app', 'password');
  const testUtr = `TEST${Date.now()}`;

  // billing_period_id is no longer part of the request - the server always
  // resolves it itself (FIFO: oldest Open period for the house). See
  // scripts/test-arrears-fifo.js for a case that actually exercises that
  // resolution against a house with multiple open periods.
  const noAuth = await post('/transactions', null, { house_id: HOUSE_A101, amount: 2200 });
  check('unauthenticated request is rejected (401)', noAuth.status === 401, noAuth);

  const missingFields = await post('/transactions', residentToken, { amount: 2200 });
  check('missing house_id is rejected (400)', missingFields.status === 400, missingFields);

  const missingProof = await post('/transactions', residentToken, {
    house_id: HOUSE_A101,
    amount: 2200,
  });
  check('missing utr/proof/payload is rejected (400)', missingProof.status === 400, missingProof);

  const wrongHouse = await post('/transactions', residentToken, {
    house_id: HOUSE_R24,
    amount: 2500,
    utr_number: `${testUtr}WRONGHOUSE`,
  });
  check('resident submitting for an unassigned house is rejected (403)', wrongHouse.status === 403, wrongHouse);

  const valid = await post('/transactions', residentToken, {
    house_id: HOUSE_A101,
    amount: 2200,
    utr_number: testUtr,
  });
  check(
    'resident submitting for their own house succeeds (201, status Submitted, auto-resolved allocation)',
    valid.status === 201 &&
      valid.body.processing_status === 'Submitted' &&
      Array.isArray(valid.body.allocations) &&
      valid.body.allocations.length === 1,
    valid
  );

  const duplicate = await post('/transactions', residentToken, {
    house_id: HOUSE_A101,
    amount: 2200,
    utr_number: testUtr,
  });
  check('resubmitting the same UTR is rejected (409)', duplicate.status === 409, duplicate);

  const adminOnBehalf = await post('/transactions', adminToken, {
    house_id: HOUSE_R24,
    amount: 2500,
    utr_number: `${testUtr}CASH`,
  });
  check(
    'admin recording a cash payment for another house succeeds (201)',
    adminOnBehalf.status === 201 && adminOnBehalf.body.processing_status === 'Submitted',
    adminOnBehalf
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // Cascades to transaction_allocations automatically (ON DELETE CASCADE).
  await supabaseAdmin.from('transactions').delete().like('utr_number', 'TEST%');
  // R-24's only seeded billing period is already 'Closed' (see seed.sql),
  // so adminOnBehalf above (2500 on HOUSE_R24) always needed a fresh
  // 'Open' period auto-generated to allocate to - that row has no
  // test-prefixed field of its own and is not removed by the
  // transactions cleanup above. Same leaked-fixture class already fixed
  // in test-transaction-type-multiple-rule.js, test-verify-reject.js, and
  // test-pending-transactions.js: remove anything beyond the one
  // current-month period seed.sql describes for this house, or later
  // runs of test-rls.js silently break on "exactly 1 billing period for
  // R-24".
  await supabaseAdmin
    .from('billing_periods')
    .delete()
    .eq('house_id', HOUSE_R24)
    .neq('period_month', currentMonthStartDateOnly());

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
