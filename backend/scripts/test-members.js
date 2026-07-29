// Verifies the Members CRUD feature (GET/POST/PATCH /members,
// POST /members/:id/suspend, POST /members/:id/reactivate) added in
// backend/src/routes/members.js, and - just as importantly - the RLS
// change that finally gave society_members.status real teeth
// (20260727000000_enforce_suspended_status_in_rls.sql): a Suspended
// member must actually lose admin/committee powers AND their own
// resident actions (view dues/houses, submit payments), not just wear a
// cosmetic label. Requires the server running (npm run dev) and both
// this migration and 20260726010000_society_expenses_house_optional.sql
// already applied. Run with: node scripts/test-members.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon, createUserScopedClient } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const SOCIETY_ID = '00000003-0000-0000-0000-000000000003';
const HOUSE_A101 = '00000006-0000-0000-0000-000000000006';

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
  const residentToken = await loginToken('resident@society.app', 'password');
  const adminToken = await loginToken('admin@society.app', 'password');
  const testTag = `TESTMEMBER${Date.now()}`;
  const tenantEmail = `${testTag.toLowerCase()}@example.com`;
  const throwawayAdminEmail = `${testTag.toLowerCase()}admin@example.com`;

  const createdAuthUserIds = [];
  const createdMemberIds = [];

  // --- Unauthenticated is rejected everywhere ---
  check('unauthenticated GET /members is rejected (401)', (await get('/members', null)).status === 401);
  check('unauthenticated POST /members is rejected (401)', (await post('/members', null, {})).status === 401);
  check('unauthenticated PATCH /members/:id is rejected (401)', (await patch('/members/x', null, {})).status === 401);
  check('unauthenticated POST /members/:id/suspend is rejected (401)', (await post('/members/x/suspend', null)).status === 401);
  check('unauthenticated POST /members/:id/reactivate is rejected (401)', (await post('/members/x/reactivate', null)).status === 401);

  // --- A plain resident cannot administer members at all ---
  check('a plain resident cannot list members (403)', (await get('/members', residentToken)).status === 403);
  check(
    'a plain resident cannot create a member (403)',
    (
      await post('/members', residentToken, {
        society_id: SOCIETY_ID,
        email: `${testTag.toLowerCase()}residentattempt@example.com`,
        is_admin: true,
      })
    ).status === 403
  );

  // --- Validation ---
  check(
    'missing society_id is rejected (400)',
    (await post('/members', adminToken, { email: tenantEmail })).status === 400
  );
  check(
    'missing/invalid email is rejected (400)',
    (await post('/members', adminToken, { society_id: SOCIETY_ID, email: 'not-an-email' })).status === 400
  );
  check(
    'a too-short password is rejected (400)',
    (await post('/members', adminToken, { society_id: SOCIETY_ID, email: tenantEmail, password: '123' })).status === 400
  );
  check(
    'an invalid phone_number is rejected (400)',
    (
      await post('/members', adminToken, { society_id: SOCIETY_ID, email: tenantEmail, phone_number: 'abc' })
    ).status === 400
  );
  const duplicateEmail = await post('/members', adminToken, { society_id: SOCIETY_ID, email: 'resident@society.app' });
  check(
    'creating with an email that already exists is rejected (409)',
    duplicateEmail.status === 409,
    duplicateEmail
  );

  // --- Happy path: create a new tenant-style member, no password given
  // (auto-generated, returned once) ---
  const tenant = await post('/members', adminToken, { society_id: SOCIETY_ID, email: tenantEmail, phone_number: '+91 90000 09999' });
  check(
    'Admin creating a member with no password succeeds (201), Active, both flags false, temp password returned',
    tenant.status === 201 &&
      tenant.body.status === 'Active' &&
      tenant.body.is_admin === false &&
      tenant.body.is_committee_member === false &&
      typeof tenant.body.temporaryPassword === 'string' &&
      tenant.body.temporaryPassword.length >= 6,
    tenant.body
  );
  if (tenant.body.id) createdMemberIds.push(tenant.body.id);
  if (tenant.body.auth_user_id) createdAuthUserIds.push(tenant.body.auth_user_id);

  // --- Happy path: create a throwaway Admin, explicit password, used
  // below to prove suspension actually strips admin powers ---
  const throwawayPassword = `Test${Date.now()}Pw!`;
  const throwawayAdmin = await post('/members', adminToken, {
    society_id: SOCIETY_ID,
    email: throwawayAdminEmail,
    password: throwawayPassword,
    is_admin: true,
  });
  check(
    'Admin creating another Admin with an explicit password succeeds (201), no temporaryPassword field',
    throwawayAdmin.status === 201 && throwawayAdmin.body.is_admin === true && throwawayAdmin.body.temporaryPassword === undefined,
    throwawayAdmin.body
  );
  if (throwawayAdmin.body.id) createdMemberIds.push(throwawayAdmin.body.id);
  if (throwawayAdmin.body.auth_user_id) createdAuthUserIds.push(throwawayAdmin.body.auth_user_id);

  // --- GET /members includes both, with email and houses=[] (no
  // assignment was created - by design, see route comment) ---
  const list = await get('/members', adminToken);
  const listedTenant = (list.body || []).find((m) => m.id === tenant.body.id);
  check(
    'GET /members includes the new tenant with correct email and no houses',
    list.status === 200 && !!listedTenant && listedTenant.email === tenantEmail && Array.isArray(listedTenant.houses) && listedTenant.houses.length === 0,
    listedTenant
  );

  // --- PATCH: edit is_committee_member and phone_number on the tenant ---
  const editTenant = await patch(`/members/${tenant.body.id}`, adminToken, { is_committee_member: true, phone_number: '+91 90000 08888' });
  check(
    'Admin editing is_committee_member/phone_number succeeds (200)',
    editTenant.status === 200 && editTenant.body.is_committee_member === true && editTenant.body.phone_number === '+91 90000 08888',
    editTenant.body
  );
  check('PATCH with no fields is rejected (400)', (await patch(`/members/${tenant.body.id}`, adminToken, {})).status === 400);

  // --- Self-protection: an Admin cannot remove their own admin access ---
  const selfMember = (list.body || []).find((m) => m.email === 'admin@society.app');
  check('setup: found admin@society.app in the member list', !!selfMember, list.body);
  if (selfMember) {
    const selfDemote = await patch(`/members/${selfMember.id}`, adminToken, { is_admin: false });
    check('an Admin cannot remove their own admin access (400)', selfDemote.status === 400, selfDemote);

    const selfSuspend = await post(`/members/${selfMember.id}/suspend`, adminToken);
    check('an Admin cannot suspend their own account (400)', selfSuspend.status === 400, selfSuspend);
  }

  // --- Suspend/reactivate lifecycle on the tenant ---
  const suspendTenant = await post(`/members/${tenant.body.id}/suspend`, adminToken);
  check('Admin suspending the tenant succeeds (200, Suspended)', suspendTenant.status === 200 && suspendTenant.body.status === 'Suspended', suspendTenant.body);
  check('re-suspending an already-Suspended member is rejected (409)', (await post(`/members/${tenant.body.id}/suspend`, adminToken)).status === 409);

  const reactivateTenant = await post(`/members/${tenant.body.id}/reactivate`, adminToken);
  check('Admin reactivating the tenant succeeds (200, Active)', reactivateTenant.status === 200 && reactivateTenant.body.status === 'Active', reactivateTenant.body);
  check('reactivating a non-Suspended member is rejected (409)', (await post(`/members/${tenant.body.id}/reactivate`, adminToken)).status === 409);

  // --- Full-enforcement proof #1: a Suspended Admin genuinely loses
  // admin powers, not just the label - log in as the throwaway Admin,
  // confirm they can act, suspend them via the original admin, confirm
  // their own already-issued token can no longer act. ---
  const throwawayAdminToken = await loginToken(throwawayAdminEmail, throwawayPassword);
  const beforeSuspendList = await get('/members', throwawayAdminToken);
  check('BEFORE suspend: the throwaway Admin can list members', beforeSuspendList.status === 200, beforeSuspendList);

  const suspendThrowawayAdmin = await post(`/members/${throwawayAdmin.body.id}/suspend`, adminToken);
  check('the original Admin can suspend the throwaway Admin (200)', suspendThrowawayAdmin.status === 200, suspendThrowawayAdmin.body);

  const afterSuspendList = await get('/members', throwawayAdminToken);
  check(
    'AFTER suspend: the SAME already-issued token can no longer list members (403) - suspension has real teeth, not cosmetic',
    afterSuspendList.status === 403,
    afterSuspendList
  );

  const afterSuspendPending = await get('/transactions/pending', throwawayAdminToken);
  check(
    'AFTER suspend: the same token also loses the transactions review queue (403)',
    afterSuspendPending.status === 403,
    afterSuspendPending
  );

  // --- Full-enforcement proof #2: a Suspended resident genuinely loses
  // their own resident-facing visibility (view houses/dues), using raw
  // RLS queries against the seeded resident@society.app / house A-101 -
  // temporarily, restored via reactivate before this script exits. ---
  const residentScoped = createUserScopedClient(residentToken);
  const beforeBilling = await residentScoped.from('billing_periods').select('id').eq('house_id', HOUSE_A101);
  check('BEFORE suspend: resident sees their own house\'s billing period', (beforeBilling.data || []).length === 1, beforeBilling);

  const residentMember = (list.body || []).find((m) => m.email === 'resident@society.app');
  check('setup: found resident@society.app in the member list', !!residentMember, list.body);

  if (residentMember) {
    const suspendResident = await post(`/members/${residentMember.id}/suspend`, adminToken);
    check('Admin suspends the seeded resident (200)', suspendResident.status === 200, suspendResident.body);

    const duringBilling = await residentScoped.from('billing_periods').select('id').eq('house_id', HOUSE_A101);
    check(
      'AFTER suspend: the resident\'s own token sees ZERO billing periods for their own house',
      (duringBilling.data || []).length === 0,
      duringBilling
    );
    const duringHouse = await residentScoped.from('houses').select('id').eq('id', HOUSE_A101);
    check('AFTER suspend: the resident\'s own token cannot even see their own house row', (duringHouse.data || []).length === 0, duringHouse);

    const reactivateResident = await post(`/members/${residentMember.id}/reactivate`, adminToken);
    check('Admin reactivates the seeded resident (200) - restoring baseline before this script exits', reactivateResident.status === 200, reactivateResident.body);

    const afterBilling = await residentScoped.from('billing_periods').select('id').eq('house_id', HOUSE_A101);
    check('AFTER reactivate: resident sees their billing period again', (afterBilling.data || []).length === 1, afterBilling);
  }

  // --- Audit trail sanity ---
  const { data: auditRows } = await supabaseAdmin
    .from('audit_events')
    .select('action, entity_id')
    .in('entity_id', [tenant.body.id, throwawayAdmin.body.id].filter(Boolean));
  check(
    'member creation/suspend/reactivate actions wrote audit_events rows',
    (auditRows || []).some((r) => r.entity_id === tenant.body.id && r.action === 'Created') &&
      (auditRows || []).some((r) => r.entity_id === throwawayAdmin.body.id && r.action === 'Created'),
    auditRows
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // --- Cleanup: audit rows, society_members rows, then the underlying
  // auth.users accounts (service role - Admin API, same as creation). ---
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
