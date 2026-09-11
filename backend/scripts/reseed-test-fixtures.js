// One-time (idempotent) reseed of the original test-fixture data from
// supabase/seed.sql, which no longer exists on this hosted project - the
// project was since reseeded with real Rosewood Century sample data
// (RosewoodMasterData.csv / supabase/seed_rosewood_century_live.sql),
// wiping out the original admin@society.app/resident@society.app/etc.
// fixtures every backend/scripts/test-*.js file depends on.
//
// Mirrors supabase/seed.sql's exact IDs/emails/passwords so every existing
// test script keeps working unmodified. Uses the service-role JS client
// end-to-end (including supabaseAdmin.auth.admin.createUser() with an
// explicit `id`, confirmed to work against this project) rather than
// hand-pasting raw SQL into the Studio SQL Editor - no direct Postgres
// port access is needed for any of this.
//
// Safe to re-run: every insert below checks for the row's existence first
// and skips it if already present, so this can recover a partially-failed
// run without duplicating anything or erroring on a second pass.
//
// Run with: node scripts/reseed-test-fixtures.js
require('dotenv').config();
const supabaseAdmin = require('../src/config/supabaseAdmin');

async function ensureAuthUser(id, email) {
  const { data: existing } = await supabaseAdmin.auth.admin.getUserById(id);
  if (existing?.user) {
    console.log(`  auth user ${email} already exists, skipping`);
    return;
  }
  const { error } = await supabaseAdmin.auth.admin.createUser({
    id,
    email,
    password: 'password',
    email_confirm: true,
  });
  if (error) throw new Error(`createUser(${email}) failed: ${error.message}`);
  console.log(`  created auth user ${email} (${id})`);
}

async function ensureRow(table, id, row) {
  const { data: existing, error: selectError } = await supabaseAdmin.from(table).select('id').eq('id', id).maybeSingle();
  if (selectError) throw new Error(`select ${table}/${id} failed: ${selectError.message}`);
  if (existing) {
    console.log(`  ${table}/${id} already exists, skipping`);
    return;
  }
  const { error: insertError } = await supabaseAdmin.from(table).insert({ id, ...row });
  if (insertError) throw new Error(`insert ${table}/${id} failed: ${insertError.message}`);
  console.log(`  created ${table}/${id}`);
}

// billing_periods and transaction_allocations have no fixed id in seed.sql
// (auto-generated) - dedupe on the natural key seed.sql itself relies on
// (house_id + period_month for billing_periods; transaction_id +
// billing_period_id for allocations) instead.
async function ensureBillingPeriod(row) {
  const { data: existing, error: selectError } = await supabaseAdmin
    .from('billing_periods')
    .select('id')
    .eq('house_id', row.house_id)
    .eq('period_month', row.period_month)
    .maybeSingle();
  if (selectError) throw new Error(`select billing_periods failed: ${selectError.message}`);
  if (existing) {
    console.log(`  billing_periods for house ${row.house_id} / ${row.period_month} already exists, skipping`);
    return existing.id;
  }
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from('billing_periods')
    .insert(row)
    .select('id')
    .single();
  if (insertError) throw new Error(`insert billing_periods failed: ${insertError.message}`);
  console.log(`  created billing_periods for house ${row.house_id} / ${row.period_month}`);
  return inserted.id;
}

async function ensureAllocation(transactionId, billingPeriodId, amount) {
  const { data: existing, error: selectError } = await supabaseAdmin
    .from('transaction_allocations')
    .select('transaction_id')
    .eq('transaction_id', transactionId)
    .eq('billing_period_id', billingPeriodId)
    .maybeSingle();
  if (selectError) throw new Error(`select transaction_allocations failed: ${selectError.message}`);
  if (existing) {
    console.log(`  allocation ${transactionId}->${billingPeriodId} already exists, skipping`);
    return;
  }
  const { error: insertError } = await supabaseAdmin
    .from('transaction_allocations')
    .insert({ transaction_id: transactionId, billing_period_id: billingPeriodId, amount_allocated: amount });
  if (insertError) throw new Error(`insert transaction_allocations failed: ${insertError.message}`);
  console.log(`  created allocation ${transactionId}->${billingPeriodId}`);
}

