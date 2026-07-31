// Verifies GET/PATCH /society (backend/src/routes/society.js): Admin/
// Committee can view society settings, only Admin can edit them, and every
// edit is validated and audited. Requires the server running (npm run dev).
// Run with: node scripts/test-society.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const SOCIETY_ID = '00000003-0000-0000-0000-000000000003';

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

async function request(method, path, token, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

const get = (path, token) => request('GET', path, token);
const post = (path, token, body) => request('POST', path, token, body || {});
const patch = (path, token, body) => request('PATCH', path, token, body || {});

async function main() {
  const testStartedAt = new Date().toISOString();
  const residentToken = await loginToken('resident@society.app', 'password');
  const adminToken = await loginToken('admin@society.app', 'password');
  const testTag = `TESTSOCIETY${Date.now()}`;
  const committeeEmail = `${testTag.toLowerCase()}committee@example.com`;
  const committeePassword = `Test${Date.now()}Pw!`;

  const createdAuthUserIds = [];
  const createdMemberIds = [];

  // --- Unauthenticated is rejected everywhere ---
  check('unauthenticated GET /society is rejected (401)', (await get('/society', null)).status === 401);
  check(
    'unauthenticated PATCH /society/:id is rejected (401)',
    (await patch(`/society/${SOCIETY_ID}`, null, {})).status === 401
  );

  // --- A plain resident (no admin/committee flags) can neither view nor edit ---
  check('a plain resident cannot view society settings (403)', (await get('/society', residentToken)).status === 403);
  check(
    'a plain resident cannot edit society settings (403)',
    (await patch(`/society/${SOCIETY_ID}`, residentToken, { name: 'Hacked Name' })).status === 403
  );

  // --- Admin can view, sees the real seeded fields ---
  const adminView = await get('/society', adminToken);
  const seededSociety = (adminView.body || []).find((s) => s.id === SOCIETY_ID);
  check(
    'Admin can view society settings (200), sees the seeded society with real fields',
    adminView.status === 200 && !!seededSociety && seededSociety.name === 'Orchid Meadows' && seededSociety.upi_vpa === 'orchidmeadows@upi',
    seededSociety
  );

  // --- Set up a throwaway Committee-only member (no seeded fixture has
  // is_committee_member=true with is_admin=false) to prove "Committee can
  // view, cannot edit" is a real distinction, not just "Admin-or-Committee
  // both do everything". ---
  const committeeMember = await post('/members', adminToken, {
    society_id: SOCIETY_ID,
    email: committeeEmail,
    name: 'Test Committee Member',
    password: committeePassword,
    is_committee_member: true,
  });
  check(
    'setup: created a throwaway Committee-only member',
    committeeMember.status === 201 && committeeMember.body.is_committee_member === true && committeeMember.body.is_admin === false,
    committeeMember.body
  );
  if (committeeMember.body.id) createdMemberIds.push(committeeMember.body.id);
  if (committeeMember.body.auth_user_id) createdAuthUserIds.push(committeeMember.body.auth_user_id);

  const committeeToken = await loginToken(committeeEmail, committeePassword);
  const committeeView = await get('/society', committeeToken);
  check(
    'a Committee-only member CAN view society settings (200)',
    committeeView.status === 200 && (committeeView.body || []).some((s) => s.id === SOCIETY_ID),
    committeeView.body
  );
  const committeeEdit = await patch(`/society/${SOCIETY_ID}`, committeeToken, { name: 'Committee Should Not Be Able To Do This' });
  check('a Committee-only member CANNOT edit society settings (403)', committeeEdit.status === 403, committeeEdit);

  // --- Validation ---
  check('PATCH with no fields is rejected (400)', (await patch(`/society/${SOCIETY_ID}`, adminToken, {})).status === 400);
  check(
    'an empty name is rejected (400)',
    (await patch(`/society/${SOCIETY_ID}`, adminToken, { name: '   ' })).status === 400
  );
  check(
    'a malformed upi_vpa is rejected (400)',
    (await patch(`/society/${SOCIETY_ID}`, adminToken, { upi_vpa: 'not-a-vpa' })).status === 400
  );
  check(
    'an invalid timezone is rejected (400)',
    (await patch(`/society/${SOCIETY_ID}`, adminToken, { timezone: 'Narnia/Cair_Paravel' })).status === 400
  );

  // --- Happy path: Admin edits, then restores the original values ---
  const before = seededSociety;
  const newName = `${testTag} Updated Society Name`;
  const newVpa = 'testupdated@okhdfcbank';
  const editResult = await patch(`/society/${SOCIETY_ID}`, adminToken, {
    name: newName,
    upi_vpa: newVpa,
    timezone: 'Asia/Kolkata',
  });
  check(
    'Admin editing name/upi_vpa/timezone succeeds (200), fields reflect the change, updated_at advanced',
    editResult.status === 200 &&
      editResult.body.name === newName &&
      editResult.body.upi_vpa === newVpa &&
      editResult.body.updated_at !== before.updated_at,
    editResult.body
  );

  const { data: auditRows } = await supabaseAdmin
    .from('audit_events')
    .select('action, entity_id')
    .eq('entity_id', SOCIETY_ID)
    .eq('action', 'Updated')
    .eq('entity_type', 'society');
  check(
    'the edit wrote an audit_events row',
    (auditRows || []).length > 0,
    auditRows
  );

  const restoreResult = await patch(`/society/${SOCIETY_ID}`, adminToken, {
    name: before.name,
    upi_vpa: before.upi_vpa,
    upi_payee_name: before.upi_payee_name,
    timezone: before.timezone,
  });
  check(
    'restoring the original values afterward succeeds (200) - baseline left clean',
    restoreResult.status === 200 && restoreResult.body.name === before.name && restoreResult.body.upi_vpa === before.upi_vpa,
    restoreResult.body
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // --- Cleanup: only the audit rows this run generated (gated by
  // testStartedAt, not just entity_id/entity_type - SOCIETY_ID is the real
  // seeded society, not a disposable test fixture, so an unscoped delete
  // here would also wipe any genuine society-settings audit history from
  // real usage between test runs), then the throwaway Committee member's
  // society_members row and its underlying auth.users account. ---
  await supabaseAdmin
    .from('audit_events')
    .delete()
    .eq('entity_id', SOCIETY_ID)
    .eq('entity_type', 'society')
    .gte('created_at', testStartedAt);
  if (createdMemberIds.length > 0) {
    await supabaseAdmin.from('audit_events').delete().in('entity_id', createdMemberIds);
    await supabaseAdmin.from('society_members').delete().in('id', createdMemberIds);
  }
  for (const authUserId of createdAuthUserIds) {
    await supabaseAdmin.auth.admin.deleteUser(authUserId).catch(() => {});
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
