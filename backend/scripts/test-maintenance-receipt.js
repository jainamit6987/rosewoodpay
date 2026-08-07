// Verifies GET /houses/:houseId/billing-periods/:periodId/receipt and the
// new latestPaymentStatus flag on GET /houses/:houseId/billing-periods
// (both in backend/src/routes/houses.js), plus the new
// transactions.rejection_reason column being resident-readable through it.
//
// Does NOT hardcode the old admin@society.app/resident@society.app/password
// fixture logins - those drifted since the Rosewood Century reseed (see
// Society_App_Progress_Log.md) and are left intentionally broken on every
// older test-*.js script per the user's own earlier call. Instead reads
// whichever Active Admin/plain-resident currently exist straight from the
// live DB via the service-role client, same convention as
// test-reset-password.js/test-available-to-rent.js, logging in with the
// reseed's own password123. Runs entirely against one disposable throwaway
// house (created and deleted by this script) attached to the resolved
// Admin's own real society - never touches any real seeded house/resident/
// transaction.
//
// Requires: the server running (npm run dev), AND
// 20260807010000_add_rejection_reason_to_transactions.sql already applied.
// Run with: node scripts/test-maintenance-receipt.js
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

function periodOf(billingPeriodsBody, periodId) {
  return (billingPeriodsBody || []).find((p) => p.id === periodId);
}

