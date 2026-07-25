--
-- Seed Data for Society App
--

-- To apply this seed data, run `npx supabase db reset`.
-- This script will be executed automatically after the migrations.

-- Note: For local development, we are inserting directly into auth.users.
-- In a real environment, you would use the Supabase client library's signUp method.
-- The passwords for both users are 'password'.

--
-- Create Test Users
--

-- 1. Create the Admin User
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, recovery_token, recovery_sent_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, email_change, email_change_token_new)
VALUES
('00000000-0000-0000-0000-000000000000', '00000001-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'admin@society.app', extensions.crypt('password', extensions.gen_salt('bf')), now(), '', null, null, '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '','');

INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
VALUES
('00000001-0000-0000-0000-000000000011', '00000001-0000-0000-0000-000000000001', '{"sub":"00000001-0000-0000-0000-000000000001","email":"admin@society.app"}', 'email','1234', now(), now(), now());

-- 2. Create the Resident User
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, recovery_token, recovery_sent_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, email_change, email_change_token_new)
VALUES
('00000000-0000-0000-0000-000000000000', '00000002-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'resident@society.app', extensions.crypt('password', extensions.gen_salt('bf')), now(), '', null, null, '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '');

INSERT INTO auth.identities (id, user_id, identity_data, provider,provider_id, last_sign_in_at, created_at, updated_at)
VALUES
('00000002-0000-0000-0000-000000000022', '00000002-0000-0000-0000-000000000002', '{"sub":"00000002-0000-0000-0000-000000000002","email":"resident@society.app"}', 'email','12345', now(), now(), now());


--
-- Create Society and link members
--

-- 1. Create the Society
INSERT INTO public.societies (id, name, upi_vpa, upi_payee_name)
VALUES
('00000003-0000-0000-0000-000000000003', 'Orchid Meadows', 'orchidmeadows@upi', 'Orchid Meadows Welfare Association');

-- 2. Create Society Members
INSERT INTO public.society_members (id, society_id, auth_user_id, role, is_committee_member, status, phone_number)
VALUES
-- Admin Member
('00000004-0000-0000-0000-000000000004', '00000003-0000-0000-0000-000000000003', '00000001-0000-0000-0000-000000000001', 'Admin', true, 'Active', '+91 90000 00001'),
-- Resident Member
('00000005-0000-0000-0000-000000000005', '00000003-0000-0000-0000-000000000003', '00000002-0000-0000-0000-000000000002', 'Resident', false, 'Active', '+91 90000 00002');


--
-- Create Houses and Assignments
--

-- 1. Create Houses
INSERT INTO public.houses (id, society_id, house_number, type, owner_name, default_monthly_amount)
VALUES
-- The resident's house
('00000006-0000-0000-0000-000000000006', '00000003-0000-0000-0000-000000000003', 'A-101', 'Flat', 'Mr. Resident', 2200.00),
-- Another house for testing
('00000007-0000-0000-0000-000000000007', '00000003-0000-0000-0000-000000000003', 'R-24', 'Rowhouse', 'Ms. Owner', 2500.00);

-- 2. Assign the resident to their house
INSERT INTO public.resident_house_assignments (society_member_id, house_id, status, approved_by, approved_at)
VALUES
('00000005-0000-0000-0000-000000000005', '00000006-0000-0000-0000-000000000006', 'Active', '00000001-0000-0000-0000-000000000001', now());


--
-- Create Billing Periods
--

-- 1. Create an open billing period for the resident's house for the current month
INSERT INTO public.billing_periods (society_id, house_id, period_month, base_amount, amount_due, status)
VALUES
(
    '00000003-0000-0000-0000-000000000003',
    '00000006-0000-0000-0000-000000000006',
    date_trunc('month', CURRENT_DATE),
    2200.00,
    2200.00,
    'Open'
);

-- 2. Create an open billing period for the other house for the current month
INSERT INTO public.billing_periods (society_id, house_id, period_month, base_amount, amount_due, status)
VALUES
(
    '00000003-0000-0000-0000-000000000003',
    '00000007-0000-0000-0000-000000000007',
    date_trunc('month', CURRENT_DATE),
    2500.00,
    2500.00,
    'Open'
);


--
-- Owner/Tenant co-assignee fixtures
--
-- Models: "Owner2" owns two houses - B-102, where they live themselves, and
-- R-24, which they rent out. "Tenant" actually lives in and pays for R-24.
-- Used to verify that Owner2 (a co-assignee of R-24 who never submits a
-- payment there) can still see Tenant's transaction for that shared house,
-- while an unrelated resident (the original Resident user, assigned only
-- to A-101) cannot.
--

