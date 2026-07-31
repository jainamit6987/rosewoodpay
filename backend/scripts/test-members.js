// Verifies the Members CRUD feature (GET/POST/PATCH /members, GET /members/
// :id, GET /members/search, POST /members/:id/suspend, POST /members/:id/
// reactivate) in backend/src/routes/members.js, and - just as importantly -
// the RLS change that finally gave society_members.status real teeth
// (20260727000000_enforce_suspended_status_in_rls.sql): a Suspended
// member must actually lose admin/committee powers AND their own
// resident actions (view dues/houses, submit payments), not just wear a
// cosmetic label. Also covers this session's two additions to Suspend:
// it now actually bans the underlying Supabase auth account (sign-in
// itself fails, not just RLS-gated app access), and is blocked outright
// if the member still holds any Active house assignment - deliberately
// pushing "deal with housing first" onto the House Dashboard's own
// Edit-mode revoke/reassign flow rather than cascading anything here.
// Requires the server running (npm run dev) and both this migration and
// 20260731010000_add_name_to_society_members.sql already applied. Run
// with: node scripts/test-members.js
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

// Same shape as loginToken, but for proving a banned account's sign-in
// itself now fails (rather than throwing on a legitimate call) - returns
// whether Supabase Auth accepted the credentials, not a token.
async function canSignIn(email, password) {
  const { error } = await supabaseAnon.auth.signInWithPassword({ email, password });
  return !error;
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
  const linkedEmail = `${testTag.toLowerCase()}linked@example.com`;

  const createdAuthUserIds = [];
  const createdMemberIds = [];
  let throwawayHouse = null;
  let linkedAssignmentId = null;

  // --- Unauthenticated is rejected everywhere ---
  check('unauthenticated GET /members is rejected (401)', (await get('/members', null)).status === 401);
  check('unauthenticated GET /members/:id is rejected (401)', (await get('/members/x', null)).status === 401);
  check('unauthenticated GET /members/search is rejected (401)', (await get('/members/search?q=a', null)).status === 401);
  check('unauthenticated POST /members is rejected (401)', (await post('/members', null, {})).status === 401);
  check('unauthenticated PATCH /members/:id is rejected (401)', (await patch('/members/x', null, {})).status === 401);
  check('unauthenticated POST /members/:id/suspend is rejected (401)', (await post('/members/x/suspend', null)).status === 401);
  check('unauthenticated POST /members/:id/reactivate is rejected (401)', (await post('/members/x/reactivate', null)).status === 401);

  // --- A plain resident cannot administer members at all ---
  check('a plain resident cannot list members (403)', (await get('/members', residentToken)).status === 403);
  check('a plain resident cannot search members (403)', (await get('/members/search?q=a', residentToken)).status === 403);
  check(
    'a plain resident cannot create a member (403)',
    (
      await post('/members', residentToken, {
        society_id: SOCIETY_ID,
        email: `${testTag.toLowerCase()}residentattempt@example.com`,
        name: 'Resident Attempt',
        is_admin: true,
      })
    ).status === 403
  );

  // --- Validation ---
  check(
    'missing society_id is rejected (400)',
    (await post('/members', adminToken, { email: tenantEmail, name: 'Test Tenant' })).status === 400
  );
  check(
    'missing/invalid email is rejected (400)',
    (await post('/members', adminToken, { society_id: SOCIETY_ID, email: 'not-an-email', name: 'Test Tenant' })).status === 400
  );
  check(
    'missing/blank name is rejected (400)',
    (await post('/members', adminToken, { society_id: SOCIETY_ID, email: tenantEmail, name: '   ' })).status === 400
  );
  check(
    'a too-short password is rejected (400)',
    (await post('/members', adminToken, { society_id: SOCIETY_ID, email: tenantEmail, name: 'Test Tenant', password: '123' })).status === 400
  );
  check(
    'an invalid phone_number is rejected (400)',
    (
      await post('/members', adminToken, { society_id: SOCIETY_ID, email: tenantEmail, name: 'Test Tenant', phone_number: 'abc' })
    ).status === 400
  );
  const duplicateEmail = await post('/members', adminToken, { society_id: SOCIETY_ID, email: 'resident@society.app', name: 'Dup' });
  check(
    'creating with an email that already exists is rejected (409)',
    duplicateEmail.status === 409,
    duplicateEmail
  );

  // --- Happy path: create a new tenant-style member, no password given
  // (auto-generated, returned once) ---
  const tenant = await post('/members', adminToken, {
    society_id: SOCIETY_ID,
    email: tenantEmail,
    name: 'Test Tenant',
    phone_number: '+91 90000 09999',
  });
  check(
    'Admin creating a member with a name and no password succeeds (201), Active, both flags false, temp password returned',
    tenant.status === 201 &&
      tenant.body.name === 'Test Tenant' &&
      tenant.body.status === 'Active' &&
      tenant.body.is_admin === false &&
      tenant.body.is_committee_member === false &&
      typeof tenant.body.temporaryPassword === 'string' &&
      tenant.body.temporaryPassword.length >= 6,
    tenant.body
  );
  const tenantPassword = tenant.body.temporaryPassword;
  if (tenant.body.id) createdMemberIds.push(tenant.body.id);
  if (tenant.body.auth_user_id) createdAuthUserIds.push(tenant.body.auth_user_id);

  // --- Happy path: create a throwaway Admin, explicit password, used
  // below to prove suspension actually strips admin powers ---
  const throwawayPassword = `Test${Date.now()}Pw!`;
  const throwawayAdmin = await post('/members', adminToken, {
    society_id: SOCIETY_ID,
    email: throwawayAdminEmail,
    name: 'Throwaway Admin',
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

  // --- GET /members includes both, with name/email and houses=[] (no
  // assignment was created - by design, see route comment) ---
  const list = await get('/members', adminToken);
  const listedTenant = (list.body || []).find((m) => m.id === tenant.body.id);
  check(
    'GET /members includes the new tenant with correct name/email and no houses',
    list.status === 200 && !!listedTenant && listedTenant.name === 'Test Tenant' && listedTenant.email === tenantEmail && Array.isArray(listedTenant.houses) && listedTenant.houses.length === 0,
    listedTenant
  );

  // --- GET /members/:id - the new single-member detail endpoint ---
  const detail = await get(`/members/${tenant.body.id}`, adminToken);
  check(
    'GET /members/:id returns the full detail shape including an empty assignments array',
    detail.status === 200 && detail.body.name === 'Test Tenant' && detail.body.email === tenantEmail && Array.isArray(detail.body.assignments) && detail.body.assignments.length === 0,
    detail.body
  );
  check('GET /members/:id for a nonexistent id is rejected (404)', (await get('/members/00000000-0000-0000-0000-000000000000', adminToken)).status === 404);
  // A plain resident's own RLS visibility into society_members is limited
  // to their own row ("Users can view their own society_member record") -
  // someone else's id is simply invisible to their query, so this 404s
  // before ever reaching the explicit requireActiveAdmin check below it,
  // same "RLS filters it out before the app-layer check ever runs"
  // precedent noted in assignments.js's cross-society test setup.
  check('a plain resident cannot view a member\'s detail (404 - not visible under RLS at all)', (await get(`/members/${tenant.body.id}`, residentToken)).status === 404);

  // --- PATCH: edit name, is_committee_member and phone_number on the tenant ---
  const editTenant = await patch(`/members/${tenant.body.id}`, adminToken, {
    name: 'Test Tenant Renamed',
    is_committee_member: true,
    phone_number: '+91 90000 08888',
  });
  check(
    'Admin editing name/is_committee_member/phone_number succeeds (200)',
    editTenant.status === 200 &&
      editTenant.body.name === 'Test Tenant Renamed' &&
      editTenant.body.is_committee_member === true &&
      editTenant.body.phone_number === '+91 90000 08888',
    editTenant.body
  );
  check('PATCH with no fields is rejected (400)', (await patch(`/members/${tenant.body.id}`, adminToken, {})).status === 400);
  check('PATCH with a blank name is rejected (400)', (await patch(`/members/${tenant.body.id}`, adminToken, { name: '  ' })).status === 400);

  // --- GET /members/search - matches name OR phone_number, not email ---
  const searchUnauth401 = await get('/members/search?q=Tenant', null);
  check('setup sanity: unauthenticated search already covered above (401)', searchUnauth401.status === 401);

  const searchEmptyQ = await get('/members/search?q=', adminToken);
  check('an empty q returns [] rather than everyone', searchEmptyQ.status === 200 && Array.isArray(searchEmptyQ.body) && searchEmptyQ.body.length === 0, searchEmptyQ.body);

  const searchByName = await get(`/members/search?q=${encodeURIComponent('Tenant Renamed')}`, adminToken);
  check(
    'search by a name substring finds the renamed tenant',
    searchByName.status === 200 && (searchByName.body || []).some((m) => m.id === tenant.body.id),
    searchByName.body
  );

  const searchByPhone = await get(`/members/search?q=${encodeURIComponent('90000 08888')}`, adminToken);
  check(
    'search by a phone_number substring finds the same tenant',
    searchByPhone.status === 200 && (searchByPhone.body || []).some((m) => m.id === tenant.body.id),
    searchByPhone.body
  );

  const searchByEmail = await get(`/members/search?q=${encodeURIComponent(tenantEmail)}`, adminToken);
  check(
    'search by email finds nothing - email is deliberately not a matched field',
    searchByEmail.status === 200 && !(searchByEmail.body || []).some((m) => m.id === tenant.body.id),
    searchByEmail.body
  );

  const searchNoMatch = await get(`/members/search?q=${encodeURIComponent('NoSuchMemberXYZ')}`, adminToken);
  check('a query matching nothing returns []', searchNoMatch.status === 200 && (searchNoMatch.body || []).length === 0, searchNoMatch.body);

  // --- Self-protection: an Admin cannot remove their own admin access ---
  const selfMember = (list.body || []).find((m) => m.email === 'admin@society.app');
  check('setup: found admin@society.app in the member list', !!selfMember, list.body);
  if (selfMember) {
    const selfDemote = await patch(`/members/${selfMember.id}`, adminToken, { is_admin: false });
    check('an Admin cannot remove their own admin access (400)', selfDemote.status === 400, selfDemote);

    const selfSuspend = await post(`/members/${selfMember.id}/suspend`, adminToken);
    check('an Admin cannot suspend their own account (400)', selfSuspend.status === 400, selfSuspend);
  }

  // --- New precondition: suspend is blocked while an Active house
  // assignment exists - proven directly against the seeded resident, who
  // genuinely has one (house A-101), without ever actually suspending
  // them (this script never mutates that shared fixture's real state). ---
  const residentMember = (list.body || []).find((m) => m.email === 'resident@society.app');
  check('setup: found resident@society.app in the member list', !!residentMember, list.body);
  if (residentMember) {
    const blockedSuspend = await post(`/members/${residentMember.id}/suspend`, adminToken);
    check(
      'suspending a member who still has an Active house assignment is blocked (400), naming the house',
      blockedSuspend.status === 400 && /A-101/.test(blockedSuspend.body.error || ''),
      blockedSuspend
    );
  }

  // --- Full lifecycle of that same precondition, on an isolated
  // throwaway house/assignment so nothing shared gets touched: blocked
  // while linked, succeeds once unlinked, and the auth ban this session
  // added actually prevents sign-in (not just an RLS-gated app lockout). ---
  const houseTag = `${Date.now() % 1000000}`; // house_number is VARCHAR(20) - testTag alone is already too long
  const { data: house, error: houseInsertError } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: SOCIETY_ID, house_number: `M-${houseTag}`, type: 'Flat', default_monthly_amount: 1000 })
    .select('id')
    .single();
  if (houseInsertError) {
    console.error('setup failed: could not create throwaway house', houseInsertError.message);
    process.exit(1);
  }
  throwawayHouse = house;

  const linkedPassword = `Test${Date.now()}Link!`;
  const linkedMember = await post('/members', adminToken, {
    society_id: SOCIETY_ID,
    email: linkedEmail,
    name: 'Linked Then Unlinked',
    password: linkedPassword,
  });
  if (linkedMember.body.id) createdMemberIds.push(linkedMember.body.id);
  if (linkedMember.body.auth_user_id) createdAuthUserIds.push(linkedMember.body.auth_user_id);

  const { data: assignment, error: assignmentError } = await supabaseAdmin
    .from('resident_house_assignments')
    .insert({
      society_member_id: linkedMember.body.id,
      house_id: throwawayHouse.id,
      relationship_type: 'Tenant',
      status: 'Active',
      approved_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (assignmentError) {
    console.error('setup failed: could not create throwaway assignment', assignmentError.message);
    process.exit(1);
  }
  linkedAssignmentId = assignment.id;

  const suspendWhileLinked = await post(`/members/${linkedMember.body.id}/suspend`, adminToken);
  check(
    'suspend is blocked (400) for a throwaway member with an Active Tenant assignment',
    suspendWhileLinked.status === 400,
    suspendWhileLinked
  );

  const beforeBanSignIn = await canSignIn(linkedEmail, linkedPassword);
  check('BEFORE suspend: the throwaway member can still sign in', beforeBanSignIn === true);

  const unlink = await post(`/assignments/${linkedAssignmentId}/revoke`, adminToken);
  check('setup: revoking the throwaway Tenant assignment succeeds (200)', unlink.status === 200, unlink.body);

  const suspendAfterUnlink = await post(`/members/${linkedMember.body.id}/suspend`, adminToken);
  check(
    'once unlinked, suspend now succeeds (200, Suspended)',
    suspendAfterUnlink.status === 200 && suspendAfterUnlink.body.status === 'Suspended',
    suspendAfterUnlink.body
  );

  const duringBanSignIn = await canSignIn(linkedEmail, linkedPassword);
  check('AFTER suspend: sign-in itself now fails - a real auth-level ban, not just an RLS-gated app lockout', duringBanSignIn === false);

  const reactivateLinked = await post(`/members/${linkedMember.body.id}/reactivate`, adminToken);
  check('reactivating lifts the ban (200, Active)', reactivateLinked.status === 200 && reactivateLinked.body.status === 'Active', reactivateLinked.body);

  const afterUnbanSignIn = await canSignIn(linkedEmail, linkedPassword);
  check('AFTER reactivate: sign-in works again', afterUnbanSignIn === true);

  // --- Suspend/reactivate lifecycle on the tenant (never linked to any
  // house, so unaffected by the new precondition) ---
  const suspendTenant = await post(`/members/${tenant.body.id}/suspend`, adminToken);
  check('Admin suspending the (never-linked) tenant succeeds (200, Suspended)', suspendTenant.status === 200 && suspendTenant.body.status === 'Suspended', suspendTenant.body);
  check('re-suspending an already-Suspended member is rejected (409)', (await post(`/members/${tenant.body.id}/suspend`, adminToken)).status === 409);

  const bannedTenantSignIn = await canSignIn(tenantEmail, tenantPassword);
  check('the suspended tenant\'s own temp password can no longer sign in', bannedTenantSignIn === false);

  const reactivateTenant = await post(`/members/${tenant.body.id}/reactivate`, adminToken);
  check('Admin reactivating the tenant succeeds (200, Active)', reactivateTenant.status === 200 && reactivateTenant.body.status === 'Active', reactivateTenant.body);
  check('reactivating a non-Suspended member is rejected (409)', (await post(`/members/${tenant.body.id}/reactivate`, adminToken)).status === 409);

  // --- Full-enforcement proof: a Suspended Admin genuinely loses admin
  // powers, not just the label - log in as the throwaway Admin, confirm
  // they can act, suspend them via the original admin, confirm their own
  // already-issued token can no longer act (RLS side) on top of the fresh
  // sign-in already being banned (auth side, proven above). ---
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

  // --- Cleanup: throwaway house (cascades its already-revoked
  // assignment), audit rows, society_members rows, then the underlying
  // auth.users accounts (service role - Admin API, same as creation). ---
  if (throwawayHouse) {
    await supabaseAdmin.from('houses').delete().eq('id', throwawayHouse.id);
  }
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
