// Verifies GET /houses/:houseId/transactions/:transactionId/receipt
// (backend/src/routes/houses.js) - the WaterCharge counterpart of
// test-maintenance-receipt.js's own billing-period receipt, but sourced
// directly from a transaction row since WaterCharge has no billing_periods
// row behind it at all (see
// 20260803000000_add_water_charge_transaction_type.sql).
//
// Same live-DB fixture-resolution approach as test-maintenance-receipt.js -
// does NOT hardcode the old admin@society.app/resident@society.app/password
// fixture logins (drifted since the Rosewood Century reseed), instead reads
// whichever Active Admin/plain-resident currently exist straight from the
// live DB via the service-role client, logging in with the reseed's own
// password123. Runs entirely against one disposable throwaway house
// (created and deleted by this script).
//
// Requires: the server running (npm run dev).
// Run with: node scripts/test-watercharge-receipt.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const SEED_PASSWORD = 'password123';
const FAKE_ID = '00000000-aaaa-bbbb-cccc-000000000000';

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

async function post(path, token, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// Same live-DB lookup as test-maintenance-receipt.js's own
// findActiveAdminAndResident.
async function findActiveAdminAndResident() {
  const { data: admins } = await supabaseAdmin
    .from('society_members')
    .select('id, society_id, auth_user_id, status')
    .eq('is_admin', true)
    .eq('status', 'Active')
    .limit(1);
  if (!admins || admins.length === 0) throw new Error('setup: no Active Admin found in the DB to test against.');
  const admin = admins[0];

  const { data: residents } = await supabaseAdmin
    .from('society_members')
    .select('id, society_id, auth_user_id, status')
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
    residentMemberId: residents[0].id,
    residentEmail: emailById.get(residents[0].auth_user_id),
  };
}