// Same live-DB lookup as test-reset-password.js's own findActiveAdminAndResident.
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
  //     pattern as test-available-to-rent.js's own throwaway fixtures. ---
  const tag = `TESTRECEIPT${Date.now()}`.slice(0, 20);
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
  const currentMonth = new Date();
  const periodMonth = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  const { data: period } = await supabaseAdmin
    .from('billing_periods')
    .insert({
      society_id: societyId,
      house_id: house.id,
      period_month: periodMonth,
      base_amount: 2500,
      amount_due: 2500,
      status: 'Open',
    })
    .select('id')
    .single();

  // --- Unauthenticated / not-found guards ---
  check(
    'unauthenticated GET receipt is rejected (401)',
    (await get(`/houses/${house.id}/billing-periods/${period.id}/receipt`, null)).status === 401
  );
  const missingPeriod = await get(`/houses/${house.id}/billing-periods/${FAKE_ID}/receipt`, adminToken);
  check('a nonexistent period id returns 404', missingPeriod.status === 404, missingPeriod.body);

  // --- Before any payment: no receipt yet, latestPaymentStatus null ---
  const beforePayment = await get(`/houses/${house.id}/billing-periods/${period.id}/receipt`, residentToken);
  check(
    'before any payment, GET receipt is a 404 (nothing to show yet)',
    beforePayment.status === 404,
    beforePayment.body
  );
  const listBefore = await get(`/houses/${house.id}/billing-periods`, residentToken);
  check(
    'before any payment, latestPaymentStatus is null on the list endpoint',
    periodOf(listBefore.body, period.id)?.latestPaymentStatus === null,
    listBefore.body
  );

  // --- Submit a payment (UPI, default mode) - Pending Approval receipt ---
  const utr1 = `TESTRECEIPT1${Date.now()}`;
  const submit1 = await post('/transactions', residentToken, {
    house_id: house.id,
    amount: 2500,
    utr_number: utr1,
  });
  check('setup: first payment submitted (201)', submit1.status === 201, submit1.body);

  const pendingReceipt = await get(`/houses/${house.id}/billing-periods/${period.id}/receipt`, residentToken);
  check(
    'Submitted payment -> receipt status is "Pending Approval"',
    pendingReceipt.status === 200 && pendingReceipt.body.status === 'Pending Approval',
    pendingReceipt.body
  );
  check(
    'Pending receipt carries the right amount/paymentMode/refNo/houseNumber/societyName',
    pendingReceipt.body.amount === 2500 &&
      pendingReceipt.body.paymentMode === 'UPI' &&
      pendingReceipt.body.refNo === utr1 &&
      pendingReceipt.body.houseNumber === tag &&
      typeof pendingReceipt.body.societyName === 'string' &&
      pendingReceipt.body.societyName.length > 0 &&
      !!pendingReceipt.body.residentName,
    pendingReceipt.body
  );
  check('Pending receipt has no receivedBy yet', pendingReceipt.body.receivedBy === null, pendingReceipt.body);

  const listPending = await get(`/houses/${house.id}/billing-periods`, residentToken);
  check(
    'latestPaymentStatus is "Submitted" while pending',
    periodOf(listPending.body, period.id)?.latestPaymentStatus === 'Submitted',
    listPending.body
  );

  // --- Admin rejects it - Rejected receipt with reason, resident-visible ---
  const rejectionReason = 'UTR does not match any bank statement entry - test-maintenance-receipt';
  const reject = await post(`/transactions/${submit1.body.id}/reject`, adminToken, { reason: rejectionReason });
  check('setup: first payment rejected (200)', reject.status === 200, reject.body);
  check(
    'the reject response itself now carries rejection_reason',
    reject.body.rejection_reason === rejectionReason,
    reject.body
  );

  const rejectedReceipt = await get(`/houses/${house.id}/billing-periods/${period.id}/receipt`, residentToken);
  check(
    'Rejected payment -> receipt status is "Rejected" with the resident-visible reason',
    rejectedReceipt.status === 200 &&
      rejectedReceipt.body.status === 'Rejected' &&
      rejectedReceipt.body.rejectionReason === rejectionReason,
    rejectedReceipt.body
  );

  const listRejected = await get(`/houses/${house.id}/billing-periods`, residentToken);
  const rejectedPeriodEntry = periodOf(listRejected.body, period.id);
  check(
    'latestPaymentStatus is "Rejected", period status stays "Open"',
    rejectedPeriodEntry?.latestPaymentStatus === 'Rejected' && rejectedPeriodEntry?.status === 'Open',
    listRejected.body
  );

  // --- Resident resubmits (same still-Open period, FIFO picks it again) and
  //     Admin verifies it - Approved receipt should now win over the
  //     earlier Rejected attempt (PAYMENT_STATUS_PRIORITY). ---
  const utr2 = `TESTRECEIPT2${Date.now()}`;
  const submit2 = await post('/transactions', residentToken, {
    house_id: house.id,
    amount: 2500,
    utr_number: utr2,
    payment_mode: 'NEFT_IMPS',
  });
  check('setup: second payment submitted (201)', submit2.status === 201, submit2.body);

  const verify = await post(`/transactions/${submit2.body.id}/verify`, adminToken);
  check('setup: second payment verified (200)', verify.status === 200, verify.body);

  const approvedReceipt = await get(`/houses/${house.id}/billing-periods/${period.id}/receipt`, residentToken);
  check(
    'Verified payment wins over the earlier Rejected one -> receipt status is "Approved"',
    approvedReceipt.status === 200 && approvedReceipt.body.status === 'Approved',
    approvedReceipt.body
  );
  check(
    'Approved receipt shows the SECOND payment\'s own details (NEFT/IMPS, new ref no), not the rejected one\'s',
    approvedReceipt.body.paymentMode === 'NEFT_IMPS' &&
      approvedReceipt.body.refNo === utr2 &&
      approvedReceipt.body.rejectionReason === null,
    approvedReceipt.body
  );
  check('Approved receipt has a receivedBy name', !!approvedReceipt.body.receivedBy, approvedReceipt.body);

  const listApproved = await get(`/houses/${house.id}/billing-periods`, residentToken);
  const approvedPeriodEntry = periodOf(listApproved.body, period.id);
  check(
    'latestPaymentStatus is "Verified" and the period itself is now "Closed"',
    approvedPeriodEntry?.latestPaymentStatus === 'Verified' && approvedPeriodEntry?.status === 'Closed',
    listApproved.body
  );

  // Admin (not the resident who submitted it) can view the same receipt too.
  const adminView = await get(`/houses/${house.id}/billing-periods/${period.id}/receipt`, adminToken);
  check('Admin can also view the same receipt', adminView.status === 200 && adminView.body.status === 'Approved', adminView.body);

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // Delete transactions before the house/assignment - transaction_allocations
  // .billing_period_id is ON DELETE RESTRICT (see test-billing-history.js).
  await supabaseAdmin.from('transactions').delete().like('utr_number', 'TESTRECEIPT%');
  await supabaseAdmin.from('houses').delete().eq('id', house.id);

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
