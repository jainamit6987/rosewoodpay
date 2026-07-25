// Verifies GET /transactions/pending: the Admin/Committee dashboard feed
// that makes /:id/verify and /:id/reject actually usable (list what needs
// review, across a whole society, instead of already knowing a specific
// house id). Requires the server to be running (npm run dev) and
// migration 20260726000000_replace_role_with_boolean_flags.sql applied.
// Run with: node scripts/test-pending-transactions.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const HOUSE_A101 = '00000006-0000-0000-0000-000000000006';
const HOUSE_R24 = '00000007-0000-0000-0000-000000000007';

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

async function post(path, token, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const residentToken = await loginToken('resident@society.app', 'password');
  const adminToken = await loginToken('admin@society.app', 'password');

  const noAuth = await get('/transactions/pending', null);
  check('unauthenticated request is rejected (401)', noAuth.status === 401, noAuth);

  const residentAttempt = await get('/transactions/pending', residentToken);
  check(
    'a plain resident (not Admin/Committee anywhere) cannot list pending transactions (403)',
    residentAttempt.status === 403,
    residentAttempt
  );

  // Two fresh Submitted transactions, on two different houses, with a
  // deliberate small gap so their created_at timestamps are unambiguously
  // ordered - proves the "oldest first" ordering, not just "both present".
  const firstUtr = `TESTPENDING${Date.now()}A`;
  const first = await post('/transactions', residentToken, {
    house_id: HOUSE_A101,
    amount: 2200,
    utr_number: firstUtr,
  });
  await sleep(300);
  const secondUtr = `TESTPENDING${Date.now()}B`;
  const second = await post('/transactions', adminToken, {
    house_id: HOUSE_R24,
    amount: 2500,
    utr_number: secondUtr,
  });

  check('setup: both test transactions submitted', first.status === 201 && second.status === 201, { first, second });

  const pending = await get('/transactions/pending', adminToken);
  check('admin can list pending transactions (200, an array)', pending.status === 200 && Array.isArray(pending.body), pending);

  const ids = (pending.body || []).map((t) => t.id);
  check('the list includes both freshly-submitted transactions', ids.includes(first.body.id) && ids.includes(second.body.id), ids);

  check(
    'the list also includes the persistent seeded Submitted transaction (SEEDTENANTR24PAYMENT) - proves society-wide aggregation, not just this test\'s own rows',
    (pending.body || []).some((t) => t.utr_number === 'SEEDTENANTR24PAYMENT'),
    pending.body
  );

  check(
    'every listed transaction is actually Submitted (the filter is real, not decorative)',
    (pending.body || []).every((t) => t.processing_status === 'Submitted'),
    pending.body
  );

  const firstIndex = ids.indexOf(first.body.id);
  const secondIndex = ids.indexOf(second.body.id);
  check('results are ordered oldest-first (first submitted appears before the second)', firstIndex < secondIndex, {
    firstIndex,
    secondIndex,
  });

  check(
    'each item includes its house number for display',
    (pending.body || []).find((t) => t.id === first.body.id)?.houses?.house_number === 'A-101',
    pending.body
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // Cascades to transaction_allocations automatically (ON DELETE CASCADE).
  await supabaseAdmin.from('transactions').delete().like('utr_number', 'TESTPENDING%');

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
