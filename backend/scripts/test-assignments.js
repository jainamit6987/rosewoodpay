// Verifies the Resident-House Assignments admin CRUD feature (GET/POST
// /assignments, POST /assignments/:id/approve, /revoke, /reassign) added
// in backend/src/routes/assignments.js: Admin-only writes, Admin/Committee
// reads, the two-step create-Pending-then-approve flow, revoke from either
// Pending or Active, and reassign (revoke old + create new Active row)
// with its cross-society/duplicate/self-noop guards. Requires the server
// running (npm run dev). Run with: node scripts/test-assignments.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const SOCIETY_ID = '00000003-0000-0000-0000-000000000003';
const HOUSE_A101 = '00000006-0000-0000-0000-000000000006';
const RESIDENT_MEMBER_ID = '00000005-0000-0000-0000-000000000005';
const ADMIN_AUTH_USER_ID = '00000001-0000-0000-0000-000000000001';
const FAKE_UUID = '99999999-9999-9999-9999-999999999999';

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

async function main() {
  const testStartedAt = new Date().toISOString();
  const residentToken = await loginToken('resident@society.app', 'password');
  const adminToken = await loginToken('admin@society.app', 'password');
  const testTag = `TESTASSIGN${Date.now()}`;
  const houseTag = `${Date.now() % 1000000}`; // house_number is VARCHAR(20) - testTag alone is already too long
  const memberEmail = `${testTag.toLowerCase()}@example.com`;
  const memberPassword = `Test${Date.now()}Pw!`;
  const suspendedEmail = `${testTag.toLowerCase()}suspended@example.com`;
  const suspendedPassword = `Test${Date.now()}Pw!x`;

  const createdAuthUserIds = [];
  const createdMemberIds = [];
  let society2Id = null;

  // --- Fetch the resident's own real (seeded) assignment id, used below
  // for the "wrong caller, not wrong state" 403 checks. ---
  const { data: residentAssignmentRow } = await supabaseAdmin
    .from('resident_house_assignments')
    .select('id')
    .eq('society_member_id', RESIDENT_MEMBER_ID)
    .eq('house_id', HOUSE_A101)
    .single();
  const residentAssignmentId = residentAssignmentRow.id;

  // --- Unauthenticated is rejected everywhere ---
  check('unauthenticated GET /assignments is rejected (401)', (await get('/assignments', null)).status === 401);
  check('unauthenticated POST /assignments is rejected (401)', (await post('/assignments', null, {})).status === 401);
  check(
    'unauthenticated POST /assignments/:id/approve is rejected (401)',
    (await post(`/assignments/${FAKE_UUID}/approve`, null)).status === 401
  );
  check(
    'unauthenticated POST /assignments/:id/revoke is rejected (401)',
    (await post(`/assignments/${FAKE_UUID}/revoke`, null)).status === 401
  );
  check(
    'unauthenticated POST /assignments/:id/reassign is rejected (401)',
    (await post(`/assignments/${FAKE_UUID}/reassign`, null)).status === 401
  );

  // --- A plain resident (no admin/committee flags) can neither read nor
  // write, even against their OWN real assignment - this is a caller-role
  // check, not a state/ownership check. ---
  check('a plain resident cannot list assignments (403)', (await get('/assignments', residentToken)).status === 403);
  check(
    'a plain resident cannot create an assignment (403)',
    (await post('/assignments', residentToken, { society_id: SOCIETY_ID, society_member_id: RESIDENT_MEMBER_ID, house_id: HOUSE_A101 })).status === 403
  );
  check(
    'a plain resident cannot approve their own assignment (403)',
    (await post(`/assignments/${residentAssignmentId}/approve`, residentToken)).status === 403
  );
  check(
    'a plain resident cannot revoke their own assignment (403)',
    (await post(`/assignments/${residentAssignmentId}/revoke`, residentToken)).status === 403
  );
  check(
    'a plain resident cannot reassign their own assignment (403)',
    (await post(`/assignments/${residentAssignmentId}/reassign`, residentToken, { relationship_type: 'Tenant' })).status === 403
  );

  // --- Setup: a throwaway Active member, a throwaway Suspended member,
  // two throwaway houses in the real society, plus an entirely separate
  // throwaway society (with its own house and member) to exercise the
  // cross-society validation paths without touching the real fixtures. ---
  const memberResult = await post('/members', adminToken, { society_id: SOCIETY_ID, email: memberEmail, name: 'Test Member', password: memberPassword });
  check('setup: created a throwaway Active member', memberResult.status === 201, memberResult.body);
  const memberId = memberResult.body.id;
  createdMemberIds.push(memberId);
  createdAuthUserIds.push(memberResult.body.auth_user_id);

  const suspendedResult = await post('/members', adminToken, { society_id: SOCIETY_ID, email: suspendedEmail, name: 'Test Suspended', password: suspendedPassword });
  const suspendedMemberId = suspendedResult.body.id;
  createdMemberIds.push(suspendedMemberId);
  createdAuthUserIds.push(suspendedResult.body.auth_user_id);
  const suspendResult = await post(`/members/${suspendedMemberId}/suspend`, adminToken);
  check('setup: created and suspended a throwaway member', suspendResult.status === 200 && suspendResult.body.status === 'Suspended', suspendResult.body);

  const { data: house1, error: house1Error } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: SOCIETY_ID, house_number: `H1-${houseTag}`, type: 'Flat', default_monthly_amount: 1000 })
    .select()
    .single();
  if (house1Error) throw new Error(`setup house1 insert failed: ${house1Error.message}`);
  const { data: house2, error: house2Error } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: SOCIETY_ID, house_number: `H2-${houseTag}`, type: 'Flat', default_monthly_amount: 1000 })
    .select()
    .single();
  if (house2Error) throw new Error(`setup house2 insert failed: ${house2Error.message}`);

  const { data: society2, error: society2Error } = await supabaseAdmin
    .from('societies')
    .insert({ name: `${testTag} Society2`, upi_vpa: `${testTag.toLowerCase()}@upi`, upi_payee_name: `${testTag} Payee` })
    .select()
    .single();
  if (society2Error) throw new Error(`setup society2 insert failed: ${society2Error.message}`);
  society2Id = society2.id;
  const { data: house2InSociety2, error: house2InSociety2Error } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: society2Id, house_number: 'X-1', type: 'Flat', default_monthly_amount: 1000 })
    .select()
    .single();
  if (house2InSociety2Error) throw new Error(`setup house2InSociety2 insert failed: ${house2InSociety2Error.message}`);
  // Reuses the real resident's auth_user_id in a second society -
  // unique_society_member is (society_id, auth_user_id), so one auth user
  // legitimately holding memberships in two different societies is valid,
  // and this table gets wiped by cascade when society2 itself is deleted.
  const { data: member2InSociety2, error: member2InSociety2Error } = await supabaseAdmin
    .from('society_members')
    .insert({ society_id: society2Id, auth_user_id: '00000002-0000-0000-0000-000000000002', is_admin: false, is_committee_member: false, status: 'Active' })
    .select()
    .single();
  if (member2InSociety2Error) throw new Error(`setup member2InSociety2 insert failed: ${member2InSociety2Error.message}`);
  // The Admin also needs to be an Active Admin of society2 for the
  // "house_id/society_member_id belongs to a different society" checks
  // below to actually reach the 400 branch: without this, RLS on
  // houses/society_members (a real admin of only SOCIETY_ID has no access
  // to a society they are not a member of at all) filters house2InSociety2/
  // member2InSociety2 out entirely, so the lookup 404s before the
  // society_id-mismatch check ever runs - a correct, if different,
  // rejection, but not the one this test means to exercise.
  const { error: adminInSociety2Error } = await supabaseAdmin
    .from('society_members')
    .insert({ society_id: society2Id, auth_user_id: ADMIN_AUTH_USER_ID, is_admin: true, is_committee_member: false, status: 'Active' });
  if (adminInSociety2Error) throw new Error(`setup adminInSociety2 insert failed: ${adminInSociety2Error.message}`);

  // --- POST /assignments validation ---
  check(
    'POST /assignments without society_id is rejected (400)',
    (await post('/assignments', adminToken, { society_member_id: memberId, house_id: house1.id })).status === 400
  );
  check(
    'POST /assignments without society_member_id is rejected (400)',
    (await post('/assignments', adminToken, { society_id: SOCIETY_ID, house_id: house1.id })).status === 400
  );
  check(
    'POST /assignments without house_id is rejected (400)',
    (await post('/assignments', adminToken, { society_id: SOCIETY_ID, society_member_id: memberId })).status === 400
  );
  check(
    'POST /assignments with an invalid relationship_type is rejected (400)',
    (await post('/assignments', adminToken, { society_id: SOCIETY_ID, society_member_id: memberId, house_id: house1.id, relationship_type: 'Squatter' })).status === 400
  );
  check(
    'POST /assignments with a non-existent house_id is rejected (404)',
    (await post('/assignments', adminToken, { society_id: SOCIETY_ID, society_member_id: memberId, house_id: FAKE_UUID })).status === 404
  );
  check(
    'POST /assignments with a non-existent society_member_id is rejected (404)',
    (await post('/assignments', adminToken, { society_id: SOCIETY_ID, society_member_id: FAKE_UUID, house_id: house1.id })).status === 404
  );
  check(
    'POST /assignments with a house from a different society is rejected (400)',
    (await post('/assignments', adminToken, { society_id: SOCIETY_ID, society_member_id: memberId, house_id: house2InSociety2.id })).status === 400
  );
  check(
    'POST /assignments with a member from a different society is rejected (400)',
    (await post('/assignments', adminToken, { society_id: SOCIETY_ID, society_member_id: member2InSociety2.id, house_id: house1.id })).status === 400
  );
  check(
    'POST /assignments targeting a Suspended member is rejected (400)',
    (await post('/assignments', adminToken, { society_id: SOCIETY_ID, society_member_id: suspendedMemberId, house_id: house1.id })).status === 400
  );

  // --- POST /assignments happy path: lands as Pending, not Active ---
  const createResult = await post('/assignments', adminToken, { society_id: SOCIETY_ID, society_member_id: memberId, house_id: house1.id });
  check(
    'Admin creating an assignment succeeds (201), lands as Pending with no approver yet',
    createResult.status === 201 && createResult.body.status === 'Pending' && createResult.body.approved_by === null && createResult.body.relationship_type === 'Owner',
    createResult.body
  );
  const pendingAssignment1Id = createResult.body.id;

  const { data: createAuditRows } = await supabaseAdmin
    .from('audit_events')
    .select('action')
    .eq('entity_id', pendingAssignment1Id)
    .eq('entity_type', 'resident_house_assignment')
    .eq('action', 'Created');
  check('the create wrote an audit_events row', (createAuditRows || []).length > 0, createAuditRows);

  check(
    'a second POST /assignments for the same member+house while one is already Pending is rejected (409)',
    (await post('/assignments', adminToken, { society_id: SOCIETY_ID, society_member_id: memberId, house_id: house1.id })).status === 409
  );

  // --- GET /assignments: status filter, and the fields a review screen needs ---
  check('GET /assignments with an invalid status filter is rejected (400)', (await get('/assignments?status=Bogus', adminToken)).status === 400);

  const pendingList = await get('/assignments?status=Pending', adminToken);
  const pendingEntry = (pendingList.body || []).find((a) => a.id === pendingAssignment1Id);
  check(
    'GET /assignments?status=Pending (200) includes the new row with houseNumber/memberEmail resolved',
    pendingList.status === 200 && !!pendingEntry && pendingEntry.houseNumber === house1.house_number && pendingEntry.memberEmail === memberEmail,
    pendingEntry
  );
  const activeListMissingIt = await get('/assignments?status=Active', adminToken);
  check(
    'GET /assignments?status=Active (200) does NOT include the still-Pending row',
    activeListMissingIt.status === 200 && !(activeListMissingIt.body || []).some((a) => a.id === pendingAssignment1Id)
  );

  // --- POST /assignments/:id/approve ---
  const approveResult = await post(`/assignments/${pendingAssignment1Id}/approve`, adminToken);
  check(
    'Admin approving a Pending assignment succeeds (200): Active, approved_by/approved_at set',
    approveResult.status === 200 &&
      approveResult.body.status === 'Active' &&
      approveResult.body.approved_by === ADMIN_AUTH_USER_ID &&
      !!approveResult.body.approved_at,
    approveResult.body
  );
  const approvedAssignment1Id = approveResult.body.id;

  const { data: approveAuditRows } = await supabaseAdmin
    .from('audit_events')
    .select('action')
    .eq('entity_id', approvedAssignment1Id)
    .eq('entity_type', 'resident_house_assignment')
    .eq('action', 'Approved');
  check('the approve wrote an audit_events row', (approveAuditRows || []).length > 0, approveAuditRows);

  check(
    'approving an already-Active assignment is rejected (409)',
    (await post(`/assignments/${approvedAssignment1Id}/approve`, adminToken)).status === 409
  );

  // --- POST /assignments/:id/revoke: from Pending, then from Active, then a repeat is rejected ---
  const secondCreate = await post('/assignments', adminToken, { society_id: SOCIETY_ID, society_member_id: memberId, house_id: house2.id });
  const pendingAssignment2Id = secondCreate.body.id;

  const revokePendingResult = await post(`/assignments/${pendingAssignment2Id}/revoke`, adminToken);
  check('Admin revoking a still-Pending assignment succeeds (200): Revoked', revokePendingResult.status === 200 && revokePendingResult.body.status === 'Revoked', revokePendingResult.body);
  check('revoking an already-Revoked assignment is rejected (409)', (await post(`/assignments/${pendingAssignment2Id}/revoke`, adminToken)).status === 409);

  const { data: revokeAuditRows } = await supabaseAdmin
    .from('audit_events')
    .select('action')
    .eq('entity_id', pendingAssignment2Id)
    .eq('entity_type', 'resident_house_assignment')
    .eq('action', 'Revoked');
  check('the revoke wrote an audit_events row', (revokeAuditRows || []).length > 0, revokeAuditRows);

  // --- POST /assignments/:id/reassign validation ---
  check(
    'reassigning a Revoked assignment is rejected (409 - only Active can be reassigned)',
    (await post(`/assignments/${pendingAssignment2Id}/reassign`, adminToken, { relationship_type: 'Tenant' })).status === 409
  );
  check(
    'reassigning with an empty body is rejected (400)',
    (await post(`/assignments/${approvedAssignment1Id}/reassign`, adminToken, {})).status === 400
  );
  check(
    'reassigning with an invalid relationship_type is rejected (400)',
    (await post(`/assignments/${approvedAssignment1Id}/reassign`, adminToken, { relationship_type: 'Squatter' })).status === 400
  );
  check(
    'reassigning to a house in a different society is rejected (400)',
    (await post(`/assignments/${approvedAssignment1Id}/reassign`, adminToken, { house_id: house2InSociety2.id })).status === 400
  );
  check(
    'reassigning to a Suspended member is rejected (400)',
    (await post(`/assignments/${approvedAssignment1Id}/reassign`, adminToken, { society_member_id: suspendedMemberId })).status === 400
  );
  check(
    'reassigning onto a pair that already has an Active assignment is rejected (409)',
    (await post(`/assignments/${approvedAssignment1Id}/reassign`, adminToken, { society_member_id: RESIDENT_MEMBER_ID, house_id: HOUSE_A101 })).status === 409
  );
  check(
    'reassigning with values identical to the current assignment is rejected (400 - nothing to reassign)',
    (await post(`/assignments/${approvedAssignment1Id}/reassign`, adminToken, { house_id: house1.id, society_member_id: memberId, relationship_type: 'Owner' })).status === 400
  );

  // --- POST /assignments/:id/reassign happy path: move to a different
  // house. approvedAssignment1Id is house1's only Active Owner - without
  // a co-owner already on house1, the new last-Owner guard would block
  // moving it away (proven in its own dedicated section below), so this
  // needs a throwaway co-owner fixture on house1 first purely to unblock
  // it here (a genuinely different member - the unique-per-member-house
  // index means memberId itself can't hold a second Active row on
  // house1); the guard's own behavior is exercised separately, in isolation. ---
  const house1CoOwnerResult = await post('/members', adminToken, {
    society_id: SOCIETY_ID,
    email: `${testTag.toLowerCase()}house1coowner@example.com`,
    name: 'House1 Co-Owner',
    password: memberPassword,
  });
  const house1CoOwnerMemberId = house1CoOwnerResult.body.id;
  createdMemberIds.push(house1CoOwnerMemberId);
  createdAuthUserIds.push(house1CoOwnerResult.body.auth_user_id);
  const { error: house1CoOwnerError } = await supabaseAdmin
    .from('resident_house_assignments')
    .insert({ society_member_id: house1CoOwnerMemberId, house_id: house1.id, relationship_type: 'Owner', status: 'Active', approved_at: new Date().toISOString() });
  if (house1CoOwnerError) throw new Error(`setup house1CoOwner insert failed: ${house1CoOwnerError.message}`);

  const reassignResult = await post(`/assignments/${approvedAssignment1Id}/reassign`, adminToken, { house_id: house2.id });
  check(
    'reassigning to a different house succeeds (200): new row is Active with approver set immediately, no separate approve needed',
    reassignResult.status === 200 &&
      reassignResult.body.revokedAssignmentId === approvedAssignment1Id &&
      reassignResult.body.assignment.status === 'Active' &&
      reassignResult.body.assignment.house_id === house2.id &&
      reassignResult.body.assignment.society_member_id === memberId &&
      reassignResult.body.assignment.approved_by === ADMIN_AUTH_USER_ID,
    reassignResult.body
  );
  const reassignedAssignmentId = reassignResult.body.assignment.id;

  const { data: oldRowAfterReassign } = await supabaseAdmin.from('resident_house_assignments').select('status').eq('id', approvedAssignment1Id).single();
  check('the old assignment is left Revoked after reassign, not deleted', oldRowAfterReassign.status === 'Revoked', oldRowAfterReassign);

  const { data: reassignAuditRows } = await supabaseAdmin
    .from('audit_events')
    .select('action, metadata')
    .eq('entity_id', reassignedAssignmentId)
    .eq('entity_type', 'resident_house_assignment')
    .eq('action', 'Reassigned');
  check(
    'the reassign wrote an audit_events row referencing the old assignment id',
    (reassignAuditRows || []).length > 0 && reassignAuditRows[0].metadata.old_assignment_id === approvedAssignment1Id,
    reassignAuditRows
  );

  // --- Reassign again, changing only relationship_type (same house/
  // member): reassignedAssignmentId is now house2's only Active Owner, so
  // moving it from Owner to Tenant leaves house2 without one unless a
  // co-owner backstops it first - same guard, same fixture pattern as
  // house1CoOwner above. ---
  const house2CoOwnerResult = await post('/members', adminToken, {
    society_id: SOCIETY_ID,
    email: `${testTag.toLowerCase()}house2coowner@example.com`,
    name: 'House2 Co-Owner',
    password: memberPassword,
  });
  const house2CoOwnerMemberId = house2CoOwnerResult.body.id;
  createdMemberIds.push(house2CoOwnerMemberId);
  createdAuthUserIds.push(house2CoOwnerResult.body.auth_user_id);
  const { error: house2CoOwnerError } = await supabaseAdmin
    .from('resident_house_assignments')
    .insert({ society_member_id: house2CoOwnerMemberId, house_id: house2.id, relationship_type: 'Owner', status: 'Active', approved_at: new Date().toISOString() });
  if (house2CoOwnerError) throw new Error(`setup house2CoOwner insert failed: ${house2CoOwnerError.message}`);

  const reassignRelationshipResult = await post(`/assignments/${reassignedAssignmentId}/reassign`, adminToken, { relationship_type: 'Tenant' });
  check(
    'reassigning to change only relationship_type succeeds (200)',
    reassignRelationshipResult.status === 200 &&
      reassignRelationshipResult.body.assignment.house_id === house2.id &&
      reassignRelationshipResult.body.assignment.society_member_id === memberId &&
      reassignRelationshipResult.body.assignment.relationship_type === 'Tenant',
    reassignRelationshipResult.body
  );
  const finalAssignmentId = reassignRelationshipResult.body.assignment.id;

  const activeListFinal = await get('/assignments?status=Active', adminToken);
  check(
    'GET /assignments?status=Active (200) reflects the final reassigned row',
    activeListFinal.status === 200 && (activeListFinal.body || []).some((a) => a.id === finalAssignmentId && a.relationshipType === 'Tenant')
  );

  // --- Last-Owner guard, in isolation: a house must always have an
  // Active Owner of record. Own throwaway houses/members, untangled from
  // the reassign-mechanics flow above. ---
  const { data: guardHouse1, error: guardHouse1Error } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: SOCIETY_ID, house_number: `G1-${houseTag}`, type: 'Flat', default_monthly_amount: 1000 })
    .select()
    .single();
  if (guardHouse1Error) throw new Error(`setup guardHouse1 insert failed: ${guardHouse1Error.message}`);
  const { data: guardHouse2, error: guardHouse2Error } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: SOCIETY_ID, house_number: `G2-${houseTag}`, type: 'Flat', default_monthly_amount: 1000 })
    .select()
    .single();
  if (guardHouse2Error) throw new Error(`setup guardHouse2 insert failed: ${guardHouse2Error.message}`);

  const ownerAResult = await post('/members', adminToken, { society_id: SOCIETY_ID, email: `${testTag.toLowerCase()}ownera@example.com`, name: 'Owner A', password: memberPassword });
  const ownerAId = ownerAResult.body.id;
  createdMemberIds.push(ownerAId);
  createdAuthUserIds.push(ownerAResult.body.auth_user_id);

  const ownerBResult = await post('/members', adminToken, { society_id: SOCIETY_ID, email: `${testTag.toLowerCase()}ownerb@example.com`, name: 'Owner B', password: memberPassword });
  const ownerBId = ownerBResult.body.id;
  createdMemberIds.push(ownerBId);
  createdAuthUserIds.push(ownerBResult.body.auth_user_id);

  const { data: soleOwnerAssignment, error: soleOwnerError } = await supabaseAdmin
    .from('resident_house_assignments')
    .insert({ society_member_id: ownerAId, house_id: guardHouse1.id, relationship_type: 'Owner', status: 'Active', approved_at: new Date().toISOString() })
    .select()
    .single();
  if (soleOwnerError) throw new Error(`setup soleOwnerAssignment insert failed: ${soleOwnerError.message}`);

  const revokeSoleOwnerBlocked = await post(`/assignments/${soleOwnerAssignment.id}/revoke`, adminToken);
  check(
    "revoking a house's ONLY Active Owner is blocked (409) with no replacement",
    revokeSoleOwnerBlocked.status === 409 && /Owner/i.test(revokeSoleOwnerBlocked.body.error || ''),
    revokeSoleOwnerBlocked
  );

  const reassignSoleOwnerAwayBlocked = await post(`/assignments/${soleOwnerAssignment.id}/reassign`, adminToken, { house_id: guardHouse2.id });
  check(
    "reassigning a house's ONLY Active Owner to a different house is blocked (409) with no replacement left behind",
    reassignSoleOwnerAwayBlocked.status === 409 && /Owner/i.test(reassignSoleOwnerAwayBlocked.body.error || ''),
    reassignSoleOwnerAwayBlocked
  );

  // Same-house Owner-to-Owner member swap IS allowed - the new row is its
  // own replacement, so guardHouse1 is never actually left ownerless.
  const swapOwnerResult = await post(`/assignments/${soleOwnerAssignment.id}/reassign`, adminToken, { society_member_id: ownerBId });
  check(
    'reassigning the sole Owner to a different member on the SAME house succeeds (200) - the new row is its own replacement',
    swapOwnerResult.status === 200 &&
      swapOwnerResult.body.assignment.status === 'Active' &&
      swapOwnerResult.body.assignment.relationship_type === 'Owner' &&
      swapOwnerResult.body.assignment.society_member_id === ownerBId,
    swapOwnerResult.body
  );
  const swappedOwnerAssignmentId = swapOwnerResult.body.assignment.id;

  // Add a genuine second Owner alongside it, then prove revoking either
  // one now succeeds while the other remains.
  const { data: coOwnerAssignment, error: coOwnerError } = await supabaseAdmin
    .from('resident_house_assignments')
    .insert({ society_member_id: ownerAId, house_id: guardHouse1.id, relationship_type: 'Owner', status: 'Active', approved_at: new Date().toISOString() })
    .select()
    .single();
  if (coOwnerError) throw new Error(`setup coOwnerAssignment insert failed: ${coOwnerError.message}`);

  const revokeWithCoOwnerSucceeds = await post(`/assignments/${swappedOwnerAssignmentId}/revoke`, adminToken);
  check(
    'once a co-owner exists, revoking the other Active Owner now succeeds (200)',
    revokeWithCoOwnerSucceeds.status === 200 && revokeWithCoOwnerSucceeds.body.status === 'Revoked',
    revokeWithCoOwnerSucceeds.body
  );

  // ...which leaves coOwnerAssignment as guardHouse1's sole Owner again -
  // blocked once more, proving the check is re-evaluated live each time,
  // not cached from the earlier "a co-owner exists" state.
  const revokeLastOwnerBlockedAgain = await post(`/assignments/${coOwnerAssignment.id}/revoke`, adminToken);
  check(
    'with the co-owner now gone, revoking the last remaining Owner is blocked (409) again',
    revokeLastOwnerBlockedAgain.status === 409,
    revokeLastOwnerBlockedAgain
  );

  // A Tenant/Occupant assignment is never subject to this guard at all,
  // even as a house's only assignment of any kind.
  const soleTenantResult = await post('/assignments', adminToken, { society_id: SOCIETY_ID, society_member_id: memberId, house_id: guardHouse2.id, relationship_type: 'Tenant' });
  const soleTenantId = soleTenantResult.body.id;
  const approveSoleTenant = await post(`/assignments/${soleTenantId}/approve`, adminToken);
  check('setup: a sole Tenant assignment on guardHouse2 is created and approved', approveSoleTenant.status === 200, approveSoleTenant.body);
  const revokeSoleTenant = await post(`/assignments/${soleTenantId}/revoke`, adminToken);
  check(
    "revoking a house's only Tenant assignment is unaffected by the Owner-only guard (200)",
    revokeSoleTenant.status === 200 && revokeSoleTenant.body.status === 'Revoked',
    revokeSoleTenant.body
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // --- Cleanup ---
  const { error: cleanupAuditError } = await supabaseAdmin
    .from('audit_events')
    .delete()
    .eq('entity_type', 'resident_house_assignment')
    .eq('actor_user_id', ADMIN_AUTH_USER_ID)
    .gte('created_at', testStartedAt);
  if (cleanupAuditError) console.error('cleanup: deleting assignment audit_events failed:', cleanupAuditError.message);

  if (society2Id) {
    const { error: cleanupSociety2Error } = await supabaseAdmin.from('societies').delete().eq('id', society2Id);
    if (cleanupSociety2Error) console.error('cleanup: deleting society2 failed:', cleanupSociety2Error.message);
  }
  const { error: cleanupHousesError } = await supabaseAdmin.from('houses').delete().in('id', [house1.id, house2.id, guardHouse1.id, guardHouse2.id]);
  if (cleanupHousesError) console.error('cleanup: deleting houses failed:', cleanupHousesError.message);

  if (createdMemberIds.length > 0) {
    await supabaseAdmin.from('audit_events').delete().in('entity_id', createdMemberIds);
    const { error: cleanupMembersError } = await supabaseAdmin.from('society_members').delete().in('id', createdMemberIds);
    if (cleanupMembersError) console.error('cleanup: deleting members failed:', cleanupMembersError.message);
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