-- 3. Create the Owner2 user
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, recovery_token, recovery_sent_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, email_change, email_change_token_new)
VALUES
('00000000-0000-0000-0000-000000000000', '00000008-0000-0000-0000-000000000008', 'authenticated', 'authenticated', 'owner2@society.app', extensions.crypt('password', extensions.gen_salt('bf')), now(), '', null, null, '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '');

INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
VALUES
('00000008-0000-0000-0000-000000000088', '00000008-0000-0000-0000-000000000008', '{"sub":"00000008-0000-0000-0000-000000000008","email":"owner2@society.app"}', 'email', '123456', now(), now(), now());

-- 4. Create the Tenant user
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, recovery_token, recovery_sent_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, email_change, email_change_token_new)
VALUES
('00000000-0000-0000-0000-000000000000', '00000009-0000-0000-0000-000000000009', 'authenticated', 'authenticated', 'tenant@society.app', extensions.crypt('password', extensions.gen_salt('bf')), now(), '', null, null, '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '');

INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
VALUES
('00000009-0000-0000-0000-000000000099', '00000009-0000-0000-0000-000000000009', '{"sub":"00000009-0000-0000-0000-000000000009","email":"tenant@society.app"}', 'email', '1234567', now(), now(), now());

-- 5. Add both as society members
INSERT INTO public.society_members (id, society_id, auth_user_id, role, is_committee_member, status, phone_number)
VALUES
('0000000a-0000-0000-0000-00000000000a', '00000003-0000-0000-0000-000000000003', '00000008-0000-0000-0000-000000000008', 'Resident', false, 'Active', '+91 90000 00008'),
('0000000b-0000-0000-0000-00000000000b', '00000003-0000-0000-0000-000000000003', '00000009-0000-0000-0000-000000000009', 'Resident', false, 'Active', '+91 90000 00009');

-- 6. Create Owner2's own residence
INSERT INTO public.houses (id, society_id, house_number, type, owner_name, default_monthly_amount)
VALUES
('0000000c-0000-0000-0000-00000000000c', '00000003-0000-0000-0000-000000000003', 'B-102', 'Flat', 'Ms. Owner', 2000.00);

-- 7. Assignments: Owner2 owns B-102 (lives there) and R-24 (rents it out);
--    Tenant is the one actually living in and paying for R-24.
INSERT INTO public.resident_house_assignments (society_member_id, house_id, status, relationship_type, approved_by, approved_at)
VALUES
('0000000a-0000-0000-0000-00000000000a', '0000000c-0000-0000-0000-00000000000c', 'Active', 'Owner', '00000001-0000-0000-0000-000000000001', now()),
('0000000a-0000-0000-0000-00000000000a', '00000007-0000-0000-0000-000000000007', 'Active', 'Owner', '00000001-0000-0000-0000-000000000001', now()),
('0000000b-0000-0000-0000-00000000000b', '00000007-0000-0000-0000-000000000007', 'Active', 'Tenant', '00000001-0000-0000-0000-000000000001', now());

-- 8. Open billing period for Owner2's own residence (B-102)
INSERT INTO public.billing_periods (society_id, house_id, period_month, base_amount, amount_due, status)
VALUES
(
    '00000003-0000-0000-0000-000000000003',
    '0000000c-0000-0000-0000-00000000000c',
    date_trunc('month', CURRENT_DATE),
    2000.00,
    2000.00,
    'Open'
);

-- 9. Tenant pays R-24's existing billing period themselves - Owner2 never
--    submits anything for R-24, so seeing this transaction proves
--    co-assignee visibility rather than shared submission. One transaction
--    row plus one transaction_allocations row (see
--    20260725020000_add_transaction_allocations_and_default_rate.sql for
--    why a single billing_period_id column on transactions is no longer
--    enough - one payment can cover more than one period).
INSERT INTO public.transactions (id, society_id, house_id, submitted_by, amount, utr_number, payment_status, processing_status)
VALUES
(
    '00000010-0000-0000-0000-000000000010',
    '00000003-0000-0000-0000-000000000003',
    '00000007-0000-0000-0000-000000000007',
    '00000009-0000-0000-0000-000000000009',
    2500.00,
    'SEEDTENANTR24PAYMENT',
    'Success',
    'Submitted'
);

INSERT INTO public.transaction_allocations (transaction_id, billing_period_id, amount_allocated)
VALUES
(
    '00000010-0000-0000-0000-000000000010',
    (SELECT id FROM public.billing_periods WHERE house_id = '00000007-0000-0000-0000-000000000007' AND period_month = date_trunc('month', CURRENT_DATE)),
    2500.00
);


--
-- Arrears resident fixture
--
-- Models a resident onboarded with pre-existing arrears: 4 months behind at
-- onboarding time, one of those months has since been paid off (Closed),
-- leaving 3 back-months plus the current month still Open. Demonstrates
-- FIFO allocation - this resident's next payment via POST /transactions
-- resolves to the oldest remaining Open period (3 months ago), not the
-- current month, even though that's the one they'd expect a receipt for.
--

-- 10. Create the Arrears resident user
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, recovery_token, recovery_sent_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, email_change, email_change_token_new)
VALUES
('00000000-0000-0000-0000-000000000000', '0000000d-0000-0000-0000-00000000000d', 'authenticated', 'authenticated', 'arrears@society.app', extensions.crypt('password', extensions.gen_salt('bf')), now(), '', null, null, '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '');

INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
VALUES
('0000000d-0000-0000-0000-0000000000dd', '0000000d-0000-0000-0000-00000000000d', '{"sub":"0000000d-0000-0000-0000-00000000000d","email":"arrears@society.app"}', 'email', '1234568', now(), now(), now());

-- 11. Add as a society member
INSERT INTO public.society_members (id, society_id, auth_user_id, role, is_committee_member, status, phone_number)
VALUES
('0000000e-0000-0000-0000-00000000000e', '00000003-0000-0000-0000-000000000003', '0000000d-0000-0000-0000-00000000000d', 'Resident', false, 'Active', '+91 90000 00013');

-- 12. Create their house
INSERT INTO public.houses (id, society_id, house_number, type, owner_name, default_monthly_amount)
VALUES
('0000000f-0000-0000-0000-00000000000f', '00000003-0000-0000-0000-000000000003', 'C-303', 'Flat', 'Mr. Arrears', 2200.00);

-- 13. Assign the resident to their house
INSERT INTO public.resident_house_assignments (society_member_id, house_id, status, relationship_type, approved_by, approved_at)
VALUES
('0000000e-0000-0000-0000-00000000000e', '0000000f-0000-0000-0000-00000000000f', 'Active', 'Owner', '00000001-0000-0000-0000-000000000001', now());

-- 14. Five monthly billing periods: 4 months ago through the current month.
--     The oldest (4 months ago) is already Closed; the rest are still Open.
INSERT INTO public.billing_periods (society_id, house_id, period_month, base_amount, amount_due, status)
VALUES
('00000003-0000-0000-0000-000000000003', '0000000f-0000-0000-0000-00000000000f', date_trunc('month', CURRENT_DATE) - INTERVAL '4 months', 2200.00, 2200.00, 'Closed'),
('00000003-0000-0000-0000-000000000003', '0000000f-0000-0000-0000-00000000000f', date_trunc('month', CURRENT_DATE) - INTERVAL '3 months', 2200.00, 2200.00, 'Open'),
('00000003-0000-0000-0000-000000000003', '0000000f-0000-0000-0000-00000000000f', date_trunc('month', CURRENT_DATE) - INTERVAL '2 months', 2200.00, 2200.00, 'Open'),
('00000003-0000-0000-0000-000000000003', '0000000f-0000-0000-0000-00000000000f', date_trunc('month', CURRENT_DATE) - INTERVAL '1 month', 2200.00, 2200.00, 'Open'),
('00000003-0000-0000-0000-000000000003', '0000000f-0000-0000-0000-00000000000f', date_trunc('month', CURRENT_DATE), 2200.00, 2200.00, 'Open');

-- 15. The one already-cleared month: a Verified payment against it, so the
--     Closed status above reflects a real, already-reviewed transaction
--     rather than an unexplained status flip.
INSERT INTO public.transactions (id, society_id, house_id, submitted_by, amount, utr_number, payment_status, processing_status, verified_by, verified_at)
VALUES
(
    '00000011-0000-0000-0000-000000000011',
    '00000003-0000-0000-0000-000000000003',
    '0000000f-0000-0000-0000-00000000000f',
    '0000000d-0000-0000-0000-00000000000d',
    2200.00,
    'SEEDARREARSPAYMENT1',
    'Success',
    'Verified',
    '00000001-0000-0000-0000-000000000001',
    now()
);

INSERT INTO public.transaction_allocations (transaction_id, billing_period_id, amount_allocated)
VALUES
(
    '00000011-0000-0000-0000-000000000011',
    (SELECT id FROM public.billing_periods WHERE house_id = '0000000f-0000-0000-0000-00000000000f' AND period_month = date_trunc('month', CURRENT_DATE) - INTERVAL '4 months'),
    2200.00
);