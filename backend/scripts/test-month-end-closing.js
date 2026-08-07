// Verifies GET/POST /society/:id/month-end-closing (backend/src/routes/
// society.js): the Month-End Closing report - Opening Balance (Bank/Cash,
// Admin-supplied/overridable) -> Income/Expense grid (Online vs Cash, one
// row per transaction_type, Other broken down by exact-match description,
// shown on both its Income and Expense sides via transactions.direction) ->
// Overall Total -> Closing Balance -> Breakup of Maintenance Collection.
// Also exercises the generation guard (blocks while a Submitted
// transaction dated on/before the target month is unresolved) and the
// Admin-always-live-preview / Committee-only-saved access split.
// Does NOT hardcode the old admin@society.app/resident@society.app fixture
// logins (drifted since the Rosewood Century reseed - see
// test-reset-password.js and others, left intentionally unfixed per the
// user's own call); reads whichever Active Admin/plain-resident currently
// exist straight from the live DB instead, using the reseed's own
// `password123`.
// Requires the server running (npm run dev).
// Run with: node scripts/test-month-end-closing.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const SEED_PASSWORD = 'password123';
const MAINT_AMOUNT = 5000;

async function findActiveAdminAndResident() {
  const { data: admins } = await supabaseAdmin
    .from('society_members')
    .select('id, society_id, auth_user_id, is_admin, status')
    .eq('is_admin', true)
    .eq('status', 'Active')
    .limit(1);
  if (!admins || admins.length === 0) throw new Error('setup: no Active Admin found in the DB to test against.');
  const admin = admins[0];

  const { data: residents } = await supabaseAdmin
    .from('society_members')
    .select('id, society_id, auth_user_id, is_admin, is_committee_member, status')
    .eq('society_id', admin.society_id)
    .eq('is_admin', false)
    .eq('is_committee_member', false)
    .eq('status', 'Active')
    .limit(1);
  if (!residents || residents.length === 0) throw new Error('setup: no plain Active resident found in the same society.');

  const { data: usersPage } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const emailById = new Map(usersPage.users.map((u) => [u.id, u.email]));

  return {
    societyId: admin.society_id,
    adminEmail: emailById.get(admin.auth_user_id),
    residentId: residents[0].id,
    residentEmail: emailById.get(residents[0].auth_user_id),
  };
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

// A stable, distinctive past month (unlikely to collide with other test
// scripts' current-month fixtures or real data) that this script owns
// entirely - all figures below are computed by hand against exactly the
// fixture transactions this script itself creates in it.
function monthString(monthsAgo) {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
  return date.toISOString().slice(0, 7);
}
const TARGET_MONTH = monthString(30);
const TARGET_VERIFIED_AT = `${TARGET_MONTH}-10T00:00:00.000Z`;
const TARGET_TXN_DATE = `${TARGET_MONTH}-10`;

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

function findRow(rows, type) {
  return (rows || []).find((r) => r.type === type);
}

function findBreakdown(list, description) {
  return (list || []).find((item) => item.description === description);
}

async function backdate(transactionId) {
  const { error } = await supabaseAdmin
    .from('transactions')
    .update({ verified_at: TARGET_VERIFIED_AT })
    .eq('id', transactionId);
  if (error) console.error(`setup failed: could not backdate ${transactionId}`, error.message);
}

async function main() {
  const { societyId: SOCIETY_ID, adminEmail, residentId: RESIDENT_MEMBER_ID, residentEmail } = await findActiveAdminAndResident();
  check('setup: found a live Active Admin and plain resident to test against', !!adminEmail && !!residentEmail, {
    adminEmail,
    residentEmail,
  });
  const residentToken = await loginToken(residentEmail, SEED_PASSWORD);
  const adminToken = await loginToken(adminEmail, SEED_PASSWORD);
  const testTag = `TESTMEC${Date.now()}`.slice(0, 20);

  const createdTransactionIds = [];
  const createdHouseIds = [];
  const createdAuthUserIds = [];

  // --- Setup: a throwaway house for the two house-linked (Maintenance/
  //     WaterCharge) fixtures, and a matching Active resident assignment
  //     so the FIFO/assignment checks in POST /transactions pass. ---
  const { data: house, error: houseError } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: SOCIETY_ID, house_number: testTag, type: 'Flat', default_monthly_amount: MAINT_AMOUNT })
    .select('id, house_number')
    .single();
  if (houseError) console.error('setup failed: could not create throwaway house', houseError.message);
  createdHouseIds.push(house.id);

  const { error: assignmentError } = await supabaseAdmin.from('resident_house_assignments').insert({
    society_member_id: RESIDENT_MEMBER_ID,
    house_id: house.id,
    status: 'Active',
    approved_at: new Date().toISOString(),
  });
  if (assignmentError) console.error('setup failed: could not create assignment', assignmentError.message);

  // 1. Maintenance, Cash (auto-Verified) - Income Cash.
  const maintCash = await post('/transactions', adminToken, {
    house_id: house.id,
    amount: MAINT_AMOUNT,
    payment_mode: 'Cash',
  });
  check('setup: Maintenance Cash payment recorded', maintCash.status === 201, maintCash.body);
  if (maintCash.body?.id) createdTransactionIds.push(maintCash.body.id);

  // 2. Maintenance, UPI (Submitted -> verified) - Income Online.
  const maintUpi = await post('/transactions', adminToken, {
    house_id: house.id,
    amount: MAINT_AMOUNT,
    payment_mode: 'UPI',
    utr_number: `${testTag}MAINTUPI`,
  });
  check('setup: Maintenance UPI payment submitted', maintUpi.status === 201, maintUpi.body);
  if (maintUpi.body?.id) {
    createdTransactionIds.push(maintUpi.body.id);
    const verifyRes = await post(`/transactions/${maintUpi.body.id}/verify`, adminToken);
    check('setup: Maintenance UPI payment verified', verifyRes.status === 200, verifyRes.body);
  }

  // 3. WaterCharge, NEFT_IMPS (Submitted -> verified) - Income Online.
  const waterOnline = await post('/transactions', adminToken, {
    house_id: house.id,
    transaction_type: 'WaterCharge',
    amount: 800,
    payment_mode: 'NEFT_IMPS',
    utr_number: `${testTag}WATERONLINE`,
  });
  check('setup: WaterCharge NEFT_IMPS payment submitted', waterOnline.status === 201, waterOnline.body);
  if (waterOnline.body?.id) {
    createdTransactionIds.push(waterOnline.body.id);
    const verifyRes = await post(`/transactions/${waterOnline.body.id}/verify`, adminToken);
    check('setup: WaterCharge NEFT_IMPS payment verified', verifyRes.status === 200, verifyRes.body);
  }

  // 4. WaterCharge, Cash (auto-Verified) - Income Cash.
  const waterCash = await post('/transactions', adminToken, {
    house_id: house.id,
    transaction_type: 'WaterCharge',
    amount: 300,
    payment_mode: 'Cash',
  });
  check('setup: WaterCharge Cash payment recorded', waterCash.status === 201, waterCash.body);
  if (waterCash.body?.id) createdTransactionIds.push(waterCash.body.id);

  // 5. UtilityBill, Cheque (auto-Verified) - Expense Online.
  const utilityBill = await post('/transactions', adminToken, {
    society_id: SOCIETY_ID,
    transaction_type: 'UtilityBill',
    amount: 12000,
    payment_mode: 'Cheque',
    utr_number: `${testTag}UTILCHQ`,
    payee_name: 'Test Electricity Board',
    description: `${testTag} electricity bill`,
  });
  check('setup: UtilityBill Cheque expense recorded', utilityBill.status === 201, utilityBill.body);
  if (utilityBill.body?.id) createdTransactionIds.push(utilityBill.body.id);

  // 6. Salary, Cash (auto-Verified) - Expense Cash.
  const salary = await post('/transactions', adminToken, {
    society_id: SOCIETY_ID,
    transaction_type: 'Salary',
    amount: 9000,
    payment_mode: 'Cash',
    payee_name: 'Test Security Agency',
    description: `${testTag} security guard salary`,
  });
  check('setup: Salary Cash expense recorded', salary.status === 201, salary.body);
  if (salary.body?.id) createdTransactionIds.push(salary.body.id);

  // 7/8. Other expenses, same exact description, different modes - proves
  //      exact-description grouping (count=2, online+cash summed).
  const otherExpenseDesc = `${testTag} Diwali Decoration`;
  const otherExpenseOnline = await post('/transactions', adminToken, {
    society_id: SOCIETY_ID,
    transaction_type: 'Other',
    amount: 500,
    payment_mode: 'UPI',
    utr_number: `${testTag}OTHEREXP1`,
    payee_name: 'Test Decorator',
    description: otherExpenseDesc,
  });
  check('setup: Other expense (UPI) recorded, defaults to Dr', otherExpenseOnline.status === 201 && otherExpenseOnline.body.direction === 'Dr', otherExpenseOnline.body);
  if (otherExpenseOnline.body?.id) createdTransactionIds.push(otherExpenseOnline.body.id);

  const otherExpenseCash = await post('/transactions', adminToken, {
    society_id: SOCIETY_ID,
    transaction_type: 'Other',
    amount: 300,
    payment_mode: 'Cash',
    payee_name: 'Test Decorator',
    description: otherExpenseDesc,
  });
  check('setup: Other expense (Cash), same description recorded', otherExpenseCash.status === 201, otherExpenseCash.body);
  if (otherExpenseCash.body?.id) createdTransactionIds.push(otherExpenseCash.body.id);

  // 9. Other expense, different description - its own separate group.
  const otherExpenseOther = await post('/transactions', adminToken, {
    society_id: SOCIETY_ID,
    transaction_type: 'Other',
    amount: 700,
    payment_mode: 'NEFT_IMPS',
    utr_number: `${testTag}OTHEREXP2`,
    payee_name: 'Test Gardener',
    description: `${testTag} Garden Repair`,
  });
  check('setup: Other expense, different description recorded', otherExpenseOther.status === 201, otherExpenseOther.body);
  if (otherExpenseOther.body?.id) createdTransactionIds.push(otherExpenseOther.body.id);

  // 10/11. Other INCOME (direction: 'Cr'), same exact description, two
  //        modes - proves the DB schema change: Other can now be Cr too,
  //        and it groups/sums across modes the same way expense does.
  const otherIncomeDesc = `${testTag} Bank Interest Credit`;
  const otherIncomeOnline = await post('/transactions', adminToken, {
    society_id: SOCIETY_ID,
    transaction_type: 'Other',
    direction: 'Cr',
    amount: 2000,
    payment_mode: 'UPI',
    utr_number: `${testTag}OTHERINC1`,
    payee_name: 'Test Bank',
    description: otherIncomeDesc,
  });
  check(
    'setup: Other income (direction=Cr, UPI) recorded',
    otherIncomeOnline.status === 201 && otherIncomeOnline.body.direction === 'Cr',
    otherIncomeOnline.body
  );
  if (otherIncomeOnline.body?.id) createdTransactionIds.push(otherIncomeOnline.body.id);

  const otherIncomeCash = await post('/transactions', adminToken, {
    society_id: SOCIETY_ID,
    transaction_type: 'Other',
    direction: 'Cr',
    amount: 150,
    payment_mode: 'Cash',
    payee_name: 'Test Bank',
    description: otherIncomeDesc,
  });
  check('setup: Other income (direction=Cr, Cash), same description recorded', otherIncomeCash.status === 201, otherIncomeCash.body);
  if (otherIncomeCash.body?.id) createdTransactionIds.push(otherIncomeCash.body.id);

  // --- Invalid direction on Other is rejected; Salary/UtilityBill force
  //     Dr regardless of what's sent (no validation error, just ignored). ---
  const invalidDirection = await post('/transactions', adminToken, {
    society_id: SOCIETY_ID,
    transaction_type: 'Other',
    direction: 'XX',
    amount: 100,
    payment_mode: 'UPI',
    utr_number: `${testTag}BADDIR`,
    payee_name: 'Test',
    description: 'bad direction',
  });
  check('an invalid direction value on Other is rejected (400)', invalidDirection.status === 400, invalidDirection.body);

  const salaryForcedDr = await post('/transactions', adminToken, {
    society_id: SOCIETY_ID,
    transaction_type: 'Salary',
    direction: 'Cr',
    amount: 111,
    payment_mode: 'UPI',
    utr_number: `${testTag}SALFORCEDR`,
    payee_name: 'Test',
    description: 'ignored direction override attempt',
  });
  check(
    'Salary always saves direction=Dr, ignoring any requested override',
    salaryForcedDr.status === 201 && salaryForcedDr.body.direction === 'Dr',
    salaryForcedDr.body
  );
  if (salaryForcedDr.body?.id) createdTransactionIds.push(salaryForcedDr.body.id);

  // Backdate every fixture's verified_at into the target month (all were
  // just auto-Verified/verified "now").
  for (const id of createdTransactionIds) {
    await backdate(id);
  }

  // --- Guard fixture: a Maintenance UPI payment left Submitted (never
  //     verified), dated inside the target month - should block POST
  //     .../month-end-closing until resolved. ---
  const blockingTxn = await post('/transactions', adminToken, {
    house_id: house.id,
    amount: MAINT_AMOUNT,
    payment_mode: 'UPI',
    utr_number: `${testTag}BLOCKING`,
    txn_date: TARGET_TXN_DATE,
  });
  check('setup: an unresolved (Submitted) Maintenance payment created for the guard test', blockingTxn.status === 201, blockingTxn.body);

  // --- Access checks ---
  check('unauthenticated GET is rejected (401)', (await get(`/society/${SOCIETY_ID}/month-end-closing`, null)).status === 401);
  check(
    'a plain resident cannot view the Month-End Closing report (403)',
    (await get(`/society/${SOCIETY_ID}/month-end-closing?month=${TARGET_MONTH}`, residentToken)).status === 403
  );
  check(
    'a plain resident cannot generate the Month-End Closing report (403)',
    (await post(`/society/${SOCIETY_ID}/month-end-closing`, residentToken, { month: TARGET_MONTH })).status === 403
  );
  check(
    'an invalid month format is rejected (400)',
    (await get(`/society/${SOCIETY_ID}/month-end-closing?month=2026-13`, adminToken)).status === 400
  );

  // --- Committee-only member: before generation, sees "not generated",
  //     no live preview. ---
  const committeeEmail = `${testTag.toLowerCase()}committee@example.com`;
  const committeePassword = `${testTag}Pass1!`;
  const committeeMember = await post('/members', adminToken, {
    society_id: SOCIETY_ID,
    email: committeeEmail,
    name: 'Test MEC Committee Member',
    password: committeePassword,
    is_committee_member: true,
  });
  check('setup: created a throwaway Committee-only member', committeeMember.status === 201, committeeMember.body);
  if (committeeMember.body?.auth_user_id) createdAuthUserIds.push(committeeMember.body.auth_user_id);
  const committeeToken = await loginToken(committeeEmail, committeePassword);

  const committeeBeforeGenerate = await get(`/society/${SOCIETY_ID}/month-end-closing?month=${TARGET_MONTH}`, committeeToken);
  check(
    "a Committee member sees generated:false with no numbers before generation",
    committeeBeforeGenerate.status === 200 &&
      committeeBeforeGenerate.body.generated === false &&
      committeeBeforeGenerate.body.incomeExpense === undefined,
    committeeBeforeGenerate.body
  );

  // --- Admin: before generation, gets a live preview AND sees the guard
  //     is blocked because of the unresolved Submitted payment above. ---
  const adminBeforeGenerate = await get(`/society/${SOCIETY_ID}/month-end-closing?month=${TARGET_MONTH}`, adminToken);
  check(
    'Admin sees a live preview (generated:false but real numbers) before generation',
    adminBeforeGenerate.status === 200 &&
      adminBeforeGenerate.body.generated === false &&
      adminBeforeGenerate.body.incomeExpense &&
      Array.isArray(adminBeforeGenerate.body.incomeExpense.rows),
    adminBeforeGenerate.body
  );
  check(
    'Admin sees guard.blocked=true (the unresolved Submitted payment)',
    adminBeforeGenerate.body.guard?.blocked === true && adminBeforeGenerate.body.guard?.blockedCount >= 1,
    adminBeforeGenerate.body.guard
  );

  // --- POST is blocked by the same guard ---
  const blockedGenerate = await post(`/society/${SOCIETY_ID}/month-end-closing`, adminToken, {
    month: TARGET_MONTH,
    bank_opening_balance: 100000,
    cash_opening_balance: 20000,
  });
  check(
    'POST .../month-end-closing is blocked (409) while the Submitted payment is unresolved',
    blockedGenerate.status === 409 && blockedGenerate.body.blockedCount >= 1,
    blockedGenerate.body
  );

  // --- Resolve the blocking transaction (reject it - keeps it out of the
  //     Verified figures entirely, so the hand-computed expectations below
  //     stay exact) ---
  const rejectRes = await post(`/transactions/${blockingTxn.body.id}/reject`, adminToken, { reason: 'test cleanup' });
  check('the blocking transaction can now be rejected', rejectRes.status === 200, rejectRes.body);

  // --- Generate: now succeeds ---
  const generateRes = await post(`/society/${SOCIETY_ID}/month-end-closing`, adminToken, {
    month: TARGET_MONTH,
    bank_opening_balance: 100000,
    cash_opening_balance: 20000,
  });
  check('POST .../month-end-closing succeeds once the guard is clear', generateRes.status === 200, generateRes.body);

  const maintenanceRow = findRow(generateRes.body.incomeExpense?.rows, 'Maintenance');
  check(
    'Maintenance row: income online=5000 (UPI), cash=5000 (Cash), no expense side',
    maintenanceRow &&
      Number(maintenanceRow.income.online) === MAINT_AMOUNT &&
      Number(maintenanceRow.income.cash) === MAINT_AMOUNT &&
      Number(maintenanceRow.expense.online) === 0 &&
      Number(maintenanceRow.expense.cash) === 0,
    maintenanceRow
  );

  const waterRow = findRow(generateRes.body.incomeExpense?.rows, 'WaterCharge');
  check(
    'WaterCharge row: income online=800, cash=300',
    waterRow && Number(waterRow.income.online) === 800 && Number(waterRow.income.cash) === 300,
    waterRow
  );

  const utilityRow = findRow(generateRes.body.incomeExpense?.rows, 'UtilityBill');
  check(
    'UtilityBill row: expense online=12000, no income side',
    utilityRow && Number(utilityRow.expense.online) === 12000 && Number(utilityRow.income.online) === 0,
    utilityRow
  );

  const salaryRow = findRow(generateRes.body.incomeExpense?.rows, 'Salary');
  check(
    'Salary row: expense cash=9000 (Cash fixture), online=111 (forced-Dr UPI fixture)',
    salaryRow && Number(salaryRow.expense.cash) === 9000 && Number(salaryRow.expense.online) === 111,
    salaryRow
  );

  const otherRow = findRow(generateRes.body.incomeExpense?.rows, 'Other');
  check(
    'Other row: income online=2000/cash=150, expense online=1200 (500+700)/cash=300',
    otherRow &&
      Number(otherRow.income.online) === 2000 &&
      Number(otherRow.income.cash) === 150 &&
      Number(otherRow.expense.online) === 1200 &&
      Number(otherRow.expense.cash) === 300,
    otherRow
  );

  const expenseGroup = findBreakdown(otherRow?.expenseBreakdown, otherExpenseDesc);
  check(
    'Other expenseBreakdown groups the two same-description rows (count=2, online=500, cash=300)',
    expenseGroup && expenseGroup.count === 2 && Number(expenseGroup.online) === 500 && Number(expenseGroup.cash) === 300,
    expenseGroup
  );

  const gardenGroup = findBreakdown(otherRow?.expenseBreakdown, `${testTag} Garden Repair`);
  check(
    'A differently-described Other expense stays its own separate group (count=1, online=700)',
    gardenGroup && gardenGroup.count === 1 && Number(gardenGroup.online) === 700,
    gardenGroup
  );

  const incomeGroup = findBreakdown(otherRow?.incomeBreakdown, otherIncomeDesc);
  check(
    'Other incomeBreakdown groups the two same-description Cr rows (count=2, online=2000, cash=150)',
    incomeGroup && incomeGroup.count === 2 && Number(incomeGroup.online) === 2000 && Number(incomeGroup.cash) === 150,
    incomeGroup
  );

  check(
    'Totals: income online=7800, income cash=5450, expense online=13311, expense cash=9300',
    Number(generateRes.body.incomeExpense.totals.income.online) === 7800 &&
      Number(generateRes.body.incomeExpense.totals.income.cash) === 5450 &&
      Number(generateRes.body.incomeExpense.totals.expense.online) === 13311 &&
      Number(generateRes.body.incomeExpense.totals.expense.cash) === 9300,
    generateRes.body.incomeExpense.totals
  );

  check(
    'Overall Total: income=13250, expense=22611',
    Number(generateRes.body.overallTotal.income) === 13250 && Number(generateRes.body.overallTotal.expense) === 22611,
    generateRes.body.overallTotal
  );

  check(
    'Closing balance: bank=100000+7800-13311=94489, cash=20000+5450-9300=16150',
    Number(generateRes.body.closingBalance.bank) === 94489 && Number(generateRes.body.closingBalance.cash) === 16150,
    generateRes.body.closingBalance
  );

  check(
    'Maintenance breakup: online=5000, cash=5000, total=10000',
    Number(generateRes.body.maintenanceBreakup.online) === 5000 &&
      Number(generateRes.body.maintenanceBreakup.cash) === 5000 &&
      Number(generateRes.body.maintenanceBreakup.total) === 10000,
    generateRes.body.maintenanceBreakup
  );

  // --- After generation: Committee now sees the saved figures ---
  const committeeAfterGenerate = await get(`/society/${SOCIETY_ID}/month-end-closing?month=${TARGET_MONTH}`, committeeToken);
  check(
    'Committee sees generated:true with matching figures after generation',
    committeeAfterGenerate.status === 200 &&
      committeeAfterGenerate.body.generated === true &&
      Number(committeeAfterGenerate.body.closingBalance.bank) === 94489 &&
      Number(committeeAfterGenerate.body.openingBalance.bank) === 100000,
    committeeAfterGenerate.body
  );

  // --- Admin re-run without an override reuses the saved opening balance
  //     (idempotent - Verified figures are unchanged, so the result is
  //     identical) ---
  const regenerateRes = await post(`/society/${SOCIETY_ID}/month-end-closing`, adminToken, { month: TARGET_MONTH });
  check(
    'Re-running generation with no override reuses the saved opening balance',
    regenerateRes.status === 200 &&
      regenerateRes.body.openingBalance.source === 'saved' &&
      Number(regenerateRes.body.openingBalance.bank) === 100000 &&
      Number(regenerateRes.body.closingBalance.bank) === 94489,
    regenerateRes.body
  );

  // --- Admin GET after generation: guard now clear ---
  const adminAfterGenerate = await get(`/society/${SOCIETY_ID}/month-end-closing?month=${TARGET_MONTH}`, adminToken);
  check(
    'Admin GET after generation: guard.blocked=false now that the Submitted payment was resolved',
    adminAfterGenerate.body.guard?.blocked === false,
    adminAfterGenerate.body.guard
  );

  // --- A month with no transactions at all still generates cleanly (all
  //     zeroes, no crash on empty breakdowns) ---
  const emptyMonth = monthString(31);
  const emptyGenerate = await post(`/society/${SOCIETY_ID}/month-end-closing`, adminToken, {
    month: emptyMonth,
    bank_opening_balance: 500,
    cash_opening_balance: 200,
  });
  check(
    'A month with zero transactions generates cleanly with unchanged balances',
    emptyGenerate.status === 200 &&
      Number(emptyGenerate.body.closingBalance.bank) === 500 &&
      Number(emptyGenerate.body.closingBalance.cash) === 200,
    emptyGenerate.body
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // --- Cleanup ---
  await supabaseAdmin.from('society_month_closings').delete().eq('society_id', SOCIETY_ID).eq('month', `${TARGET_MONTH}-01`);
  await supabaseAdmin.from('society_month_closings').delete().eq('society_id', SOCIETY_ID).eq('month', `${emptyMonth}-01`);
  const allTxnIds = [...createdTransactionIds, blockingTxn.body?.id].filter(Boolean);
  for (const id of allTxnIds) {
    await supabaseAdmin.from('audit_events').delete().eq('entity_id', id);
    await supabaseAdmin.from('transaction_allocations').delete().eq('transaction_id', id);
  }
  await supabaseAdmin.from('transactions').delete().in('id', allTxnIds);
  for (const authUserId of createdAuthUserIds) {
    await supabaseAdmin.auth.admin.deleteUser(authUserId);
  }
  for (const houseId of createdHouseIds) {
    await supabaseAdmin.from('houses').delete().eq('id', houseId);
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
