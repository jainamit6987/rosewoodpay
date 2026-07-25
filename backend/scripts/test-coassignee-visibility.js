// Verifies the "widen transaction visibility to co-assignees" fix: an owner
// who rents out a house to a tenant can see the tenant's payment for that
// shared house, even though the owner never submitted it themselves - while
// a resident with no assignment to that house still sees nothing.
// Requires the server to be running (npm start) and the seed fixtures from
// supabase/seed.sql (owner2@society.app, tenant@society.app, house R-24) to
// already exist in the connected project. Run with:
//   node scripts/test-coassignee-visibility.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');

const BASE_URL = `http://localhost:${env.port}`;
const HOUSE_R24 = '00000007-0000-0000-0000-000000000007'; // Owner2 owns it, Tenant rents and pays for it
const HOUSE_A101 = '00000006-0000-0000-0000-000000000006'; // Resident's own house, unrelated to R-24
const SEEDED_TENANT_UTR = 'SEEDTENANTR24PAYMENT';

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
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function main() {
  const owner2Token = await loginToken('owner2@society.app', 'password');
  const tenantToken = await loginToken('tenant@society.app', 'password');
  const residentToken = await loginToken('resident@society.app', 'password');

  const ownerView = await get(`/houses/${HOUSE_R24}/transactions`, owner2Token);
  check(
    'Owner2 (co-assignee, never submitted anything for R-24) CAN see the Tenant\'s R-24 transaction',
    ownerView.status === 200 &&
      Array.isArray(ownerView.body) &&
      ownerView.body.some((t) => t.utr_number === SEEDED_TENANT_UTR),
    ownerView
  );

  const tenantView = await get(`/houses/${HOUSE_R24}/transactions`, tenantToken);
  check(
    'Tenant (submitter) CAN see their own R-24 transaction',
    tenantView.status === 200 &&
      Array.isArray(tenantView.body) &&
      tenantView.body.some((t) => t.utr_number === SEEDED_TENANT_UTR),
    tenantView
  );

  const unrelatedView = await get(`/houses/${HOUSE_R24}/transactions`, residentToken);
  check(
    'Unrelated resident (no assignment to R-24) does NOT see the Tenant\'s R-24 transaction',
    unrelatedView.status === 200 &&
      Array.isArray(unrelatedView.body) &&
      !unrelatedView.body.some((t) => t.utr_number === SEEDED_TENANT_UTR),
    unrelatedView
  );

  const noAuth = await get(`/houses/${HOUSE_R24}/transactions`, null);
  check('unauthenticated request is rejected (401)', noAuth.status === 401, noAuth);

  const ownHouseStillWorks = await get(`/houses/${HOUSE_A101}/transactions`, residentToken);
  check(
    'resident can still list transactions for their own unrelated house (A-101), even if empty',
    ownHouseStillWorks.status === 200 && Array.isArray(ownHouseStillWorks.body),
    ownHouseStillWorks
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
