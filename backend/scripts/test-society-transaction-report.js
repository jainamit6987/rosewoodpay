// Verifies GET /society/:id/transaction-report?month=YYYY-MM
// (backend/src/routes/society.js): Admin/Committee whole-society ledger for
// a chosen calendar month - every Verified transaction, Cr (Maintenance) or
// Dr (UtilityBill/Salary/Other), with a synthesized "House <no> - <billing
// period(s)>" description for Maintenance rows and the real description
// column for expense rows. Filtered on verified_at (always set for a
// Verified row), not the optional txn_date.
// Requires the server running (npm run dev).
// Run with: node scripts/test-society-transaction-report.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const SOCIETY_ID = '00000003-0000-0000-0000-000000000003';
const RESIDENT_MEMBER_ID = '00000005-0000-0000-0000-000000000005';

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

function findRow(rows, id) {
  return (rows || []).find((r) => r.id === id);
}

// Mirrors routes/society.js's own MONTH_NAMES/formatPeriodMonthLabel
// exactly, so this test's expectation can't silently drift from what the
// endpoint actually does just because a locale-based formatter (e.g.
// toLocaleDateString) behaves differently in the test runner's environment.
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatPeriodMonthLabel(periodMonth) {
  const [year, month] = periodMonth.split('-').map(Number);
  return `${MONTH_NAMES[month - 1]} ${year}`;
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
  const testTag = `TESTTXNREPORT${Date.now()}`.slice(0, 20);

  // --- Setup: a throwaway house with a current-month Open period, a Cash
  //     Maintenance payment against it (Cr, auto-Verified), and a society
  //     expense (Dr, auto-Verified) - both landing in "this month" by
  //     default since verified_at is always set to now() at insert. ---
  const CASH_AMOUNT = 2100;
  const { data: house, error: houseError } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: SOCIETY_ID, house_number: testTag, type: 'Flat', default_monthly_amount: CASH_AMOUNT })
    .select('id, house_number')
    .single();
  if (houseError) {
    console.error('setup failed: could not create throwaway house', houseError.message);
  }
  const currentMonthDate = new Date();
  const currentPeriodMonth = new Date(
    Date.UTC(currentMonthDate.getUTCFullYear(), currentMonthDate.getUTCMonth(), 1)
  )
    .toISOString()
    .slice(0, 10);
  const { error: periodError } = await supabaseAdmin.from('billing_periods').insert({
    society_id: SOCIETY_ID,
    house_id: house.id,
    period_month: currentPeriodMonth,
    base_amount: CASH_AMOUNT,
    amount_due: CASH_AMOUNT,
    status: 'Open',
  });
  if (periodError) {
    console.error('setup failed: could not create throwaway house\'s period', periodError.message);
  }
  await supabaseAdmin.from('resident_house_assignments').insert({
    society_member_id: RESIDENT_MEMBER_ID,
    house_id: house.id,
    status: 'Active',
    approved_at: new Date().toISOString(),
  });

  const cashTxn = await post('/transactions', adminToken, {
    house_id: house.id,
    amount: CASH_AMOUNT,
    payment_mode: 'Cash',
    txn_date: '2020-01-15', // deliberately far in the past - proves the report displays this, but filters on verified_at
  });
  check('setup: Cash Maintenance payment recorded and auto-Verified', cashTxn.status === 201, cashTxn.body);

  const EXPENSE_AMOUNT = 15000;
  const expenseTxn = await post('/transactions', adminToken, {
    society_id: SOCIETY_ID,
    transaction_type: 'Salary',
    description: `${testTag} security guard salary`,
    amount: EXPENSE_AMOUNT,
    payment_mode: 'NEFT_IMPS',
    utr_number: `${testTag}REF1`,
    payee_name: 'Test Security Agency',
  });
  check('setup: Salary expense recorded and auto-Verified', expenseTxn.status === 201, expenseTxn.body);

  // --- Unauthenticated / plain resident are rejected ---
  check(
    'unauthenticated GET is rejected (401)',
    (await get(`/society/${SOCIETY_ID}/transaction-report`, null)).status === 401
  );
  check(
    'a plain resident cannot view the transaction report (403)',
    (await get(`/society/${SOCIETY_ID}/transaction-report`, residentToken)).status === 403
  );

  // --- Invalid month formats are rejected ---
  check(
    'month=2026-13 (invalid month number) is rejected (400)',
    (await get(`/society/${SOCIETY_ID}/transaction-report?month=2026-13`, adminToken)).status === 400
  );
  check(
    'month=July2026 (wrong shape) is rejected (400)',
    (await get(`/society/${SOCIETY_ID}/transaction-report?month=July2026`, adminToken)).status === 400
  );

  // --- Default (current month): both throwaway rows appear, correctly
  //     shaped ---
  const currentReport = await get(`/society/${SOCIETY_ID}/transaction-report`, adminToken);
  check(
    'default report (current month) returns 200 with month echoed back',
    currentReport.status === 200 && currentReport.body.month === monthString(0),
    currentReport.body
  );

  const cashRow = findRow(currentReport.body.transactions, cashTxn.body.id);
  const expectedCashDescription = `House ${house.house_number} - ${formatPeriodMonthLabel(currentPeriodMonth)}`;
  check(
    'the Cash Maintenance row is Cr, with House <no> - <billing period> description',
    !!cashRow &&
      cashRow.direction === 'Cr' &&
      cashRow.transaction_type === 'Maintenance' &&
      cashRow.payment_mode === 'Cash' &&
      Number(cashRow.amount) === CASH_AMOUNT &&
      cashRow.description === expectedCashDescription,
    { cashRow, expectedCashDescription }
  );
  check(
    'the Cash row displays its own resident-supplied txn_date, not verified_at',
    !!cashRow && cashRow.txn_date.startsWith('2020-01-15'),
    cashRow
  );

  const expenseRow = findRow(currentReport.body.transactions, expenseTxn.body.id);
  check(
    'the Salary expense row is Dr, with its own recorded description and reference number',
    !!expenseRow &&
      expenseRow.direction === 'Dr' &&
      expenseRow.transaction_type === 'Salary' &&
      expenseRow.payment_mode === 'NEFT_IMPS' &&
      Number(expenseRow.amount) === EXPENSE_AMOUNT &&
      expenseRow.description === `${testTag} security guard salary` &&
      expenseRow.utr_number === `${testTag}REF1`,
    expenseRow
  );
  check(
    'the expense row falls back to verified_at for txn_date display (none was supplied)',
    !!expenseRow && !!expenseRow.txn_date,
    expenseRow
  );

  // --- Month filtering: backdating verified_at moves a row out of the
  //     current month's report and into that older month's report instead ---
  const twoMonthsAgo = monthString(2);
  const backdatedVerifiedAt = `${twoMonthsAgo}-10T00:00:00.000Z`;
  const { error: backdateError } = await supabaseAdmin
    .from('transactions')
    .update({ verified_at: backdatedVerifiedAt })
    .eq('id', expenseTxn.body.id);
  if (backdateError) {
    console.error('setup failed: could not backdate the expense row\'s verified_at', backdateError.message);
  }

  const afterBackdateCurrentReport = await get(`/society/${SOCIETY_ID}/transaction-report`, adminToken);
  check(
    'after backdating, the expense row no longer appears in the current month report',
    !findRow(afterBackdateCurrentReport.body.transactions, expenseTxn.body.id),
    afterBackdateCurrentReport.body.transactions
  );
  check(
    'the Cash row (never backdated) still appears in the current month report',
    !!findRow(afterBackdateCurrentReport.body.transactions, cashTxn.body.id),
    afterBackdateCurrentReport.body.transactions
  );

  const twoMonthsAgoReport = await get(`/society/${SOCIETY_ID}/transaction-report?month=${twoMonthsAgo}`, adminToken);
  check(
    'the backdated expense row now appears in that older month\'s report instead',
    twoMonthsAgoReport.status === 200 && !!findRow(twoMonthsAgoReport.body.transactions, expenseTxn.body.id),
    twoMonthsAgoReport.body
  );

  // --- A month with nothing in it returns an empty array, not an error ---
  const farPastMonth = monthString(36);
  const farPastReport = await get(`/society/${SOCIETY_ID}/transaction-report?month=${farPastMonth}`, adminToken);
  check(
    'a month with zero transactions returns an empty array (not an error)',
    farPastReport.status === 200 &&
      Array.isArray(farPastReport.body.transactions) &&
      farPastReport.body.transactions.length === 0,
    farPastReport.body
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // Cleanup: allocations before the billing period they point to (ON DELETE
  // RESTRICT - same ordering test-cash-payment.js/test-pendency-report.js
  // already need), then the transactions, then the throwaway house (cascades
  // its billing_periods and assignment).
  if (cashTxn.body?.id) {
    await supabaseAdmin.from('audit_events').delete().eq('entity_id', cashTxn.body.id);
    await supabaseAdmin.from('transaction_allocations').delete().eq('transaction_id', cashTxn.body.id);
    await supabaseAdmin.from('transactions').delete().eq('id', cashTxn.body.id);
  }
  if (expenseTxn.body?.id) {
    await supabaseAdmin.from('audit_events').delete().eq('entity_id', expenseTxn.body.id);
    await supabaseAdmin.from('transactions').delete().eq('id', expenseTxn.body.id);
  }
  if (house?.id) {
    await supabaseAdmin.from('houses').delete().eq('id', house.id);
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
