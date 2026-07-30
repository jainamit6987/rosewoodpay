// Verifies GET /me's hasPendingSubmission flag on openBillingPeriods: a
// period stays 'Open' (and so still appears here) right up until a payment
// against it is actually Verified, so the mobile dues screen needs some way
// to tell "still genuinely payable" apart from "already has a Submitted
// payment sitting in the review queue" - otherwise a resident could submit
// a second payment against the exact same period while the first is still
// awaiting an Admin's decision.
//
// Uses a throwaway house + assignment rather than a seeded one: the real
// seeded house A-101 already carries a live, hand-submitted Submitted
// transaction from manual UI testing (utr "dummy utr 1") that must not be
// touched here - it is real pending data, not test fixture noise, and the
// user has separately asked to hold off on any data changes while they
// prepare a reseed. A throwaway house guarantees a clean baseline without
// touching anything seeded.
// Requires the server running (npm run dev) and the seed fixtures from
// supabase/seed.sql (resident@society.app's own society_member id, used to
// grant them an Active assignment to the throwaway house).
// Run with: node scripts/test-me-pending-submission.js
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
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function findPeriod(meBody, periodId) {
  for (const membership of meBody.memberships || []) {
    const found = (membership.openBillingPeriods || []).find((p) => p.id === periodId);
    if (found) return found;
  }
  return null;
}

async function main() {
  const residentToken = await loginToken('resident@society.app', 'password');
  const adminToken = await loginToken('admin@society.app', 'password');

  // --- Setup: a throwaway house, actively assigned to the seeded resident,
  //     with one clean Open period - isolated from any real seeded/live
  //     data so the "before any payment" assertion below is guaranteed
  //     true rather than assumed. ---
  const throwawayTag = `TESTMEPENDING${Date.now()}`.slice(0, 20);
  const { data: throwawayHouse, error: houseInsertError } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: SOCIETY_ID, house_number: throwawayTag, type: 'Flat', default_monthly_amount: 2200 })
    .select('id')
    .single();
  if (houseInsertError) {
    console.error('setup failed: could not create throwaway house', houseInsertError.message);
    process.exit(1);
  }

  const { error: assignmentInsertError } = await supabaseAdmin.from('resident_house_assignments').insert({
    society_member_id: RESIDENT_MEMBER_ID,
    house_id: throwawayHouse.id,
    status: 'Active',
    approved_at: new Date().toISOString(),
  });
  if (assignmentInsertError) {
    console.error('setup failed: could not create throwaway assignment', assignmentInsertError.message);
    process.exit(1);
  }

  const currentMonth = new Date();
  const periodMonth = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  const { data: throwawayPeriod, error: periodInsertError } = await supabaseAdmin
    .from('billing_periods')
    .insert({
      society_id: SOCIETY_ID,
      house_id: throwawayHouse.id,
      period_month: periodMonth,
      base_amount: 2200,
      amount_due: 2200,
      status: 'Open',
    })
    .select('id')
    .single();
  if (periodInsertError) {
    console.error('setup failed: could not create throwaway period', periodInsertError.message);
    process.exit(1);
  }

  const meBefore = await get('/me', residentToken);
  const targetPeriod = findPeriod(meBefore.body, throwawayPeriod.id);

  check(
    'setup: resident now sees the throwaway Open billing period via /me',
    meBefore.status === 200 && !!targetPeriod,
    meBefore.body
  );
  if (!targetPeriod) {
    console.log('\nAborting - setup precondition not met.');
    process.exit(1);
  }

  check(
    'before any payment, that period is not flagged as having a pending submission',
    targetPeriod.hasPendingSubmission === false,
    targetPeriod
  );

  const testUtr = `TESTMEPENDING${Date.now()}`;
  const payment = await post('/transactions', residentToken, {
    house_id: throwawayHouse.id,
    amount: Number(targetPeriod.amount_due),
    utr_number: testUtr,
  });
  check('setup: payment against that period submitted (201)', payment.status === 201, payment.body);

  const meAfterSubmit = await get('/me', residentToken);
  const periodAfterSubmit = findPeriod(meAfterSubmit.body, targetPeriod.id);
  check(
    'once a Submitted payment covers it, the period is flagged hasPendingSubmission=true (and remains Open, not removed)',
    !!periodAfterSubmit && periodAfterSubmit.hasPendingSubmission === true,
    periodAfterSubmit
  );

  const reject = await post(`/transactions/${payment.body.id}/reject`, adminToken, {
    reason: 'test-me-pending-submission cleanup',
  });
  check('setup: that payment is rejected (200)', reject.status === 200, reject.body);

  const meAfterReject = await get('/me', residentToken);
  const periodAfterReject = findPeriod(meAfterReject.body, targetPeriod.id);
  check(
    'once rejected, the flag clears again - the period is selectable/payable once more',
    !!periodAfterReject && periodAfterReject.hasPendingSubmission === false,
    periodAfterReject
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // Delete the transaction first (cascades away its transaction_allocations
  // row via ON DELETE CASCADE on transaction_id) before deleting the house.
  // Order matters: transaction_allocations.billing_period_id is ON DELETE
  // RESTRICT by design (you can't delete a billing period that still has
  // payment history), and Postgres does not guarantee that the
  // houses -> transactions -> transaction_allocations cascade path runs
  // before the parallel houses -> billing_periods one within a single
  // statement - deleting the house first can hit that RESTRICT and leave
  // everything behind. See also the identical two-step cleanup in
  // test-pending-transactions.js and test-verify-reject.js.
  await supabaseAdmin.from('transactions').delete().like('utr_number', 'TESTMEPENDING%');
  await supabaseAdmin.from('houses').delete().eq('id', throwawayHouse.id);

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
