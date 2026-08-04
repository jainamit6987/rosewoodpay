// Verifies POST /members/:id/reset-password in backend/src/routes/members.js -
// the Admin-facing "someone forgot their password" recovery path, added
// since there is no email/SMTP provider configured anywhere in this
// project (see generateTemporaryPassword's own comment in members.js). Uses
// a throwaway member created and deleted entirely by this script, never
// touching any real seeded account - and does NOT hardcode old
// admin@society.app/resident@society.app fixture logins (drifted since the
// Rosewood Century reseed; see test-members.js and others, left
// intentionally unfixed per the user's own call), reading the current
// Admin/resident credentials from the live DB instead.
// Requires the server running (npm run dev). Run with:
//   node scripts/test-reset-password.js
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

async function findActiveAdminAndResident() {
  const { data: admins } = await supabaseAdmin
    .from('society_members')
    .select('id, society_id, auth_user_id, is_admin, status')
    .eq('is_admin', true)
    .eq('status', 'Active')
    .limit(1);
  if (!admins || admins.length === 0) throw new Error('setup: no Active Admin found in the DB to test against.');
  const admin = admins[0];

  const { data: residents } = await supabaseAdmin
    .from('society_members')
    .select('id, society_id, auth_user_id, is_admin, is_committee_member, status')
    .eq('society_id', admin.society_id)
    .eq('is_admin', false)
    .eq('is_committee_member', false)
    .eq('status', 'Active')
    .limit(1);
  if (!residents || residents.length === 0) throw new Error('setup: no plain Active resident found in the same society.');

  const { data: usersPage } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const emailById = new Map(usersPage.users.map((u) => [u.id, u.email]));

  return {
    adminId: admin.id,
    societyId: admin.society_id,
    adminEmail: emailById.get(admin.auth_user_id),
    residentId: residents[0].id,
    residentEmail: emailById.get(residents[0].auth_user_id),
  };
}

async function main() {
  const { adminId, societyId, adminEmail, residentId, residentEmail } = await findActiveAdminAndResident();
  const adminToken = await loginToken(adminEmail, SEED_PASSWORD);
  const residentToken = await loginToken(residentEmail, SEED_PASSWORD);

  check('setup: found a live Active Admin and plain resident to test against', !!adminEmail && !!residentEmail, {
    adminEmail,
    residentEmail,
  });

  // --- Auth/authorization gates ---
  check(
    'unauthenticated POST /members/:id/reset-password is rejected (401)',
    (await post('/members/x/reset-password', null)).status === 401
  );
  check(
    'a plain resident cannot reset anyone\'s password (403 or 404 - not visible under RLS)',
    [403, 404].includes((await post(`/members/${adminId}/reset-password`, residentToken)).status)
  );
  check(
    'resetting a nonexistent member is rejected (404)',
    (await post('/members/00000000-0000-0000-0000-000000000000/reset-password', adminToken)).status === 404
  );

  // --- Throwaway member: created, reset, deleted - never touches a real
  // seeded account's actual password. ---
  const testTag = `TESTRESET${Date.now()}`;
  const throwawayEmail = `${testTag.toLowerCase()}@example.com`;
  const originalPassword = `Orig${Date.now()}Pw!`;

  const created = await post('/members', adminToken, {
    society_id: societyId,
    email: throwawayEmail,
    name: 'Throwaway Reset Target',
    password: originalPassword,
  });
  check('setup: created a throwaway member with a known password (201)', created.status === 201, created.body);
  const throwawayId = created.body.id;
  const throwawayAuthUserId = created.body.auth_user_id;

  const beforeResetSignIn = await canSignIn(throwawayEmail, originalPassword);
  check('BEFORE reset: the throwaway member can sign in with their original password', beforeResetSignIn === true);

  const reset = await post(`/members/${throwawayId}/reset-password`, adminToken);
  check(
    'Admin resetting the throwaway member\'s password succeeds (200) with a fresh temp password',
    reset.status === 200 &&
      typeof reset.body.temporaryPassword === 'string' &&
      reset.body.temporaryPassword.length >= 6 &&
      reset.body.temporaryPassword !== originalPassword,
    reset.body
  );
  const newPassword = reset.body.temporaryPassword;

  const afterResetOldSignIn = await canSignIn(throwawayEmail, originalPassword);
  check('AFTER reset: the OLD password no longer works', afterResetOldSignIn === false);

  const afterResetNewSignIn = await canSignIn(throwawayEmail, newPassword);
  check('AFTER reset: the NEW temporary password signs in successfully', afterResetNewSignIn === true);

  // --- Reset is allowed even while Suspended (it cannot itself lock the
  // calling Admin out, and an Admin may want to line up a password before
  // reactivating someone) ---
  const suspend = await post(`/members/${throwawayId}/suspend`, adminToken);
  check('setup: suspending the throwaway member succeeds (200)', suspend.status === 200, suspend.body);

  const resetWhileSuspended = await post(`/members/${throwawayId}/reset-password`, adminToken);
  check(
    'resetting a Suspended member\'s password is still allowed (200)',
    resetWhileSuspended.status === 200 && typeof resetWhileSuspended.body.temporaryPassword === 'string',
    resetWhileSuspended.body
  );

  const suspendedNewPasswordSignIn = await canSignIn(throwawayEmail, resetWhileSuspended.body.temporaryPassword);
  check(
    'but sign-in still fails regardless (the auth ban from /suspend, not the password itself, blocks it)',
    suspendedNewPasswordSignIn === false
  );

  // --- Audit trail ---
  const { data: auditRows } = await supabaseAdmin
    .from('audit_events')
    .select('action, entity_id')
    .eq('entity_id', throwawayId)
    .eq('action', 'PasswordReset');
  check('each reset wrote its own PasswordReset audit_events row', (auditRows || []).length === 2, auditRows);

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // --- Cleanup ---
  await supabaseAdmin.from('audit_events').delete().eq('entity_id', throwawayId);
  await supabaseAdmin.from('society_members').delete().eq('id', throwawayId);
  if (throwawayAuthUserId) {
    await supabaseAdmin.auth.admin.deleteUser(throwawayAuthUserId).catch(() => {});
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
