// Verifies GET /houses/:houseId/profile (backend/src/routes/houses.js) -
// the resident-facing endpoint behind the new HouseProfileScreen. Unlike
// GET /houses/:houseId/dashboard (Admin/Committee-only), this one is for
// the house's own Owner/Tenant/Occupant, and deliberately shows each of
// them the OTHER's contact info - the new trust boundary discussed
// directly with the user. Everything runs against throwaway houses/
// members created and deleted by this script; reads live Admin
// credentials from the DB rather than hardcoding the drifted fixture
// (same approach as test-reset-password.js/test-available-to-rent.js).
// Requires the server running (npm run dev). Run with:
//   node scripts/test-house-profile.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;

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
  const adminToken = await loginToken(adminEmail, 'password123');
  check('setup: found a live Active Admin/society to test against', !!societyId && !!adminEmail);

  const testTag = `TESTPROFILE${Date.now()}`;
  const houseTag = `${Date.now() % 1000000}`;
  const createdMemberIds = [];
  const createdAuthUserIds = [];
  const createdHouseIds = [];

  const { data: house, error: houseInsertError } = await supabaseAdmin
    .from('houses')
    .insert({
      society_id: societyId,
      house_number: `PR-${houseTag}`,
      type: 'Flat',
      owner_name: 'Recorded Owner Text',
      default_monthly_amount: 1000,
    })
    .select('id')
    .single();
  if (houseInsertError) throw new Error(`setup failed creating house: ${houseInsertError.message}`);
  createdHouseIds.push(house.id);

  const ownerPassword = `Owner${Date.now()}Pw!`;
  const ownerEmail = `${testTag.toLowerCase()}owner@example.com`;
  const owner = await post('/members', adminToken, {
    society_id: societyId,
    email: ownerEmail,
    name: 'Real Owner Member',
    phone_number: '9000000001',
    password: ownerPassword,
  });
  createdMemberIds.push(owner.body.id);
  createdAuthUserIds.push(owner.body.auth_user_id);
  const ownerToken = await loginToken(ownerEmail, ownerPassword);

  const ownerAssignment = await post('/assignments', adminToken, {
    society_id: societyId,
    society_member_id: owner.body.id,
    house_id: house.id,
    relationship_type: 'Owner',
  });
  await post(`/assignments/${ownerAssignment.body.id}/approve`, adminToken);

  const tenantPassword = `Tenant${Date.now()}Pw!`;
  const tenantEmail = `${testTag.toLowerCase()}tenant@example.com`;
  const tenant = await post('/members', adminToken, {
    society_id: societyId,
    email: tenantEmail,
    name: 'Real Tenant Member',
    phone_number: '9000000002',
    password: tenantPassword,
  });
  createdMemberIds.push(tenant.body.id);
  createdAuthUserIds.push(tenant.body.auth_user_id);
  const tenantToken = await loginToken(tenantEmail, tenantPassword);

  const tenantAssignment = await post('/assignments', adminToken, {
    society_id: societyId,
    society_member_id: tenant.body.id,
    house_id: house.id,
    relationship_type: 'Tenant',
  });
  await post(`/assignments/${tenantAssignment.body.id}/approve`, adminToken);

  // --- Auth/authorization gates ---
  check(
    'unauthenticated GET .../profile is rejected (401)',
    (await get(`/houses/${house.id}/profile`, null)).status === 401
  );

  const outsiderPassword = `Outsider${Date.now()}Pw!`;
  const outsiderEmail = `${testTag.toLowerCase()}outsider@example.com`;
  const outsider = await post('/members', adminToken, {
    society_id: societyId,
    email: outsiderEmail,
    name: 'Unrelated Member',
    password: outsiderPassword,
  });
  createdMemberIds.push(outsider.body.id);
  createdAuthUserIds.push(outsider.body.auth_user_id);
  const outsiderToken = await loginToken(outsiderEmail, outsiderPassword);
  check(
    'a member with no assignment on this house is rejected (403)',
    (await get(`/houses/${house.id}/profile`, outsiderToken)).status === 403
  );
  check(
    "even the Admin (not a resident of this house) can't view its profile (403)",
    (await get(`/houses/${house.id}/profile`, adminToken)).status === 403
  );

  // --- Owner's own view ---
  const ownerView = await get(`/houses/${house.id}/profile`, ownerToken);
  check('the Owner CAN view the house profile (200)', ownerView.status === 200, ownerView.body);
  check(
    'Owner Name still comes from the house\'s own owner_name text field',
    ownerView.body.house?.owner_name === 'Recorded Owner Text'
  );
  check('viewerRelationshipType correctly reports Owner', ownerView.body.viewerRelationshipType === 'Owner');
  check('the Owner sees their OWN contact info under owner.*', ownerView.body.owner?.phoneNumber === '9000000001');
  check(
    "the Owner ALSO sees the Tenant's contact info (the new cross-resident visibility)",
    ownerView.body.tenant?.name === 'Real Tenant Member' && ownerView.body.tenant?.phoneNumber === '9000000002',
    ownerView.body.tenant
  );

  // --- Tenant's own view - the symmetric case ---
  const tenantView = await get(`/houses/${house.id}/profile`, tenantToken);
  check('the Tenant CAN also view the house profile (200)', tenantView.status === 200, tenantView.body);
  check('viewerRelationshipType correctly reports Tenant for the tenant', tenantView.body.viewerRelationshipType === 'Tenant');
  check(
    "the Tenant sees the Owner's contact info too (symmetric visibility)",
    tenantView.body.owner?.name === 'Real Owner Member' && tenantView.body.owner?.phoneNumber === '9000000001',
    tenantView.body.owner
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

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
