// Verifies FIFO billing-period allocation for a resident onboarded with
// pre-existing arrears: their next payment must resolve to the oldest
// remaining Open billing period, not the current month, even though the
// request never specifies which period to pay (billing_period_id is not
// part of the request body at all - see routes/transactions.js).
// Requires the server to be running (npm start) and the seed fixtures from
// supabase/seed.sql (arrears@society.app, house C-303) to already exist in
// the connected project. Run with:
//   node scripts/test-arrears-fifo.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const HOUSE_C303 = '0000000f-0000-0000-0000-00000000000f';

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
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function post(path, token, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  const arrearsToken = await loginToken('arrears@society.app', 'password');

  // 1. The oldest Open period (3 months ago) should be first in /me's
  //    openBillingPeriods, and totalOutstanding should sum all 4 remaining
  //    Open periods (2200 x 4 = 8800) - the already-Closed month is not
  //    included.
  const me = await get('/me', arrearsToken);
  const resident = me.body.memberships?.[0];
  const oldestOpenFromMe = resident?.openBillingPeriods?.[0];

  check(
    '/me lists this resident\'s open billing periods oldest-first',
    me.status === 200 &&
      Array.isArray(resident?.openBillingPeriods) &&
      resident.openBillingPeriods.length === 4 &&
      new Date(oldestOpenFromMe.period_month) <
        new Date(resident.openBillingPeriods[resident.openBillingPeriods.length - 1].period_month),
    me.body
  );

  check(
    '/me totalOutstanding sums all 4 remaining Open periods (8800), excluding the Closed one',
    me.status === 200 && resident?.totalOutstanding === 8800,
    resident
  );

  // 2. Submitting a payment with no billing_period_id in the request at all
  //    must resolve to that same oldest Open period - not the current month.
  const testUtr = `TESTARREARS${Date.now()}`;
  const payment = await post('/transactions', arrearsToken, {
    house_id: HOUSE_C303,
    amount: 2200,
    utr_number: testUtr,
  });

  check(
    'a single-month payment resolves to one allocation, against the oldest Open period (FIFO), not the current month',
    payment.status === 201 &&
      Array.isArray(payment.body.allocations) &&
      payment.body.allocations.length === 1 &&
      payment.body.allocations[0].billing_period_id === oldestOpenFromMe.id,
    payment.body
  );

  // 3. A lump payment covering more than one month's dues (e.g. catching up
  //    2 months of arrears in a single UTR) should produce one transaction
  //    with multiple allocations, oldest-first, each capped at that
  //    period's own amount_due rather than split evenly.
  const meAfterFirstPayment = await get('/me', arrearsToken);
  const remainingOpenPeriods = meAfterFirstPayment.body.memberships?.[0]?.openBillingPeriods || [];
  const nextTwoPeriods = remainingOpenPeriods.slice(0, 2);
  const lumpAmount = nextTwoPeriods.reduce((sum, period) => sum + Number(period.amount_due), 0);
  const lumpUtr = `TESTARREARSLUMP${Date.now()}`;

  const lumpPayment = await post('/transactions', arrearsToken, {
    house_id: HOUSE_C303,
    amount: lumpAmount,
    utr_number: lumpUtr,
  });

  check(
    'a lump payment covering 2 months produces one transaction with 2 allocations, oldest-first',
    lumpPayment.status === 201 &&
      Array.isArray(lumpPayment.body.allocations) &&
      lumpPayment.body.allocations.length === 2 &&
      lumpPayment.body.allocations.map((a) => a.billing_period_id).sort().join(',') ===
        nextTwoPeriods.map((p) => p.id).sort().join(','),
    lumpPayment.body
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // Cascades to transaction_allocations automatically (ON DELETE CASCADE).
  await supabaseAdmin.from('transactions').delete().like('utr_number', 'TESTARREARS%');

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
