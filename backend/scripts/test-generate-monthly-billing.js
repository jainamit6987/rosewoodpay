// Verifies POST /society/:id/billing-periods/generate-next-month
// (backend/src/routes/society.js): Admin-only bulk creation of the next
// billing period for every Active house in a society in one call, each
// house continuing from its own existing cursor (never a gap, never a
// duplicate). Requires the server running (npm run dev) and the full seed
// fixtures from supabase/seed.sql to already exist in the connected
// project (5 seeded Active houses in the one seeded society: A-101, R-24,
// D-404, B-102, C-303).
// Run with: node scripts/test-generate-monthly-billing.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const SOCIETY_ID = '00000003-0000-0000-0000-000000000003';
const FAKE_SOCIETY_ID = '00000000-aaaa-bbbb-cccc-000000000000';
const SEEDED_HOUSE_IDS = [
  '00000006-0000-0000-0000-000000000006', // A-101
  '00000007-0000-0000-0000-000000000007', // R-24
  '00000012-0000-0000-0000-000000000012', // D-404 (Admin's own)
  '0000000c-0000-0000-0000-00000000000c', // B-102
  '0000000f-0000-0000-0000-00000000000f', // C-303 (arrears)
];

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

function currentMonthStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function monthsAheadOfNow(period_month, monthsAhead) {
  const now = new Date();
  const expected = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsAhead, 1));
  return new Date(period_month).toISOString().slice(0, 10) === expected.toISOString().slice(0, 10);
}

async function cleanupFuturePeriods() {
  // Nothing in seed.sql ever describes a period after the current month for
  // any house - so deleting anything beyond that is always safe cleanup,
  // never a risk of deleting real seeded fixture data.
  await supabaseAdmin
    .from('billing_periods')
    .delete()
    .in('house_id', SEEDED_HOUSE_IDS)
    .gt('period_month', currentMonthStart().toISOString().slice(0, 10));
}

async function loginToken(email, password) {
  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`login failed for ${email}: ${error.message}`);
  return data.session.access_token;
}

async function post(path, token) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: '{}',
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  const residentToken = await loginToken('resident@society.app', 'password');
  const adminToken = await loginToken('admin@society.app', 'password');

  await cleanupFuturePeriods();

  // --- Unauthenticated is rejected ---
  check(
    'unauthenticated POST is rejected (401)',
    (await post(`/society/${SOCIETY_ID}/billing-periods/generate-next-month`, null)).status === 401
  );

  // --- A plain resident (not an Admin) cannot trigger it ---
  check(
    'a plain resident cannot generate billing periods (403)',
    (await post(`/society/${SOCIETY_ID}/billing-periods/generate-next-month`, residentToken)).status === 403
  );

  // --- A society the caller does not administer is also 403 (same shape
  //     as PATCH /society/:id - membership check, not existence check) ---
  check(
    'a nonexistent/inaccessible society id is rejected (403)',
    (await post(`/society/${FAKE_SOCIETY_ID}/billing-periods/generate-next-month`, adminToken)).status === 403
  );

  // --- First real run: every one of the 5 seeded Active houses is exactly
  //     in sync (each has only its current-month period so far), so this
  //     should create next month for all 5, skip none ---
  const firstRun = await post(`/society/${SOCIETY_ID}/billing-periods/generate-next-month`, adminToken);
  const firstRunHouseIds = (firstRun.body.created || []).map((c) => c.house_id);
  check(
    'first run creates the next month for all 5 seeded houses, skips none',
    firstRun.status === 200 &&
      Array.isArray(firstRun.body.created) &&
      firstRun.body.created.length === 5 &&
      Array.isArray(firstRun.body.skipped) &&
      firstRun.body.skipped.length === 0 &&
      SEEDED_HOUSE_IDS.every((id) => firstRunHouseIds.includes(id)) &&
      firstRun.body.created.every((c) => monthsAheadOfNow(c.billing_period.period_month, 1)),
    firstRun.body
  );

  // --- Second run right after: since this is keyed off each house's own
  //     cursor (not "does the calendar-next-month already exist"), it
  //     advances every house one further month rather than skipping - this
  //     is the documented, intentional behavior shared with the per-house
  //     POST /houses/:houseId/billing-periods sibling endpoint ---
  const secondRun = await post(`/society/${SOCIETY_ID}/billing-periods/generate-next-month`, adminToken);
  check(
    'a second immediate run advances every house one further month rather than skipping (documented behavior)',
    secondRun.status === 200 &&
      secondRun.body.created.length === 5 &&
      secondRun.body.skipped.length === 0 &&
      secondRun.body.created.every((c) => monthsAheadOfNow(c.billing_period.period_month, 2)),
    secondRun.body
  );

  // --- A house with no default_monthly_amount configured is skipped with
  //     a clear reason, without aborting the rest of the batch ---
  const throwawayHouseTag = `TESTGENBILL${Date.now()}`.slice(0, 20);
  const { data: throwawayHouse, error: houseInsertError } = await supabaseAdmin
    .from('houses')
    .insert({
      society_id: SOCIETY_ID,
      house_number: throwawayHouseTag,
      type: 'Flat',
      default_monthly_amount: null,
    })
    .select('id')
    .single();

  if (houseInsertError) {
    console.error('setup failed: could not create throwaway house', houseInsertError.message);
  }

  const thirdRun = await post(`/society/${SOCIETY_ID}/billing-periods/generate-next-month`, adminToken);
  const skippedThrowaway = (thirdRun.body.skipped || []).find((s) => s.house_id === throwawayHouse?.id);
  check(
    'a house with no default_monthly_amount is skipped with a clear reason, the other 5 still succeed',
    thirdRun.status === 200 &&
      thirdRun.body.created.length === 5 &&
      !!skippedThrowaway &&
      /default_monthly_amount/i.test(skippedThrowaway.reason),
    thirdRun.body
  );

  // --- Audit trail: at least one bulk-generation audit row exists ---
  const { data: auditRows } = await supabaseAdmin
    .from('audit_events')
    .select('id, metadata')
    .eq('entity_type', 'billing_period')
    .eq('action', 'Created')
    .eq('society_id', SOCIETY_ID);
  const hasBulkRow = (auditRows || []).some((row) => row.metadata && row.metadata.bulk === true);
  check('bulk generation wrote at least one audit_events row with bulk=true', hasBulkRow, auditRows);

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // Cleanup: remove every period this test created, plus the throwaway house.
  await cleanupFuturePeriods();
  if (throwawayHouse?.id) {
    await supabaseAdmin.from('houses').delete().eq('id', throwawayHouse.id);
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('Test script crashed:', err.message);
  await cleanupFuturePeriods();
  process.exit(1);
});
