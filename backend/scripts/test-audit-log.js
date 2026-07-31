// Verifies GET /society/:id/audit-log?entity_type=&entity_id=&action=&actor_user_id=&from=&to=
// (backend/src/routes/society.js): Admin/Committee read-back of the
// audit_events table, which every prior feature (members, assignments,
// billing periods, transactions, society edits) has been writing to since
// the very first migration with nothing ever reading it back. Requires the
// server running (npm run dev). Uses the waive-billing-period action (a
// simple, already-built, single-insert audit event) as its own known-good
// fixture generator rather than depending on whatever audit history happens
// to already exist in the connected project.
// Run with: node scripts/test-audit-log.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const SOCIETY_ID = '00000003-0000-0000-0000-000000000003';
const ADMIN_USER_ID = '00000001-0000-0000-0000-000000000001';

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

async function makeThrowawayOpenPeriod(tag) {
  const { data: house, error: houseError } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: SOCIETY_ID, house_number: tag, type: 'Flat', default_monthly_amount: 1500 })
    .select('id')
    .single();
  if (houseError) throw new Error(`setup failed: could not create throwaway house: ${houseError.message}`);

  const now = new Date();
  const periodMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const { data: period, error: periodError } = await supabaseAdmin
    .from('billing_periods')
    .insert({
      society_id: SOCIETY_ID,
      house_id: house.id,
      period_month: periodMonth,
      base_amount: 1500,
      amount_due: 1500,
      status: 'Open',
    })
    .select('id')
    .single();
  if (periodError) throw new Error(`setup failed: could not create throwaway billing period: ${periodError.message}`);

  return { houseId: house.id, periodId: period.id };
}

