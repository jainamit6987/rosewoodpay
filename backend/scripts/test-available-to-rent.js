// Verifies PATCH /houses/:houseId/available-to-rent (backend/src/routes/
// houses.js) and the auto-clear side effect wired into POST /assignments/
// :id/approve and /:id/reassign (backend/src/routes/assignments.js) - see
// 20260805000000_add_available_to_rent_to_houses.sql. Everything runs
// against throwaway houses/members created and deleted by this script;
// reads live Admin credentials from the DB rather than hardcoding the
// drifted admin@society.app/password fixture (same approach as
// test-reset-password.js - see that file's own note).
// Requires the server running (npm run dev) AND this migration already
// applied via Supabase Studio SQL Editor. Run with:
//   node scripts/test-available-to-rent.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const SEED_PASSWORD = 'password123';

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

async function getAvailableToRent(houseId) {
  const { data } = await supabaseAdmin.from('houses').select('available_to_rent').eq('id', houseId).single();
  return data.available_to_rent;
}

async function findActiveAdminSociety() {
  const { data: admins } = await supabaseAdmin
    .from('society_members')
    .select('id, society_id, auth_user_id')
    .eq('is_admin', true)
    .eq('status', 'Active')
    .limit(1);
  if (!admins || admins.length === 0) throw new Error('setup: no Active Admin found in the DB to test against.');
  const { data: usersPage } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const emailById = new Map(usersPage.users.map((u) => [u.id, u.email]));
  return { societyId: admins[0].society_id, adminEmail: emailById.get(admins[0].auth_user_id) };
}

