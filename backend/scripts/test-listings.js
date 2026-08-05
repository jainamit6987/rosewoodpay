// Verifies GET /houses/listings (backend/src/routes/houses.js) - the
// resident-facing "Society Listings" endpoint behind SocietyListingsScreen.
// Unlike GET /houses/:houseId/profile (scoped to just the two people
// sharing one house), this is a society-wide noticeboard: ANY Active
// member of a society can see EVERY house in that society currently marked
// available_to_rent, along with its Owner's own name/mobile/email - a
// deliberately wider trust boundary, discussed directly with the user.
// Everything runs against throwaway houses/members created and deleted by
// this script; reads live Admin credentials from the DB rather than
// hardcoding the drifted fixture (same approach as test-house-profile.js/
// test-available-to-rent.js).
// Requires the server running (npm run dev). Run with:
//   node scripts/test-listings.js
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

  const testTag = `TESTLIST${Date.now()}`;
  const houseTag = `${Date.now() % 1000000}`; // house_number is VARCHAR(20)
  const createdMemberIds = [];
  const createdAuthUserIds = [];
  const createdHouseIds = [];

  check('unauthenticated GET /houses/listings is rejected (401)', (await get(`/houses/listings?society_id=${societyId}`, null)).status === 401);
  check('missing society_id is rejected (400)', (await get('/houses/listings', adminToken)).status === 400);

  // --- Listed house A, with an Owner who has turned the flag on ---
  const { data: houseA, error: houseAError } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: societyId, house_number: `LA-${houseTag}`, type: 'Flat', default_monthly_amount: 1000 })
    .select('id')
    .single();
  if (houseAError) throw new Error(`setup failed creating houseA: ${houseAError.message}`);
  createdHouseIds.push(houseA.id);

  const ownerPassword = `Owner${Date.now()}Pw!`;
  const ownerEmail = `${testTag.toLowerCase()}owner@example.com`;
  const owner = await post('/members', adminToken, {
    society_id: societyId,
    email: ownerEmail,
    name: 'Listing Owner',
    phone_number: '9000000011',
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

  const turnOn = await patch(`/houses/${houseA.id}/available-to-rent`, ownerToken, { available_to_rent: true });
  check('setup: Owner turns houseA available to rent on (200)', turnOn.status === 200, turnOn.body);

  // --- A second, NOT-listed house B in the same society - must not appear ---
  const { data: houseB, error: houseBError } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: societyId, house_number: `LB-${houseTag}`, type: 'Flat', default_monthly_amount: 1000 })
    .select('id')
    .single();
  if (houseBError) throw new Error(`setup failed creating houseB: ${houseBError.message}`);
  createdHouseIds.push(houseB.id);

  // --- A wholly unrelated member of the SAME society, with no assignment
  // on houseA at all - listings is society-wide, not house-specific, so
  // this caller should still see it. ---
  const strangerPassword = `Stranger${Date.now()}Pw!`;
  const strangerEmail = `${testTag.toLowerCase()}stranger@example.com`;
  const stranger = await post('/members', adminToken, {
    society_id: societyId,
    email: strangerEmail,
    name: 'Unrelated Member',
    password: strangerPassword,
  });
  createdMemberIds.push(stranger.body.id);
  createdAuthUserIds.push(stranger.body.auth_user_id);
  const strangerToken = await loginToken(strangerEmail, strangerPassword);

  const strangerView = await get(`/houses/listings?society_id=${societyId}`, strangerToken);
  check(
    'a member with NO assignment on houseA at all can still see it listed (200)',
    strangerView.status === 200,
    strangerView.body
  );
  const listedA = (strangerView.body || []).find((l) => l.id === houseA.id);
  check('houseA appears in the listings response', !!listedA, strangerView.body);
  check(
    "the listing exposes the Owner's own contact info directly",
    listedA?.owner?.name === 'Listing Owner' && listedA?.owner?.phoneNumber === '9000000011',
    listedA
  );
  check('houseB (never listed) does NOT appear', !(strangerView.body || []).some((l) => l.id === houseB.id));

  // --- A society_id the caller does not belong to returns an empty array,
  // not an error (RLS silently filters, same pattern as GET /houses/search) ---
  const { data: otherSociety } = await supabaseAdmin
    .from('societies')
    .select('id')
    .neq('id', societyId)
    .limit(1)
    .maybeSingle();
  if (otherSociety) {
    const otherSocietyView = await get(`/houses/listings?society_id=${otherSociety.id}`, strangerToken);
    check(
      'a society_id the caller does not belong to returns an empty array (200, not an error)',
      otherSocietyView.status === 200 && Array.isArray(otherSocietyView.body) && otherSocietyView.body.length === 0,
      otherSocietyView.body
    );
  } else {
    console.log('SKIP - only one society exists in this DB, cannot test the cross-society empty-result case');
  }

  // --- Owner withdraws the listing - should disappear ---
  const turnOff = await patch(`/houses/${houseA.id}/available-to-rent`, ownerToken, { available_to_rent: false });
  check('setup: Owner withdraws the listing (200)', turnOff.status === 200, turnOff.body);
  const afterWithdraw = await get(`/houses/listings?society_id=${societyId}`, strangerToken);
  check(
    'after withdrawing, houseA no longer appears in listings',
    !(afterWithdraw.body || []).some((l) => l.id === houseA.id),
    afterWithdraw.body
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  await supabaseAdmin.from('audit_events').delete().in('entity_id', [houseA.id, houseB.id]);
  await supabaseAdmin.from('society_members').delete().in('id', createdMemberIds);
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
