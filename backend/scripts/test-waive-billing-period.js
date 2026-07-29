// Verifies POST /houses/:houseId/billing-periods/:periodId/waive
// (backend/src/routes/houses.js): Admin-only, one-way Open -> Waived
// transition, forgiving a period's dues. Requires the server running
// (npm run dev), migration 20260730000000_add_billing_period_waive_columns
// already applied, and the seed fixtures from supabase/seed.sql (R-24's
// current-month period has a Submitted allocation against it; the arrears
// house C-303 has an already-Closed period 4 months back).
// Run with: node scripts/test-waive-billing-period.js
require('dotenv').config();
const env = require('../src/config/env');
const { supabaseAnon } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const BASE_URL = `http://localhost:${env.port}`;
const SOCIETY_ID = '00000003-0000-0000-0000-000000000003';
const HOUSE_A101_RESIDENT = '00000006-0000-0000-0000-000000000006';
const HOUSE_R24 = '00000007-0000-0000-0000-000000000007';
const HOUSE_C303_ARREARS = '0000000f-0000-0000-0000-00000000000f';
const FAKE_HOUSE_ID = '00000000-aaaa-bbbb-cccc-000000000000';
const FAKE_PERIOD_ID = '00000000-dddd-eeee-ffff-000000000000';

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

async function post(path, token, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  const residentToken = await loginToken('resident@society.app', 'password');
  const adminToken = await loginToken('admin@society.app', 'password');

  // --- Setup: a throwaway house with one clean Open period, no payment
  //     activity at all - the case this action actually exists for. ---
  const throwawayHouseTag = `TESTWAIVE${Date.now()}`.slice(0, 20);
  const { data: throwawayHouse, error: houseInsertError } = await supabaseAdmin
    .from('houses')
    .insert({ society_id: SOCIETY_ID, house_number: throwawayHouseTag, type: 'Flat', default_monthly_amount: 2000 })
    .select('id')
    .single();
  if (houseInsertError) {
    console.error('setup failed: could not create throwaway house', houseInsertError.message);
  }

  const currentMonth = new Date();
  const periodMonth = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  const { data: throwawayPeriod, error: periodInsertError } = await supabaseAdmin
    .from('billing_periods')
    .insert({
      society_id: SOCIETY_ID,
      house_id: throwawayHouse.id,
      period_month: periodMonth,
      base_amount: 2000,
      amount_due: 2000,
      status: 'Open',
    })
    .select('id')
    .single();
  if (periodInsertError) {
    console.error('setup failed: could not create throwaway billing period', periodInsertError.message);
  }

  const { data: a101Period } = await supabaseAdmin
    .from('billing_periods')
    .select('id')
    .eq('house_id', HOUSE_A101_RESIDENT)
    .limit(1)
    .single();
  const { data: r24Period } = await supabaseAdmin
    .from('billing_periods')
    .select('id')
    .eq('house_id', HOUSE_R24)
    .order('period_month', { ascending: true })
    .limit(1)
    .single();
  const { data: c303ClosedPeriod } = await supabaseAdmin
    .from('billing_periods')
    .select('id')
    .eq('house_id', HOUSE_C303_ARREARS)
    .eq('status', 'Closed')
    .single();

  // --- Unauthenticated is rejected ---
  check(
    'unauthenticated POST is rejected (401)',
    (await post(`/houses/${throwawayHouse.id}/billing-periods/${throwawayPeriod.id}/waive`, null, { reason: 'x' }))
      .status === 401
  );

  // --- A plain resident cannot waive, even their own house's period ---
  check(
    'a plain resident cannot waive a billing period, even their own house\'s (403)',
    (await post(`/houses/${HOUSE_A101_RESIDENT}/billing-periods/${a101Period.id}/waive`, residentToken, { reason: 'x' }))
      .status === 403
  );

  // --- A nonexistent house id is a clean 404 ---
  check(
    'a nonexistent house id returns 404',
    (await post(`/houses/${FAKE_HOUSE_ID}/billing-periods/${FAKE_PERIOD_ID}/waive`, adminToken, { reason: 'x' }))
      .status === 404
  );

  // --- Missing/empty reason is rejected ---
  check(
    'a missing reason is rejected (400)',
    (await post(`/houses/${throwawayHouse.id}/billing-periods/${throwawayPeriod.id}/waive`, adminToken, {})).status ===
      400
  );
  check(
    'a whitespace-only reason is rejected (400)',
    (
      await post(`/houses/${throwawayHouse.id}/billing-periods/${throwawayPeriod.id}/waive`, adminToken, {
        reason: '   ',
      })
    ).status === 400
  );

  // --- A period id that exists, but not under this house, is a clean 404
  //     (mismatched house/period pair) ---
  check(
    'a period belonging to a different house is not found under this house (404)',
    (await post(`/houses/${throwawayHouse.id}/billing-periods/${r24Period.id}/waive`, adminToken, { reason: 'x' }))
      .status === 404
  );

  // --- A period that already has a payment allocated against it (even
  //     just Submitted, not yet Verified) cannot be waived ---
  check(
    'a period with an existing payment allocation cannot be waived (409)',
    (
      await post(`/houses/${HOUSE_R24}/billing-periods/${r24Period.id}/waive`, adminToken, {
        reason: 'Should be rejected',
      })
    ).status === 409
  );

  // --- An already-Closed period cannot be waived ---
  check(
    'an already-Closed period cannot be waived (409)',
    (
      await post(`/houses/${HOUSE_C303_ARREARS}/billing-periods/${c303ClosedPeriod.id}/waive`, adminToken, {
        reason: 'Should be rejected',
      })
    ).status === 409
  );

  // --- Happy path: a clean Open period with no payment activity ---
  const waiveResult = await post(`/houses/${throwawayHouse.id}/billing-periods/${throwawayPeriod.id}/waive`, adminToken, {
    reason: 'Resident relocated overseas mid-month; society committee approved a full waiver for this period.',
  });
  check(
    'Admin waiving a clean Open period succeeds (200): status Waived, amount_due 0, reason/actor/time recorded',
    waiveResult.status === 200 &&
      waiveResult.body.status === 'Waived' &&
      Number(waiveResult.body.amount_due) === 0 &&
      typeof waiveResult.body.waived_reason === 'string' &&
      waiveResult.body.waived_reason.length > 0 &&
      !!waiveResult.body.waived_by &&
      !!waiveResult.body.waived_at,
    waiveResult.body
  );

  // --- Re-waiving the now-Waived period is rejected ---
  const reWaiveResult = await post(
    `/houses/${throwawayHouse.id}/billing-periods/${throwawayPeriod.id}/waive`,
    adminToken,
    { reason: 'Trying again' }
  );
  check('re-waiving an already-Waived period is rejected (409)', reWaiveResult.status === 409, reWaiveResult.body);

  // --- Audit trail ---
  const { data: auditRows } = await supabaseAdmin
    .from('audit_events')
    .select('id, metadata')
    .eq('entity_type', 'billing_period')
    .eq('action', 'Waived')
    .eq('entity_id', throwawayPeriod.id);
  check('waiving wrote an audit_events row with the reason in metadata', (auditRows || []).length === 1, auditRows);

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // Cleanup: deleting the throwaway house cascades to its billing_periods.
  if (throwawayHouse?.id) {
    await supabaseAdmin.from('houses').delete().eq('id', throwawayHouse.id);
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
