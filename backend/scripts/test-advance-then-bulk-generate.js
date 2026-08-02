// Verifies the exact cross-endpoint interaction a user flagged: an Admin
// creates an advance billing period for one house via
// POST /houses/:houseId/billing-periods (S.No 15), then later runs the
// society-wide POST /society/:id/billing-periods/generate-next-month
// (S.No 16) which includes that same house. Both endpoints derive "next
// month" from each house's own latest existing period_month + 1, not a
// fixed calendar month applied blindly to every house - so the
// already-advanced house must NOT collide/error, it must simply continue
// one further month past whatever it already has, while every other
// (not-yet-advanced) house still gets its normal next month.
// Requires the server running (npm run dev) and the seed fixtures from
// supabase/seed.sql. Run with: node scripts/test-advance-then-bulk-generate.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const SOCIETY_ID = '00000003-0000-0000-0000-000000000003';
const HOUSE_R24 = '00000007-0000-0000-0000-000000000007'; // the one house we'll advance individually first
const SEEDED_HOUSE_IDS = [
  '00000006-0000-0000-0000-000000000006', // A-101
  '00000007-0000-0000-0000-000000000007', // R-24 (advanced ahead of the rest)
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
  // any house - so deleting anything beyond that is always safe cleanup.
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

async function post(path, token, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  const adminToken = await loginToken('admin@society.app', 'password');

  await cleanupFuturePeriods();

  // --- Step 1: Admin creates one advance period for R-24 only, via the
  //     per-house endpoint - simulating a resident who wants to pre-pay
  //     next month. Every other seeded house is untouched (still only has
  //     its current-month period). ---
  const advance = await post(`/houses/${HOUSE_R24}/billing-periods`, adminToken, { months: 1 });
  check(
    'Step 1: R-24 gets one advance period created directly (next month)',
    advance.status === 201 &&
      Array.isArray(advance.body) &&
      advance.body.length === 1 &&
      monthsAheadOfNow(advance.body[0].period_month, 1),
    advance.body
  );

  // --- Step 2: Admin runs the society-wide "generate next month for
  //     everyone" bulk action, which necessarily includes R-24 too. ---
  const bulk = await post(`/society/${SOCIETY_ID}/billing-periods/generate-next-month`, adminToken);
  const created = bulk.body.created || [];
  const skipped = bulk.body.skipped || [];
  const r24Created = created.find((c) => c.house_id === HOUSE_R24);
  const r24Skipped = skipped.find((s) => s.house_id === HOUSE_R24);
  // Scoped to just our known seeded houses (minus R-24) - other test
  // scripts' own throwaway fixtures may still be Active in the DB at the
  // same time and would otherwise also show up in `created` here, which
  // has nothing to do with the collision behavior this test is checking.
  const othersCreated = created.filter((c) => c.house_id !== HOUSE_R24 && SEEDED_HOUSE_IDS.includes(c.house_id));

  check(
    'Step 2: the bulk run does NOT error or skip R-24 as a duplicate - it succeeds',
    bulk.status === 200 && !!r24Created && !r24Skipped,
    bulk.body
  );

  check(
    'Step 2: R-24 (already 1 month ahead) is advanced to 2 months ahead, not re-created at 1',
    !!r24Created && monthsAheadOfNow(r24Created.billing_period.period_month, 2),
    r24Created
  );

  check(
    'Step 2: every other seeded house (never advanced) still gets exactly next month (1 month ahead)',
    othersCreated.length === SEEDED_HOUSE_IDS.length - 1 &&
      othersCreated.every((c) => monthsAheadOfNow(c.billing_period.period_month, 1)),
    othersCreated
  );

  check(
    'Step 2: nothing landed in skipped for any of our seeded houses (no unique-violation for anyone)',
    skipped.filter((s) => SEEDED_HOUSE_IDS.includes(s.house_id)).length === 0,
    skipped
  );

  // --- Step 3: confirm the underlying data directly - whatever R-24 had
  //     before this test ran, it must have gained exactly the 2 new rows
  //     from Steps 1-2 above (Step 1's +1 and Step 2's +2), with no
  //     duplicate period_month anywhere in its history. ---
  const { data: r24Periods } = await supabaseAdmin
    .from('billing_periods')
    .select('period_month')
    .eq('house_id', HOUSE_R24)
    .order('period_month', { ascending: true });
  const distinctMonths = new Set((r24Periods || []).map((p) => p.period_month));
  const hasStep1Month = (r24Periods || []).some((p) => monthsAheadOfNow(p.period_month, 1));
  const hasStep2Month = (r24Periods || []).some((p) => monthsAheadOfNow(p.period_month, 2));
  check(
    'Step 3: R-24 has no duplicate period_month rows, and both the Step 1 and Step 2 months are present exactly once',
    distinctMonths.size === (r24Periods || []).length && hasStep1Month && hasStep2Month,
    r24Periods
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  await cleanupFuturePeriods();
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('Test script crashed:', err.message);
  await cleanupFuturePeriods();
  process.exit(1);
});