async function main() {
  const { societyId, adminEmail, residentMemberId, residentEmail } = await findActiveAdminAndResident();
  const residentToken = await loginToken(residentEmail, SEED_PASSWORD);
  const adminToken = await loginToken(adminEmail, SEED_PASSWORD);

  // --- Isolated throwaway house on the resolved Admin's real society, same
  //     pattern as test-maintenance-receipt.js's own throwaway fixture. ---
  const tag = `TESTWCRCPT${Date.now()}`.slice(0, 20);
  const { data: house } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: societyId, house_number: tag, type: 'Flat', default_monthly_amount: 2500 })
    .select('id')
    .single();
  await supabaseAdmin.from('resident_house_assignments').insert({
    society_member_id: residentMemberId,
    house_id: house.id,
    relationship_type: 'Owner',
    status: 'Active',
    approved_at: new Date().toISOString(),
  });

  // --- Unauthenticated / not-found guards ---
  check(
    'unauthenticated GET receipt is rejected (401)',
    (await get(`/houses/${house.id}/transactions/${FAKE_ID}/receipt`, null)).status === 401
  );
  const missingTxn = await get(`/houses/${house.id}/transactions/${FAKE_ID}/receipt`, adminToken);
  check('a nonexistent transaction id returns 404', missingTxn.status === 404, missingTxn.body);

  // --- Submit a WaterCharge payment (UPI self-report) - Pending Approval ---
  const utr1 = `TESTWCRCPT1${Date.now()}`;
  const submit1 = await post('/transactions', residentToken, {
    house_id: house.id,
    amount: 350,
    transaction_type: 'WaterCharge',
    payment_mode: 'UPI',
    utr_number: utr1,
  });
  check('setup: first WaterCharge payment submitted (201)', submit1.status === 201, submit1.body);

  const pendingReceipt = await get(`/houses/${house.id}/transactions/${submit1.body.id}/receipt`, residentToken);
  check(
    'Submitted WaterCharge payment -> receipt status is "Pending Approval"',
    pendingReceipt.status === 200 && pendingReceipt.body.status === 'Pending Approval',
    pendingReceipt.body
  );
  check(
    'Pending receipt carries the right amount/paymentMode/refNo/houseNumber/societyName, no description',
    pendingReceipt.body.amount === 350 &&
      pendingReceipt.body.paymentMode === 'UPI' &&
      pendingReceipt.body.refNo === utr1 &&
      pendingReceipt.body.houseNumber === tag &&
      pendingReceipt.body.description === null &&
      typeof pendingReceipt.body.societyName === 'string' &&
      pendingReceipt.body.societyName.length > 0 &&
      !!pendingReceipt.body.residentName,
    pendingReceipt.body
  );
  check('Pending receipt has no receivedBy yet', pendingReceipt.body.receivedBy === null, pendingReceipt.body);

  // --- Admin rejects it - Rejected receipt with reason, resident-visible ---
  const rejectionReason = 'UTR does not match any bank statement entry - test-watercharge-receipt';
  const reject = await post(`/transactions/${submit1.body.id}/reject`, adminToken, { reason: rejectionReason });
  check('setup: first WaterCharge payment rejected (200)', reject.status === 200, reject.body);

  const rejectedReceipt = await get(`/houses/${house.id}/transactions/${submit1.body.id}/receipt`, residentToken);
  check(
    'Rejected payment -> receipt status is "Rejected" with the resident-visible reason',
    rejectedReceipt.status === 200 &&
      rejectedReceipt.body.status === 'Rejected' &&
      rejectedReceipt.body.rejectionReason === rejectionReason,
    rejectedReceipt.body
  );

  // --- A second WaterCharge payment, this time with a free-text
  //     description, verified by the Admin - Approved receipt including it ---
  const utr2 = `TESTWCRCPT2${Date.now()}`;
  const description = 'Extra tanker water during pipeline repair';
  const submit2 = await post('/transactions', residentToken, {
    house_id: house.id,
    amount: 500,
    transaction_type: 'WaterCharge',
    payment_mode: 'NEFT_IMPS',
    utr_number: utr2,
    description,
  });
  check('setup: second WaterCharge payment submitted (201)', submit2.status === 201, submit2.body);

  const verify = await post(`/transactions/${submit2.body.id}/verify`, adminToken);
  check('setup: second WaterCharge payment verified (200)', verify.status === 200, verify.body);

  const approvedReceipt = await get(`/houses/${house.id}/transactions/${submit2.body.id}/receipt`, residentToken);
  check(
    'Verified payment -> receipt status is "Approved" with its own amount/paymentMode/refNo/description',
    approvedReceipt.status === 200 &&
      approvedReceipt.body.status === 'Approved' &&
      approvedReceipt.body.amount === 500 &&
      approvedReceipt.body.paymentMode === 'NEFT_IMPS' &&
      approvedReceipt.body.refNo === utr2 &&
      approvedReceipt.body.description === description &&
      approvedReceipt.body.rejectionReason === null,
    approvedReceipt.body
  );
  check('Approved receipt has a receivedBy name', !!approvedReceipt.body.receivedBy, approvedReceipt.body);

  // --- The first (Rejected) transaction's own receipt is unaffected by the
  //     second, independent payment - each WaterCharge transaction is its
  //     own standalone receipt, never merged/overwritten like a billing
  //     period's "latest wins" rule. ---
  const rejectedStillRejected = await get(`/houses/${house.id}/transactions/${submit1.body.id}/receipt`, residentToken);
  check(
    "the first transaction's own receipt still independently shows Rejected, unaffected by the second payment",
    rejectedStillRejected.status === 200 && rejectedStillRejected.body.status === 'Rejected',
    rejectedStillRejected.body
  );

  // Admin (not the resident who submitted it) can view the same receipt too.
  const adminView = await get(`/houses/${house.id}/transactions/${submit2.body.id}/receipt`, adminToken);
  check(
    'Admin can also view the same receipt',
    adminView.status === 200 && adminView.body.status === 'Approved',
    adminView.body
  );

  // --- A Maintenance transaction's receipt is NOT available from this
  //     endpoint - it has its own, more correct, per-period receipt path. ---
  const currentMonth = new Date();
  const periodMonth = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  await supabaseAdmin.from('billing_periods').insert({
    society_id: societyId,
    house_id: house.id,
    period_month: periodMonth,
    base_amount: 2500,
    amount_due: 2500,
    status: 'Open',
  });
  const maintenanceUtr = `TESTWCRCPTMAINT${Date.now()}`;
  const maintenanceSubmit = await post('/transactions', residentToken, {
    house_id: house.id,
    amount: 2500,
    utr_number: maintenanceUtr,
  });
  check('setup: a Maintenance payment submitted on the same house (201)', maintenanceSubmit.status === 201, maintenanceSubmit.body);

  const wrongTypeReceipt = await get(
    `/houses/${house.id}/transactions/${maintenanceSubmit.body.id}/receipt`,
    residentToken
  );
  check(
    "a Maintenance transaction's receipt is NOT served here (404) - it belongs to its own billing-period receipt route",
    wrongTypeReceipt.status === 404,
    wrongTypeReceipt.body
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // Delete transactions before the house/assignment - transaction_allocations
  // .billing_period_id is ON DELETE RESTRICT (see test-maintenance-receipt.js
  // / test-billing-history.js).
  await supabaseAdmin.from('transactions').delete().like('utr_number', 'TESTWCRCPT%');
  await supabaseAdmin.from('houses').delete().eq('id', house.id);

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
