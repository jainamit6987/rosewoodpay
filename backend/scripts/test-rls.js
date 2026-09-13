// Focused RLS verification (Action 4). Demonstrates both allowed access
// and denied access - a passing "happy path" alone does not prove RLS
// is doing anything. Run with: node scripts/test-rls.js
require('dotenv').config();
const { supabaseAnon, createUserScopedClient } = require('../src/config/supabaseClient');
const supabaseAdmin = require('../src/config/supabaseAdmin');

const HOUSE_A101 = '00000006-0000-0000-0000-000000000006'; // resident's assigned house
const HOUSE_R24 = '00000007-0000-0000-0000-000000000007'; // not assigned to the resident

let passCount = 0;
let failCount = 0;

function check(label, condition) {
  if (condition) {
    passCount += 1;
    console.log(`PASS - ${label}`);
  } else {
    failCount += 1;
    console.log(`FAIL - ${label}`);
  }
}

async function loginAs(email, password) {
  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`login failed for ${email}: ${error.message}`);
  return createUserScopedClient(data.session.access_token);
}

async function main() {
  const resident = await loginAs('resident@society.app', 'password');
  const admin = await loginAs('admin@society.app', 'password');

  // --- Allowed: resident reads billing period for their own house ---
  const { data: ownBilling } = await resident
    .from('billing_periods')
    .select('id')
    .eq('house_id', HOUSE_A101);
  check('resident CAN read billing period for their own house', ownBilling && ownBilling.length === 1);

  // --- Denied: resident reads billing period for a house they are not assigned to ---
  const { data: otherBilling } = await resident
    .from('billing_periods')
    .select('id')
    .eq('house_id', HOUSE_R24);
  check('resident CANNOT read billing period for a house they are not assigned to', otherBilling && otherBilling.length === 0);

  // --- Denied: resident reads other members' society_members rows ---
  const { data: members } = await resident.from('society_members').select('id, is_admin');
  check('resident sees ONLY their own society_members row', members && members.length === 1 && members[0].is_admin === false);

  // --- Allowed: admin reads all society_members rows ---
  // 5 total in this society as of the arrears/co-assignee/admin's-own-house
  // fixtures: admin, resident, owner2, tenant, arrears.
  const { data: allMembers } = await admin.from('society_members').select('id, is_admin');
  check('admin sees ALL society_members rows in their society', allMembers && allMembers.length === 5);

  // --- Denied: resident submits a transaction for a house they are not assigned to ---
  const residentUserId = (await resident.auth.getUser()).data.user.id;

  const { error: insertOtherHouseError } = await resident.from('transactions').insert({
    society_id: (await admin.from('houses').select('society_id').eq('id', HOUSE_R24).single()).data.society_id,
    house_id: HOUSE_R24,
    submitted_by: residentUserId,
    amount: 2500,
    utr_number: 'TEST000000R24',
    direction: 'Cr',
  });
  check('resident CANNOT submit a transaction for a house they are not assigned to', !!insertOtherHouseError);

  // --- Allowed: resident submits a transaction for their own assigned house ---
  const { data: insertedOwnTxn, error: insertOwnHouseError } = await resident
    .from('transactions')
    .insert({
      society_id: (await admin.from('houses').select('society_id').eq('id', HOUSE_A101).single()).data.society_id,
      house_id: HOUSE_A101,
      submitted_by: residentUserId,
      amount: 2200,
      utr_number: `TEST${Date.now()}`,
      direction: 'Cr',
    })
    .select()
    .single();
  check('resident CAN submit a transaction for their own assigned house', !insertOwnHouseError);

  // --- Security regression (2026-09-13 audit finding, CRITICAL): the
  // resident INSERT policy previously only checked submitted_by + an
  // active assignment, with no restriction on which columns a resident's
  // own insert could set. A direct PostgREST call (bypassing Express,
  // same shape as this whole script already uses) could therefore mark a
  // fabricated payment "Verified"/"Success" with no real PaySharp order
  // or Admin review behind it at all - free maintenance. See
  // 20260913010000_harden_transaction_insert_and_house_owner_update.sql. ---
  const houseA101SocietyId = (await admin.from('houses').select('society_id').eq('id', HOUSE_A101).single()).data
    .society_id;

  const { error: selfVerifyError } = await resident.from('transactions').insert({
    society_id: houseA101SocietyId,
    house_id: HOUSE_A101,
    submitted_by: residentUserId,
    amount: 2200,
    utr_number: `TESTEXPLOIT${Date.now()}`,
    direction: 'Cr',
    processing_status: 'Verified',
    payment_status: 'Success',
  });
  check('resident CANNOT self-insert a transaction already marked Verified/Success', !!selfVerifyError);

  const { error: fakeCashError } = await resident.from('transactions').insert({
    society_id: houseA101SocietyId,
    house_id: HOUSE_A101,
    submitted_by: residentUserId,
    amount: 2200,
    utr_number: `TESTEXPLOIT2${Date.now()}`,
    direction: 'Cr',
    payment_mode: 'Cash',
  });
  check('resident CANNOT self-insert a Cash-mode transaction (Cash is Admin-only)', !!fakeCashError);

  const { error: fakeGatewaySuccessError } = await resident.from('transactions').insert({
    society_id: houseA101SocietyId,
    house_id: HOUSE_A101,
    submitted_by: residentUserId,
    amount: 2200,
    direction: 'Cr',
    payment_gateway: 'paysharp',
    paysharp_order_id: `11111111-1111-1111-1111-${Date.now()}`.slice(0, 36),
    gateway_status: 'SUCCESS',
  });
  check(
    'resident CANNOT self-insert a fabricated PaySharp order already at gateway_status=SUCCESS (must start PENDING)',
    !!fakeGatewaySuccessError
  );

  // --- Allocation-level RLS: billing_period_id validity now lives on
  //     transaction_allocations, not on transactions itself. ---
  const { data: a101Period } = await admin
    .from('billing_periods')
    .select('id')
    .eq('house_id', HOUSE_A101)
    .single();
  const { data: r24Period } = await admin.from('billing_periods').select('id').eq('house_id', HOUSE_R24).single();

  const { error: allocateOwnHouseError } = await resident.from('transaction_allocations').insert({
    transaction_id: insertedOwnTxn.id,
    billing_period_id: a101Period.id,
    amount_allocated: 2200,
  });
  check('resident CAN allocate their own transaction to a period on their own assigned house', !allocateOwnHouseError);

  const { error: allocateOtherHouseError } = await resident.from('transaction_allocations').insert({
    transaction_id: insertedOwnTxn.id,
    billing_period_id: r24Period.id,
    amount_allocated: 2500,
  });
  check(
    'resident CANNOT allocate their own transaction to a period on a house they are not assigned to',
    !!allocateOtherHouseError
  );

  console.log(`\n${passCount} passed, ${failCount} failed.`);

  // Cascades to transaction_allocations automatically (ON DELETE CASCADE).
  await supabaseAdmin.from('transactions').delete().like('utr_number', 'TEST%');

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err.message);
  process.exit(1);
});