async function main() {
  const { societyId, adminEmail } = await findActiveAdminSociety();
  const adminToken = await loginToken(adminEmail, SEED_PASSWORD);
  check('setup: found a live Active Admin/society to test against', !!societyId && !!adminEmail);

  const testTag = `TESTRENT${Date.now()}`;
  const houseTag = `${Date.now() % 1000000}`; // house_number is VARCHAR(20) - testTag alone is already too long
  const createdMemberIds = [];
  const createdAuthUserIds = [];
  const createdHouseIds = [];

  // --- Throwaway house A (the one whose flag this test toggles) + its Owner ---
  const { data: houseA, error: houseAError } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: societyId, house_number: `RA-${houseTag}`, type: 'Flat', default_monthly_amount: 1000 })
    .select('id')
    .single();
  if (houseAError) throw new Error(`setup failed creating houseA: ${houseAError.message}`);
  createdHouseIds.push(houseA.id);

  const ownerPassword = `Owner${Date.now()}Pw!`;
  const ownerEmail = `${testTag.toLowerCase()}owner@example.com`;
  const owner = await post('/members', adminToken, {
    society_id: societyId,
    email: ownerEmail,
    name: 'Throwaway Owner',
    password: ownerPassword,
  });
  createdMemberIds.push(owner.body.id);
  createdAuthUserIds.push(owner.body.auth_user_id);
  const ownerToken = await loginToken(ownerEmail, ownerPassword);

  const ownerAssignment = await post('/assignments', adminToken, {
    society_id: societyId,
    society_member_id: owner.body.id,
    house_id: houseA.id,
    relationship_type: 'Owner',
  });
  await post(`/assignments/${ownerAssignment.body.id}/approve`, adminToken);

  // --- Auth/authorization gates ---
  check(
    'unauthenticated PATCH .../available-to-rent is rejected (401)',
    (await patch(`/houses/${houseA.id}/available-to-rent`, null, { available_to_rent: true })).status === 401
  );
  check(
    'a non-boolean value is rejected (400)',
    (await patch(`/houses/${houseA.id}/available-to-rent`, ownerToken, { available_to_rent: 'yes' })).status === 400
  );
  check(
    'even the Admin (not the Owner) cannot toggle this house\'s flag (403)',
    (await patch(`/houses/${houseA.id}/available-to-rent`, adminToken, { available_to_rent: true })).status === 403
  );

  // --- Happy path: Owner turns it on ---
  const turnOn = await patch(`/houses/${houseA.id}/available-to-rent`, ownerToken, { available_to_rent: true });
  check(
    'the Owner CAN mark their own house available to rent (200)',
    turnOn.status === 200 && turnOn.body.available_to_rent === true,
    turnOn.body
  );
  check('the flag is actually true in the DB', (await getAvailableToRent(houseA.id)) === true);

  const meAfterOn = await get('/me', ownerToken);
  const meHouseA = (meAfterOn.body.memberships || [])
    .flatMap((m) => m.houseAssignments || [])
    .find((a) => a.houses?.id === houseA.id);
  check('GET /me reflects available_to_rent=true for the owner\'s own house', meHouseA?.houses?.available_to_rent === true, meHouseA);

  const repeatOn = await patch(`/houses/${houseA.id}/available-to-rent`, ownerToken, { available_to_rent: true });
  check('setting the SAME value again is rejected (409)', repeatOn.status === 409, repeatOn.body);

  // --- Auto-clear via /approve: approving a new Tenant assignment on
  // houseA should flip the flag back to false ---
  const tenantPassword = `Tenant${Date.now()}Pw!`;
  const tenantEmail = `${testTag.toLowerCase()}tenant@example.com`;
  const tenant = await post('/members', adminToken, {
    society_id: societyId,
    email: tenantEmail,
    name: 'Throwaway Tenant',
    password: tenantPassword,
  });
  createdMemberIds.push(tenant.body.id);
  createdAuthUserIds.push(tenant.body.auth_user_id);

  const tenantAssignment = await post('/assignments', adminToken, {
    society_id: societyId,
    society_member_id: tenant.body.id,
    house_id: houseA.id,
    relationship_type: 'Tenant',
  });
  const approveTenant = await post(`/assignments/${tenantAssignment.body.id}/approve`, adminToken);
  check('setup: approving the new Tenant assignment succeeds (200)', approveTenant.status === 200, approveTenant.body);
  check(
    'auto-clear: available_to_rent flips back to false once the Tenant assignment goes Active',
    (await getAvailableToRent(houseA.id)) === false
  );

  const { data: autoClearAudit } = await supabaseAdmin
    .from('audit_events')
    .select('id')
    .eq('entity_id', houseA.id)
    .eq('action', 'AutoDelistedOnNewTenant');
  check('the auto-clear wrote its own AutoDelistedOnNewTenant audit_events row', (autoClearAudit || []).length >= 1, autoClearAudit);

  // --- Approving a co-Owner should NOT clear the flag - only Tenant/
  // Occupant does. The flag is already false here (auto-cleared above by
  // the Tenant approval), so just turn it back on. ---
  const turnOnAgain = await patch(`/houses/${houseA.id}/available-to-rent`, ownerToken, { available_to_rent: true });
  check('setup: Owner turns the flag on again (200)', turnOnAgain.status === 200, turnOnAgain.body);

  const coOwnerPassword = `CoOwner${Date.now()}Pw!`;
  const coOwnerEmail = `${testTag.toLowerCase()}coowner@example.com`;
  const coOwner = await post('/members', adminToken, {
    society_id: societyId,
    email: coOwnerEmail,
    name: 'Throwaway Co-Owner',
    password: coOwnerPassword,
  });
  createdMemberIds.push(coOwner.body.id);
  createdAuthUserIds.push(coOwner.body.auth_user_id);

  const coOwnerAssignment = await post('/assignments', adminToken, {
    society_id: societyId,
    society_member_id: coOwner.body.id,
    house_id: houseA.id,
    relationship_type: 'Owner',
  });
  const approveCoOwner = await post(`/assignments/${coOwnerAssignment.body.id}/approve`, adminToken);
  check('setup: approving a co-Owner assignment succeeds (200)', approveCoOwner.status === 200, approveCoOwner.body);
  check(
    'approving an Owner (not Tenant/Occupant) assignment does NOT clear the flag',
    (await getAvailableToRent(houseA.id)) === true
  );

  // --- Auto-clear via /reassign: reassigning an unrelated Active
  // assignment onto houseA as a Tenant should also clear the flag ---
  const { data: houseB, error: houseBError } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: societyId, house_number: `RB-${houseTag}`, type: 'Flat', default_monthly_amount: 1000 })
    .select('id')
    .single();
  if (houseBError) throw new Error(`setup failed creating houseB: ${houseBError.message}`);
  createdHouseIds.push(houseB.id);

  const wanderPassword = `Wander${Date.now()}Pw!`;
  const wanderEmail = `${testTag.toLowerCase()}wander@example.com`;
  const wanderer = await post('/members', adminToken, {
    society_id: societyId,
    email: wanderEmail,
    name: 'Throwaway Wanderer',
    password: wanderPassword,
  });
  createdMemberIds.push(wanderer.body.id);
  createdAuthUserIds.push(wanderer.body.auth_user_id);

  const wandererAssignment = await post('/assignments', adminToken, {
    society_id: societyId,
    society_member_id: wanderer.body.id,
    house_id: houseB.id,
    relationship_type: 'Occupant',
  });
  await post(`/assignments/${wandererAssignment.body.id}/approve`, adminToken);

  const reassignToHouseA = await post(`/assignments/${wandererAssignment.body.id}/reassign`, adminToken, {
    house_id: houseA.id,
    relationship_type: 'Tenant',
  });
  check('setup: reassigning the wanderer onto houseA as Tenant succeeds (200)', reassignToHouseA.status === 200, reassignToHouseA.body);
  check(
    'auto-clear also fires via /reassign, not just /approve',
    (await getAvailableToRent(houseA.id)) === false
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // --- Cleanup ---
  await supabaseAdmin.from('audit_events').delete().in('entity_id', [houseA.id, houseB.id, ...createdMemberIds]);
  if (createdMemberIds.length > 0) {
    await supabaseAdmin.from('society_members').delete().in('id', createdMemberIds);
  }
  await supabaseAdmin.from('houses').delete().in('id', createdHouseIds);
  for (const authUserId of createdAuthUserIds) {
    await supabaseAdmin.auth.admin.deleteUser(authUserId).catch(() => {});
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
