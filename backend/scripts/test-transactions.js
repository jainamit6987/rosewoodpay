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

async function billingPeriodFor(houseId) {
  const { data } = await supabaseAdmin.from('billing_periods').select('id').eq('house_id', houseId).single();
  return data.id;
}

async function main() {
  const residentToken = await loginToken('resident@society.app', 'password');
  const adminToken = await loginToken('admin@society.app', 'password');
  const a101Period = await billingPeriodFor(HOUSE_A101);
  const r24Period = await billingPeriodFor(HOUSE_R24);
  const testUtr = `TEST${Date.now()}`;

  const noAuth = await post('/transactions', null, { house_id: HOUSE_A101, billing_period_id: a101Period, amount: 2200 });
  check('unauthenticated request is rejected (401)', noAuth.status === 401, noAuth);

  const missingFields = await post('/transactions', residentToken, { amount: 2200 });
  check('missing house_id/billing_period_id is rejected (400)', missingFields.status === 400, missingFields);

  const missingProof = await post('/transactions', residentToken, {
    house_id: HOUSE_A101,
    billing_period_id: a101Period,
    amount: 2200,
  });
  check('missing utr/proof/payload is rejected (400)', missingProof.status === 400, missingProof);

  const wrongHouse = await post('/transactions', residentToken, {
    house_id: HOUSE_R24,
    billing_period_id: r24Period,
    amount: 2500,
    utr_number: `${testUtr}WRONGHOUSE`,
  });
  check('resident submitting for an unassigned house is rejected (403)', wrongHouse.status === 403, wrongHouse);

  const valid = await post('/transactions', residentToken, {
    house_id: HOUSE_A101,
    billing_period_id: a101Period,
    amount: 2200,
    utr_number: testUtr,
  });
  check(
    'resident submitting for their own house + open billing period succeeds (201, status Submitted)',
    valid.status === 201 && valid.body.processing_status === 'Submitted',
    valid
  );

  const duplicate = await post('/transactions', residentToken, {
    house_id: HOUSE_A101,
    billing_period_id: a101Period,
    amount: 2200,
    utr_number: testUtr,
  });
  check('resubmitting the same UTR is rejected (409)', duplicate.status === 409, duplicate);

  const adminOnBehalf = await post('/transactions', adminToken, {
    house_id: HOUSE_R24,
    billing_period_id: r24Period,
    amount: 2500,
    utr_number: `${testUtr}CASH`,
  });
  check(
    'admin recording a cash payment for another house succeeds (201)',
    adminOnBehalf.status === 201 && adminOnBehalf.body.processing_status === 'Submitted',
    adminOnBehalf
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  await supabaseAdmin.from('transactions').delete().like('utr_number', 'TEST%');

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