async function main() {
  const residentToken = await loginToken('resident@society.app', 'password');
  const adminToken = await loginToken('admin@society.app', 'password');
  const testTag = `TESTAUDIT${Date.now()}`;
  const committeeEmail = `${testTag.toLowerCase()}committee@example.com`;
  const committeePassword = `Test${Date.now()}Pw!`;
  const createdAuthUserIds = [];
  const createdHouseIds = [];

  // --- Setup: two throwaway houses, each waived in sequence via the
  //     already-built waive endpoint - a real, known-good way to produce two
  //     distinct, orderable audit_events rows without depending on whatever
  //     history already exists in the connected project. ---
  const shortTag = testTag.slice(0, 18);
  const first = await makeThrowawayOpenPeriod(`${shortTag}A`);
  const second = await makeThrowawayOpenPeriod(`${shortTag}B`);
  createdHouseIds.push(first.houseId, second.houseId);

  const firstWaive = await post(`/houses/${first.houseId}/billing-periods/${first.periodId}/waive`, adminToken, {
    reason: 'Audit log test fixture #1',
  });
  const secondWaive = await post(`/houses/${second.houseId}/billing-periods/${second.periodId}/waive`, adminToken, {
    reason: 'Audit log test fixture #2',
  });
  check(
    'setup: two throwaway billing periods successfully waived (generating two ordered audit events)',
    firstWaive.status === 200 && secondWaive.status === 200,
    { firstWaive: firstWaive.body, secondWaive: secondWaive.body }
  );

  // --- Unauthenticated is rejected ---
  check(
    'unauthenticated GET is rejected (401)',
    (await get(`/society/${SOCIETY_ID}/audit-log`, null)).status === 401
  );

  // --- A plain resident cannot view the audit log ---
  check(
    'a plain resident cannot view the audit log (403)',
    (await get(`/society/${SOCIETY_ID}/audit-log`, residentToken)).status === 403
  );

  // --- Invalid filter values are rejected ---
  check(
    'an unrecognized entity_type is rejected (400)',
    (await get(`/society/${SOCIETY_ID}/audit-log?entity_type=nonsense`, adminToken)).status === 400
  );
  check(
    'an unrecognized action is rejected (400)',
    (await get(`/society/${SOCIETY_ID}/audit-log?action=nonsense`, adminToken)).status === 400
  );
  check(
    'a malformed entity_id (not a UUID) is rejected (400)',
    (await get(`/society/${SOCIETY_ID}/audit-log?entity_id=not-a-uuid`, adminToken)).status === 400
  );
  check(
    'a malformed actor_user_id (not a UUID) is rejected (400)',
    (await get(`/society/${SOCIETY_ID}/audit-log?actor_user_id=not-a-uuid`, adminToken)).status === 400
  );
  check(
    'an invalid from date is rejected (400)',
    (await get(`/society/${SOCIETY_ID}/audit-log?from=notadate`, adminToken)).status === 400
  );
  check(
    'an invalid to date is rejected (400)',
    (await get(`/society/${SOCIETY_ID}/audit-log?to=notadate`, adminToken)).status === 400
  );

  // --- entity_type + entity_id + action together find exactly the one
  //     fixture event, with the actor and reason correctly recorded ---
  const firstEventView = await get(
    `/society/${SOCIETY_ID}/audit-log?entity_type=billing_period&action=Waived&entity_id=${first.periodId}`,
    adminToken
  );
  check(
    'entity_type + entity_id + action together find exactly the one matching event',
    firstEventView.status === 200 &&
      Array.isArray(firstEventView.body) &&
      firstEventView.body.length === 1 &&
      firstEventView.body[0].actor_user_id === ADMIN_USER_ID &&
      firstEventView.body[0].metadata?.reason === 'Audit log test fixture #1',
    firstEventView.body
  );

  // --- Both fixture events show up together under a shared filter, newest
  //     first - the second waive (fired after the first) appears before it ---
  const bothEventsView = await get(
    `/society/${SOCIETY_ID}/audit-log?entity_type=billing_period&action=Waived`,
    adminToken
  );
  const ids = (bothEventsView.body || []).map((e) => e.entity_id);
  const firstIndex = ids.indexOf(first.periodId);
  const secondIndex = ids.indexOf(second.periodId);
  check(
    'both fixture events appear under a shared filter, ordered newest-first (second waive before the first)',
    bothEventsView.status === 200 &&
      firstIndex !== -1 &&
      secondIndex !== -1 &&
      secondIndex < firstIndex,
    { ids, firstIndex, secondIndex }
  );

  // --- actor_user_id filter: every event returned actually has that actor ---
  const actorView = await get(
    `/society/${SOCIETY_ID}/audit-log?actor_user_id=${ADMIN_USER_ID}&entity_type=billing_period&action=Waived`,
    adminToken
  );
  check(
    'actor_user_id filter narrows to only that actor\'s events (the filter is real, not decorative)',
    actorView.status === 200 &&
      Array.isArray(actorView.body) &&
      actorView.body.length >= 2 &&
      actorView.body.every((e) => e.actor_user_id === ADMIN_USER_ID),
    actorView.body
  );

  // --- A from= date far in the future returns an empty array, not an error ---
  const farFutureView = await get(`/society/${SOCIETY_ID}/audit-log?from=2099-01-01`, adminToken);
  check(
    'a from= date far in the future returns an empty array (not an error)',
    farFutureView.status === 200 && Array.isArray(farFutureView.body) && farFutureView.body.length === 0,
    farFutureView.body
  );

  // --- No filters at all returns the whole society's log, including both
  //     fixture events ---
  const fullLog = await get(`/society/${SOCIETY_ID}/audit-log`, adminToken);
  const fullLogIds = (fullLog.body || []).map((e) => e.entity_id);
  check(
    'omitting every filter returns the whole society log, including both fixture events',
    fullLog.status === 200 &&
      fullLogIds.includes(first.periodId) &&
      fullLogIds.includes(second.periodId),
    { status: fullLog.status, count: (fullLog.body || []).length }
  );

  // --- A Committee-only member (no is_admin) can view this too, same
  //     Admin-or-Committee split as every other report in this file ---
  const committeeMember = await post('/members', adminToken, {
    society_id: SOCIETY_ID,
    email: committeeEmail,
    name: 'Test Committee Member',
    password: committeePassword,
    is_committee_member: true,
  });
  check(
    'setup: created a throwaway Committee-only member',
    committeeMember.status === 201 && committeeMember.body.is_committee_member === true,
    committeeMember.body
  );
  if (committeeMember.body.auth_user_id) createdAuthUserIds.push(committeeMember.body.auth_user_id);

  const committeeToken = await loginToken(committeeEmail, committeePassword);
  const committeeView = await get(`/society/${SOCIETY_ID}/audit-log`, committeeToken);
  check(
    'a Committee-only member CAN view the audit log (200)',
    committeeView.status === 200 && Array.isArray(committeeView.body),
    committeeView.body
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // Cleanup: deleting each throwaway house cascades to its billing_periods;
  // deleting the throwaway auth user cascades its society_members row.
  for (const houseId of createdHouseIds) {
    await supabaseAdmin.from('houses').delete().eq('id', houseId);
  }
  for (const authUserId of createdAuthUserIds) {
    await supabaseAdmin.auth.admin.deleteUser(authUserId);
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
