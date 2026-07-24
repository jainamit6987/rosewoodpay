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
INSERT INTO public.society_members (id, society_id, auth_user_id, role, is_committee_member, status)
VALUES
-- Admin Member
('00000004-0000-0000-0000-000000000004', '00000003-0000-0000-0000-000000000003', '00000001-0000-0000-0000-000000000001', 'Admin', true, 'Active'),
-- Resident Member
('00000005-0000-0000-0000-000000000005', '00000003-0000-0000-0000-000000000003', '00000002-0000-0000-0000-000000000002', 'Resident', false, 'Active');


--
-- Create Houses and Assignments
--

-- 1. Create Houses
INSERT INTO public.houses (id, society_id, house_number, type, owner_name)
VALUES
-- The resident's house
('00000006-0000-0000-0000-000000000006', '00000003-0000-0000-0000-000000000003', 'A-101', 'Flat', 'Mr. Resident'),
-- Another house for testing
('00000007-0000-0000-0000-000000000007', '00000003-0000-0000-0000-000000000003', 'R-24', 'Rowhouse', 'Ms. Owner');

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