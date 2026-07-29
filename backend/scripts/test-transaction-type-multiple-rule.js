// Verifies two things added in
// 20260725030000_add_transaction_type_and_multiple_rule.sql:
//   1. A 'Maintenance' transaction's amount must be a whole-month multiple
//      of the house's default_monthly_amount - partial months (e.g. 1.5x)
//      are rejected, whole multiples (1x, 2x, ...) are accepted, including
//      when the extra months don't exist yet and must be auto-generated.
//   2. Non-'Maintenance' transaction_type values are exempt from that rule
//      entirely, and an unrecognized transaction_type is rejected outright.
// Requires the server to be running (npm start) and the base seed fixtures
// from supabase/seed.sql (resident@society.app, house A-101) to already
// exist in the connected project. Run with:
//   node scripts/test-transaction-type-multiple-rule.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const HOUSE_A101 = '00000006-0000-0000-0000-000000000006'; // default_monthly_amount = 2200
const BASE_AMOUNT = 2200;

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
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const SOCIETY_ID = '00000003-0000-0000-0000-000000000003';

async function main() {
  const residentToken = await loginToken('resident@society.app', 'password');
  const adminToken = await loginToken('admin@society.app', 'password');
  const testUtr = `TESTTYPE${Date.now()}`;

  // 1. A partial-month amount (1.5x the base) must be rejected, and never
  //    reach the point of creating a transaction row at all.
  const partial = await post('/transactions', residentToken, {
    house_id: HOUSE_A101,
    amount: BASE_AMOUNT * 1.5,
    utr_number: `${testUtr}PARTIAL`,
  });
  check(
    'a 1.5x-base Maintenance payment is rejected (400)',
    partial.status === 400 && /multiple/i.test(partial.body.error || ''),
    partial
  );

  // 2. Omitting transaction_type defaults to 'Maintenance', and a clean 1x
  //    payment is accepted as before (no regression from the new field).
  const singleMonth = await post('/transactions', residentToken, {
    house_id: HOUSE_A101,
    amount: BASE_AMOUNT,
    utr_number: `${testUtr}SINGLE`,
  });
  check(
    'omitting transaction_type defaults to Maintenance and a 1x payment still succeeds (201)',
    singleMonth.status === 201 && singleMonth.body.transaction_type === 'Maintenance',
    singleMonth
  );

  // 3. A clean 2x-base payment is accepted, even when the second month's
  //    billing period does not exist yet and must be auto-generated - this
  //    is the "pay for multiple months" case the rule must still allow.
  const twoMonths = await post('/transactions', residentToken, {
    house_id: HOUSE_A101,
    amount: BASE_AMOUNT * 2,
    utr_number: `${testUtr}TWOMONTHS`,
  });
  check(
    'a clean 2x-base Maintenance payment succeeds (201) with 2 allocations of the base amount each',
    twoMonths.status === 201 &&
      Array.isArray(twoMonths.body.allocations) &&
      twoMonths.body.allocations.length === 2 &&
      twoMonths.body.allocations.every((a) => Number(a.amount_allocated) === BASE_AMOUNT),
    twoMonths.body
  );

  // 4. An unrecognized transaction_type is rejected outright.
  const badType = await post('/transactions', residentToken, {
    house_id: HOUSE_A101,
    amount: BASE_AMOUNT,
    utr_number: `${testUtr}BADTYPE`,
    transaction_type: 'NotARealType',
  });
  check('an unrecognized transaction_type is rejected (400)', badType.status === 400, badType);

  // 5. A non-Maintenance type is exempt from the multiple rule entirely -
  //    an arbitrary amount that is not a multiple of any house's base
  //    amount still succeeds, because a society expense (utility
  //    bill/salary) has no monthly "base amount" to be a multiple of. Full
  //    coverage of the expense-only fields (payee_name, society_id,
  //    Admin-only, no house_id) lives in test-society-expenses.js - this
  //    just confirms the multiple rule specifically stays out of the way.
  const utilityBill = await post('/transactions', adminToken, {
    society_id: SOCIETY_ID,
    amount: 999,
    utr_number: `${testUtr}UTILITY`,
    transaction_type: 'UtilityBill',
    payee_name: 'Test Utility Co',
  });
  check(
    'a non-Maintenance type with a non-multiple amount is exempt from the rule and succeeds (201)',
    utilityBill.status === 201 && utilityBill.body.transaction_type === 'UtilityBill',
    utilityBill.body
  );

  // 6. The old pre-expense-feature shape - a non-Maintenance type together
  //    with a house_id - is now rejected outright, since house_id and
  //    transaction_type are now tied together by a DB CHECK constraint
  //    (20260726010000_society_expenses_house_optional.sql): Maintenance
  //    always has a house, every other type never does.
  const utilityWithHouse = await post('/transactions', adminToken, {
    house_id: HOUSE_A101,
    amount: 999,
    utr_number: `${testUtr}UTILITYWITHHOUSE`,
    transaction_type: 'UtilityBill',
    payee_name: 'Test Utility Co',
  });
  check(
    'a non-Maintenance type with a house_id is rejected (400)',
    utilityWithHouse.status === 400 && /house_id must not be provided/i.test(utilityWithHouse.body.error || ''),
    utilityWithHouse
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // The UtilityBill case is recorded already-Verified (see
  // 20260726010000_society_expenses_house_optional.sql), which writes an
  // audit_events row at creation time - clean that up too, not just the
  // transaction row itself.
  if (utilityBill.body.id) {
    await supabaseAdmin.from('audit_events').delete().eq('entity_id', utilityBill.body.id);
  }
  // Cascades to transaction_allocations automatically (ON DELETE CASCADE).
  await supabaseAdmin.from('transactions').delete().like('utr_number', 'TESTTYPE%');
  // Test 3 (the clean 2x-base payment) deliberately auto-generates a
  // second, next-month billing_periods row for HOUSE_A101 if it didn't
  // already exist - the exact "pay ahead of schedule" case this rule must
  // allow. That row has no test-prefixed field to filter it by and is not
  // itself deleted by the transactions cleanup above, so remove anything
  // beyond the one current-month period seed.sql describes for this house
  // - otherwise it silently breaks test-rls.js's "resident sees exactly 1
  // billing period for their own house" assertion on a later run.
  await supabaseAdmin
    .from('billing_periods')
    .delete()
    .eq('house_id', HOUSE_A101)
    .neq('period_month', currentMonthStartDateOnly());

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