function monthsAgo(n) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log('Auth users...');
  await ensureAuthUser('00000001-0000-0000-0000-000000000001', 'admin@society.app');
  await ensureAuthUser('00000002-0000-0000-0000-000000000002', 'resident@society.app');
  await ensureAuthUser('00000008-0000-0000-0000-000000000008', 'owner2@society.app');
  await ensureAuthUser('00000009-0000-0000-0000-000000000009', 'tenant@society.app');
  await ensureAuthUser('0000000d-0000-0000-0000-00000000000d', 'arrears@society.app');

  console.log('Society...');
  await ensureRow('societies', '00000003-0000-0000-0000-000000000003', {
    name: 'Orchid Meadows',
    upi_vpa: 'orchidmeadows@upi',
    upi_payee_name: 'Orchid Meadows Welfare Association',
  });

  console.log('Society members...');
  await ensureRow('society_members', '00000004-0000-0000-0000-000000000004', {
    society_id: '00000003-0000-0000-0000-000000000003',
    auth_user_id: '00000001-0000-0000-0000-000000000001',
    is_admin: true,
    is_committee_member: true,
    status: 'Active',
    phone_number: '+91 90000 00001',
  });
  await ensureRow('society_members', '00000005-0000-0000-0000-000000000005', {
    society_id: '00000003-0000-0000-0000-000000000003',
    auth_user_id: '00000002-0000-0000-0000-000000000002',
    is_admin: false,
    is_committee_member: false,
    status: 'Active',
    phone_number: '+91 90000 00002',
  });
  await ensureRow('society_members', '0000000a-0000-0000-0000-00000000000a', {
    society_id: '00000003-0000-0000-0000-000000000003',
    auth_user_id: '00000008-0000-0000-0000-000000000008',
    is_admin: false,
    is_committee_member: false,
    status: 'Active',
    phone_number: '+91 90000 00008',
  });
  await ensureRow('society_members', '0000000b-0000-0000-0000-00000000000b', {
    society_id: '00000003-0000-0000-0000-000000000003',
    auth_user_id: '00000009-0000-0000-0000-000000000009',
    is_admin: false,
    is_committee_member: false,
    status: 'Active',
    phone_number: '+91 90000 00009',
  });
  await ensureRow('society_members', '0000000e-0000-0000-0000-00000000000e', {
    society_id: '00000003-0000-0000-0000-000000000003',
    auth_user_id: '0000000d-0000-0000-0000-00000000000d',
    is_admin: false,
    is_committee_member: false,
    status: 'Active',
    phone_number: '+91 90000 00013',
  });

  console.log('Houses...');
  await ensureRow('houses', '00000006-0000-0000-0000-000000000006', {
    society_id: '00000003-0000-0000-0000-000000000003',
    house_number: 'A-101',
    type: 'Flat',
    owner_name: 'Mr. Resident',
    default_monthly_amount: 2200.0,
  });
  await ensureRow('houses', '00000007-0000-0000-0000-000000000007', {
    society_id: '00000003-0000-0000-0000-000000000003',
    house_number: 'R-24',
    type: 'Rowhouse',
    owner_name: 'Ms. Owner',
    default_monthly_amount: 2500.0,
  });
  await ensureRow('houses', '00000012-0000-0000-0000-000000000012', {
    society_id: '00000003-0000-0000-0000-000000000003',
    house_number: 'D-404',
    type: 'Flat',
    owner_name: 'Mr. Admin',
    default_monthly_amount: 2200.0,
  });
  await ensureRow('houses', '0000000c-0000-0000-0000-00000000000c', {
    society_id: '00000003-0000-0000-0000-000000000003',
    house_number: 'B-102',
    type: 'Flat',
    owner_name: 'Ms. Owner',
    default_monthly_amount: 2000.0,
  });
  await ensureRow('houses', '0000000f-0000-0000-0000-00000000000f', {
    society_id: '00000003-0000-0000-0000-000000000003',
    house_number: 'C-303',
    type: 'Flat',
    owner_name: 'Mr. Arrears',
    default_monthly_amount: 2200.0,
  });

  console.log('Resident house assignments...');
  async function ensureAssignment(memberId, houseId, relationshipType) {
    const { data: existing, error: selectError } = await supabaseAdmin
      .from('resident_house_assignments')
      .select('id')
      .eq('society_member_id', memberId)
      .eq('house_id', houseId)
      .maybeSingle();
    if (selectError) throw new Error(`select assignment failed: ${selectError.message}`);
    if (existing) {
      console.log(`  assignment ${memberId}->${houseId} already exists, skipping`);
      return;
    }
    const { error: insertError } = await supabaseAdmin.from('resident_house_assignments').insert({
      society_member_id: memberId,
      house_id: houseId,
      status: 'Active',
      ...(relationshipType ? { relationship_type: relationshipType } : {}),
      approved_by: '00000001-0000-0000-0000-000000000001',
      approved_at: new Date().toISOString(),
    });
    if (insertError) throw new Error(`insert assignment failed: ${insertError.message}`);
    console.log(`  created assignment ${memberId}->${houseId}`);
  }
  await ensureAssignment('00000005-0000-0000-0000-000000000005', '00000006-0000-0000-0000-000000000006');
  await ensureAssignment('00000004-0000-0000-0000-000000000004', '00000012-0000-0000-0000-000000000012', 'Owner');
  await ensureAssignment('0000000a-0000-0000-0000-00000000000a', '0000000c-0000-0000-0000-00000000000c', 'Owner');
  await ensureAssignment('0000000a-0000-0000-0000-00000000000a', '00000007-0000-0000-0000-000000000007', 'Owner');
  await ensureAssignment('0000000b-0000-0000-0000-00000000000b', '00000007-0000-0000-0000-000000000007', 'Tenant');
  await ensureAssignment('0000000e-0000-0000-0000-00000000000e', '0000000f-0000-0000-0000-00000000000f', 'Owner');

  console.log('Billing periods...');
  const periodA101 = await ensureBillingPeriod({
    society_id: '00000003-0000-0000-0000-000000000003',
    house_id: '00000006-0000-0000-0000-000000000006',
    period_month: monthsAgo(0),
    base_amount: 2200.0,
    amount_due: 2200.0,
    status: 'Open',
  });
  const periodR24 = await ensureBillingPeriod({
    society_id: '00000003-0000-0000-0000-000000000003',
    house_id: '00000007-0000-0000-0000-000000000007',
    period_month: monthsAgo(0),
    base_amount: 2500.0,
    amount_due: 2500.0,
    status: 'Open',
  });
  await ensureBillingPeriod({
    society_id: '00000003-0000-0000-0000-000000000003',
    house_id: '00000012-0000-0000-0000-000000000012',
    period_month: monthsAgo(0),
    base_amount: 2200.0,
    amount_due: 2200.0,
    status: 'Open',
  });
  await ensureBillingPeriod({
    society_id: '00000003-0000-0000-0000-000000000003',
    house_id: '0000000c-0000-0000-0000-00000000000c',
    period_month: monthsAgo(0),
    base_amount: 2000.0,
    amount_due: 2000.0,
    status: 'Open',
  });
  const periodC303Closed = await ensureBillingPeriod({
    society_id: '00000003-0000-0000-0000-000000000003',
    house_id: '0000000f-0000-0000-0000-00000000000f',
    period_month: monthsAgo(4),
    base_amount: 2200.0,
    amount_due: 2200.0,
    status: 'Closed',
  });
  await ensureBillingPeriod({
    society_id: '00000003-0000-0000-0000-000000000003',
    house_id: '0000000f-0000-0000-0000-00000000000f',
    period_month: monthsAgo(3),
    base_amount: 2200.0,
    amount_due: 2200.0,
    status: 'Open',
  });
  await ensureBillingPeriod({
    society_id: '00000003-0000-0000-0000-000000000003',
    house_id: '0000000f-0000-0000-0000-00000000000f',
    period_month: monthsAgo(2),
    base_amount: 2200.0,
    amount_due: 2200.0,
    status: 'Open',
  });
  await ensureBillingPeriod({
    society_id: '00000003-0000-0000-0000-000000000003',
    house_id: '0000000f-0000-0000-0000-00000000000f',
    period_month: monthsAgo(1),
    base_amount: 2200.0,
    amount_due: 2200.0,
    status: 'Open',
  });
  await ensureBillingPeriod({
    society_id: '00000003-0000-0000-0000-000000000003',
    house_id: '0000000f-0000-0000-0000-00000000000f',
    period_month: monthsAgo(0),
    base_amount: 2200.0,
    amount_due: 2200.0,
    status: 'Open',
  });

  console.log('Transactions...');
  await ensureRow('transactions', '00000010-0000-0000-0000-000000000010', {
    society_id: '00000003-0000-0000-0000-000000000003',
    house_id: '00000007-0000-0000-0000-000000000007',
    submitted_by: '00000009-0000-0000-0000-000000000009',
    amount: 2500.0,
    utr_number: 'SEEDTENANTR24PAYMENT',
    payment_status: 'Success',
    processing_status: 'Submitted',
    transaction_type: 'Maintenance',
    direction: 'Cr',
    payment_mode: 'UPI',
  });
  await ensureAllocation('00000010-0000-0000-0000-000000000010', periodR24, 2500.0);

  await ensureRow('transactions', '00000011-0000-0000-0000-000000000011', {
    society_id: '00000003-0000-0000-0000-000000000003',
    house_id: '0000000f-0000-0000-0000-00000000000f',
    submitted_by: '0000000d-0000-0000-0000-00000000000d',
    amount: 2200.0,
    utr_number: 'SEEDARREARSPAYMENT1',
    payment_status: 'Success',
    processing_status: 'Verified',
    transaction_type: 'Maintenance',
    direction: 'Cr',
    payment_mode: 'UPI',
    verified_by: '00000001-0000-0000-0000-000000000001',
    verified_at: new Date().toISOString(),
  });
  await ensureAllocation('00000011-0000-0000-0000-000000000011', periodC303Closed, 2200.0);

  await ensureRow('transactions', '00000013-0000-0000-0000-000000000013', {
    society_id: '00000003-0000-0000-0000-000000000003',
    house_id: null,
    submitted_by: '00000001-0000-0000-0000-000000000001',
    amount: 18500.0,
    utr_number: 'SEEDUTILITYBILL1',
    payment_status: 'Success',
    processing_status: 'Verified',
    transaction_type: 'UtilityBill',
    direction: 'Dr',
    payment_mode: 'UPI',
    payee_name: 'BEST Electricity Board',
    description: 'Monthly electricity bill (seed fixture)',
    verified_by: '00000001-0000-0000-0000-000000000001',
    verified_at: new Date().toISOString(),
  });

  console.log('\nDone. Fixture data matches supabase/seed.sql.');
}

main().catch((err) => {
  console.error('Reseed failed:', err.message);
  process.exit(1);
});
