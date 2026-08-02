-- =====================================================================
-- Rosewood Century - full reseed script
-- =====================================================================
-- Run this ENTIRE file once, top to bottom, in the Supabase Studio SQL
-- Editor for the hosted project (there is no local Supabase CLI/Docker
-- in use on this project - every migration so far has been applied the
-- same way). It replaces ALL existing data in every public.* table (and
-- the old @society.app / @example.com test auth users) with a fresh,
-- self-consistent "Rosewood Century" dataset.
--
-- WARNING: Step 0 is destructive and irreversible. If you already ran
-- your own TRUNCATE, just skip Step 0 and start from Step 1.
--
-- What this breaks: ~20 scripts under backend/scripts/test-*.js hardcode
-- the OLD seed fixtures (admin@society.app / resident@society.app logins,
-- house numbers R-24 / A-101 / B-102 / C-303 / D-404, etc.). Those will
-- fail on login/lookup after this runs - by design, per the decision to
-- leave them alone for now rather than update them in this same change.
--
-- Result overview (see the cheat-sheet comments in each step for exact
-- mapping):
--   - 1 society: "Rosewood Century"
--   - 12 society members (1 Admin, 2 Committee, 9 plain residents),
--     random Indian names, logins <first>.<last>@gmail.com / password123
--   - 16 houses: RW1..RW10 (Rowhouse), G1/G2/F1/F2/S1/S2 (Flat, 2 per
--     floor - Ground/First/Second)
--   - 6 members each own exactly one Rowhouse + one Flat (multi-house
--     ownership), covering all 4 requested assignment scenarios
--   - Billing periods Jan-Aug 2026 (+ Sep/Oct 2026 for the 2 "paid
--     2 months advance" houses) for all 16 houses, with a mix of
--     regular/1-month-due/2-3-months-due/advance-paid payment histories
--   - Maintenance transactions (mix of UPI/Cash) matching every Closed
--     billing period, a handful of WaterCharge transactions, and monthly
--     society expense transactions (Security Agency/Electricity/
--     Gardener/STP Maintenance/Cleaner) for Jan-Aug 2026.
--
-- =====================================================================
-- STEP 0 (optional/destructive): clear all existing data
-- =====================================================================
TRUNCATE TABLE public.societies CASCADE; -- cascades through every public.* table that (transitively) references societies
DELETE FROM auth.users WHERE email LIKE '%@society.app' OR email LIKE '%@example.com';
-- auth.identities rows cascade-delete automatically via their FK to auth.users(id).

-- =====================================================================
-- STEP 1: Society
-- =====================================================================
INSERT INTO public.societies (name, upi_vpa, upi_payee_name)
VALUES ('Rosewood Century', 'rosewoodcentury@upi', 'Rosewood Century Owners Welfare Association');

-- =====================================================================
-- STEP 2: Members - auth.users + auth.identities + public.society_members
-- =====================================================================
-- Cheat-sheet (name -> role):
--   1. Rohan Sharma    - Admin
--   2. Priya Nair      - Committee
--   3. Arjun Mehta      - Committee
--   4-12. Ananya Iyer, Vikram Malhotra, Sneha Reddy, Karan Kapoor,
--         Meera Joshi, Aditya Verma, Kavya Menon, Rahul Desai,
--         Ishita Bansal - plain residents
-- Every login is <first>.<last>@gmail.com, password "password123".
DO $$
DECLARE
  v_society_id UUID;
  v_password TEXT := 'password123';
  members JSONB := '[
    {"first":"Rohan","last":"Sharma","phone":"+91 98765 43210","is_admin":true,"is_committee":false},
    {"first":"Priya","last":"Nair","phone":"+91 98123 45678","is_admin":false,"is_committee":true},
    {"first":"Arjun","last":"Mehta","phone":"+91 97654 32109","is_admin":false,"is_committee":true},
    {"first":"Ananya","last":"Iyer","phone":"+91 96543 21098","is_admin":false,"is_committee":false},
    {"first":"Vikram","last":"Malhotra","phone":"+91 95432 10987","is_admin":false,"is_committee":false},
    {"first":"Sneha","last":"Reddy","phone":"+91 94321 09876","is_admin":false,"is_committee":false},
    {"first":"Karan","last":"Kapoor","phone":"+91 93210 98765","is_admin":false,"is_committee":false},
    {"first":"Meera","last":"Joshi","phone":"+91 92109 87654","is_admin":false,"is_committee":false},
    {"first":"Aditya","last":"Verma","phone":"+91 91098 76543","is_admin":false,"is_committee":false},
    {"first":"Kavya","last":"Menon","phone":"+91 90987 65432","is_admin":false,"is_committee":false},
    {"first":"Rahul","last":"Desai","phone":"+91 89876 54321","is_admin":false,"is_committee":false},
    {"first":"Ishita","last":"Bansal","phone":"+91 88765 43210","is_admin":false,"is_committee":false}
  ]'::jsonb;
  m JSONB;
  v_email TEXT;
  v_auth_id UUID;
BEGIN
  SELECT id INTO v_society_id FROM public.societies WHERE name = 'Rosewood Century';

  FOR m IN SELECT * FROM jsonb_array_elements(members) LOOP
    v_email := lower(m->>'first') || '.' || lower(m->>'last') || '@gmail.com';

    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      recovery_token, recovery_sent_at, last_sign_in_at, raw_app_meta_data,
      raw_user_meta_data, created_at, updated_at, confirmation_token, email_change,
      email_change_token_new
    ) VALUES (
      '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
      v_email, extensions.crypt(v_password, extensions.gen_salt('bf')), now(),
      '', null, null, '{"provider":"email","providers":["email"]}',
      '{}', now(), now(), '', '', ''
    )
    RETURNING id INTO v_auth_id;

    INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
    VALUES (
      gen_random_uuid(), v_auth_id,
      jsonb_build_object('sub', v_auth_id::text, 'email', v_email),
      'email', v_auth_id::text, now(), now(), now()
    );

    INSERT INTO public.society_members (society_id, auth_user_id, name, phone_number, is_admin, is_committee_member, status)
    VALUES (
      v_society_id, v_auth_id, (m->>'first') || ' ' || (m->>'last'), m->>'phone',
      (m->>'is_admin')::boolean, (m->>'is_committee')::boolean, 'Active'
    );
  END LOOP;
END $$;

-- =====================================================================
-- STEP 3: Houses
-- =====================================================================
-- 10 Rowhouses (RW1..RW10) + 6 Flats, 2 per floor: G1/G2 (Ground),
-- F1/F2 (First), S1/S2 (Second). Rowhouse rate 3000/mo, Flat rate 2000/mo.
DO $$
DECLARE
  v_society_id UUID;
  houses JSONB := '[
    {"no":"RW1","type":"Rowhouse","owner":"Ananya Iyer","amt":3000},
    {"no":"RW2","type":"Rowhouse","owner":"Kavya Menon","amt":3000},
    {"no":"RW3","type":"Rowhouse","owner":"Vikram Malhotra","amt":3000},
    {"no":"RW4","type":"Rowhouse","owner":"Rohan Sharma","amt":3000},
    {"no":"RW5","type":"Rowhouse","owner":"Priya Nair","amt":3000},
    {"no":"RW6","type":"Rowhouse","owner":"Arjun Mehta","amt":3000},
    {"no":"RW7","type":"Rowhouse","owner":"Sneha Reddy","amt":3000},
    {"no":"RW8","type":"Rowhouse","owner":"Karan Kapoor","amt":3000},
    {"no":"RW9","type":"Rowhouse","owner":"Meera Joshi","amt":3000},
    {"no":"RW10","type":"Rowhouse","owner":"Ishita Bansal","amt":3000},
    {"no":"G1","type":"Flat","owner":"Ananya Iyer","amt":2000},
    {"no":"G2","type":"Flat","owner":"Sneha Reddy","amt":2000},
    {"no":"F1","type":"Flat","owner":"Vikram Malhotra","amt":2000},
    {"no":"F2","type":"Flat","owner":"Karan Kapoor","amt":2000},
    {"no":"S1","type":"Flat","owner":"Meera Joshi","amt":2000},
    {"no":"S2","type":"Flat","owner":"Ishita Bansal","amt":2000}
  ]'::jsonb;
  h JSONB;
BEGIN
  SELECT id INTO v_society_id FROM public.societies WHERE name = 'Rosewood Century';
  FOR h IN SELECT * FROM jsonb_array_elements(houses) LOOP
    INSERT INTO public.houses (society_id, house_number, type, owner_name, default_monthly_amount, status)
    VALUES (v_society_id, h->>'no', h->>'type', h->>'owner', (h->>'amt')::numeric, 'Active');
  END LOOP;
END $$;

-- =====================================================================
-- STEP 4: Resident/house assignments
-- =====================================================================
-- Covers all 4 requested scenarios:
--   1. Owner has 1 house, lives in it: Rohan(RW4), Priya(RW5), Arjun(RW6)
--   2. Owner has 2 houses, lives in 1, lets out the other: Ananya owns
--      RW1 (lives) + G1 (let out to Aditya, the tenant who pays)
--   3. Tenant lives in the house, owner absent, tenant pays: Kavya owns
--      RW2 but never lives there; Rahul is the tenant who lives/pays
--   4. Owner has 2 houses, pays dues for both (no tenant on the 2nd):
--      Vikram (RW3+F1), Sneha (RW7+G2), Karan (RW8+F2), Meera (RW9+S1),
--      Ishita (RW10+S2)
DO $$
DECLARE
  v_society_id UUID;
  admin_id UUID;
  assignments JSONB := '[
    {"house":"RW1","email":"ananya.iyer@gmail.com","rel":"Owner"},
    {"house":"RW2","email":"kavya.menon@gmail.com","rel":"Owner"},
    {"house":"RW2","email":"rahul.desai@gmail.com","rel":"Tenant"},
    {"house":"RW3","email":"vikram.malhotra@gmail.com","rel":"Owner"},
    {"house":"RW4","email":"rohan.sharma@gmail.com","rel":"Owner"},
    {"house":"RW5","email":"priya.nair@gmail.com","rel":"Owner"},
    {"house":"RW6","email":"arjun.mehta@gmail.com","rel":"Owner"},
    {"house":"RW7","email":"sneha.reddy@gmail.com","rel":"Owner"},
    {"house":"RW8","email":"karan.kapoor@gmail.com","rel":"Owner"},
    {"house":"RW9","email":"meera.joshi@gmail.com","rel":"Owner"},
    {"house":"RW10","email":"ishita.bansal@gmail.com","rel":"Owner"},
    {"house":"G1","email":"ananya.iyer@gmail.com","rel":"Owner"},
    {"house":"G1","email":"aditya.verma@gmail.com","rel":"Tenant"},
    {"house":"G2","email":"sneha.reddy@gmail.com","rel":"Owner"},
    {"house":"F1","email":"vikram.malhotra@gmail.com","rel":"Owner"},
    {"house":"F2","email":"karan.kapoor@gmail.com","rel":"Owner"},
    {"house":"S1","email":"meera.joshi@gmail.com","rel":"Owner"},
    {"house":"S2","email":"ishita.bansal@gmail.com","rel":"Owner"}
  ]'::jsonb;
  a JSONB;
BEGIN
  SELECT id INTO v_society_id FROM public.societies WHERE name = 'Rosewood Century';
  SELECT auth_user_id INTO admin_id FROM public.society_members WHERE society_id = v_society_id AND is_admin = true LIMIT 1;

  FOR a IN SELECT * FROM jsonb_array_elements(assignments) LOOP
    INSERT INTO public.resident_house_assignments (society_member_id, house_id, status, relationship_type, approved_by, approved_at)
    VALUES (
      (SELECT sm.id FROM public.society_members sm JOIN auth.users u ON u.id = sm.auth_user_id WHERE sm.society_id = v_society_id AND u.email = a->>'email'),
      (SELECT id FROM public.houses WHERE society_id = v_society_id AND house_number = a->>'house'),
      'Active', a->>'rel', admin_id, now()
    );
  END LOOP;
END $$;

-- =====================================================================
-- STEP 5: Billing periods (Jan-Aug 2026) + Maintenance transactions
-- =====================================================================
-- Payment-history bucket per house:
--   regular = all 8 months Closed, paid on time
--   due1    = 7 Closed, Aug Open (1 month due)
--   due2    = 6 Closed, Jul+Aug Open (2 months due)
--   due3    = 5 Closed, Jun-Aug Open (3 months due)
--   advance = all 8 Closed + Sep/Oct 2026 also created & Closed via one
--             lump 2-month advance payment
-- Distribution: regular x7, due1 x4, due2/due3 x3, advance x2 (16 total).
-- Each Closed month gets its own transaction, alternating UPI (paid by
-- the resident) / Cash (recorded by the Admin), all already Verified.
DO $$
DECLARE
  v_society_id UUID;
  admin_id UUID;
  plan JSONB := '[
    {"house":"RW1","bucket":"regular","payer":"ananya.iyer@gmail.com"},
    {"house":"RW2","bucket":"due3","payer":"rahul.desai@gmail.com"},
    {"house":"RW3","bucket":"regular","payer":"vikram.malhotra@gmail.com"},
    {"house":"RW4","bucket":"regular","payer":"rohan.sharma@gmail.com"},
    {"house":"RW5","bucket":"regular","payer":"priya.nair@gmail.com"},
    {"house":"RW6","bucket":"due1","payer":"arjun.mehta@gmail.com"},
    {"house":"RW7","bucket":"regular","payer":"sneha.reddy@gmail.com"},
    {"house":"RW8","bucket":"due1","payer":"karan.kapoor@gmail.com"},
    {"house":"RW9","bucket":"advance","payer":"meera.joshi@gmail.com"},
    {"house":"RW10","bucket":"due2","payer":"ishita.bansal@gmail.com"},
    {"house":"G1","bucket":"due1","payer":"aditya.verma@gmail.com"},
    {"house":"G2","bucket":"due3","payer":"sneha.reddy@gmail.com"},
    {"house":"F1","bucket":"regular","payer":"vikram.malhotra@gmail.com"},
    {"house":"F2","bucket":"due1","payer":"karan.kapoor@gmail.com"},
    {"house":"S1","bucket":"advance","payer":"meera.joshi@gmail.com"},
    {"house":"S2","bucket":"regular","payer":"ishita.bansal@gmail.com"}
  ]'::jsonb;
  p JSONB;
  v_house_id UUID;
  v_amount NUMERIC;
  v_payer_id UUID;
  v_period_month DATE;
  v_bp_id UUID;
  v_txn_id UUID;
  v_closed_count INT;
  i INT;
  v_mode TEXT;
  v_submitter UUID;
  v_utr TEXT;
  v_txn_date TIMESTAMPTZ;
BEGIN
  SELECT id INTO v_society_id FROM public.societies WHERE name = 'Rosewood Century';
  SELECT auth_user_id INTO admin_id FROM public.society_members WHERE society_id = v_society_id AND is_admin = true LIMIT 1;

  FOR p IN SELECT * FROM jsonb_array_elements(plan) LOOP
    SELECT id, default_monthly_amount INTO v_house_id, v_amount FROM public.houses WHERE society_id = v_society_id AND house_number = p->>'house';
    SELECT sm.auth_user_id INTO v_payer_id FROM public.society_members sm JOIN auth.users u ON u.id = sm.auth_user_id WHERE sm.society_id = v_society_id AND u.email = p->>'payer';

    v_closed_count := CASE p->>'bucket'
      WHEN 'regular' THEN 8
      WHEN 'due1' THEN 7
      WHEN 'due2' THEN 6
      WHEN 'due3' THEN 5
      WHEN 'advance' THEN 8
      ELSE 8
    END;

    FOR i IN 1..8 LOOP
      v_period_month := (DATE '2026-01-01' + ((i - 1) * INTERVAL '1 month'))::date;

      INSERT INTO public.billing_periods (society_id, house_id, period_month, base_amount, amount_due, status)
      VALUES (v_society_id, v_house_id, v_period_month, v_amount, v_amount, CASE WHEN i <= v_closed_count THEN 'Closed' ELSE 'Open' END)
      RETURNING id INTO v_bp_id;

      IF i <= v_closed_count THEN
        v_txn_date := (v_period_month + INTERVAL '5 days' + INTERVAL '10 hours')::timestamptz;

        IF i % 2 = 0 THEN
          v_mode := 'Cash';
          v_submitter := admin_id;
          v_utr := NULL;
        ELSE
          v_mode := 'UPI';
          v_submitter := v_payer_id;
          v_utr := 'RWC' || (p->>'house') || 'M' || i::text || to_char(v_period_month, 'YYYYMM');
        END IF;

        INSERT INTO public.transactions (
          society_id, house_id, submitted_by, amount, utr_number, txn_date,
          transaction_type, payment_mode, payment_status, processing_status,
          verified_by, verified_at, created_at, updated_at
        ) VALUES (
          v_society_id, v_house_id, v_submitter, v_amount, v_utr, v_txn_date,
          'Maintenance', v_mode, 'Success', 'Verified', admin_id, v_txn_date, v_txn_date, v_txn_date
        )
        RETURNING id INTO v_txn_id;

        INSERT INTO public.transaction_allocations (transaction_id, billing_period_id, amount_allocated)
        VALUES (v_txn_id, v_bp_id, v_amount);
      END IF;
    END LOOP;

    -- Advance bucket: 2 extra months (Sep+Oct 2026), paid together in one lump UPI transaction.
    IF p->>'bucket' = 'advance' THEN
      DECLARE
        v_bp_sep UUID;
        v_bp_oct UUID;
        v_lump_txn UUID;
        v_adv_date TIMESTAMPTZ := TIMESTAMPTZ '2026-08-20 11:00:00+05:30';
      BEGIN
        INSERT INTO public.billing_periods (society_id, house_id, period_month, base_amount, amount_due, status)
        VALUES (v_society_id, v_house_id, DATE '2026-09-01', v_amount, v_amount, 'Closed')
        RETURNING id INTO v_bp_sep;

        INSERT INTO public.billing_periods (society_id, house_id, period_month, base_amount, amount_due, status)
        VALUES (v_society_id, v_house_id, DATE '2026-10-01', v_amount, v_amount, 'Closed')
        RETURNING id INTO v_bp_oct;

        INSERT INTO public.transactions (
          society_id, house_id, submitted_by, amount, utr_number, txn_date,
          transaction_type, payment_mode, payment_status, processing_status,
          verified_by, verified_at, created_at, updated_at
        ) VALUES (
          v_society_id, v_house_id, v_payer_id, v_amount * 2, 'RWCADV' || (p->>'house') || '2026', v_adv_date,
          'Maintenance', 'UPI', 'Success', 'Verified', admin_id, v_adv_date, v_adv_date, v_adv_date
        )
        RETURNING id INTO v_lump_txn;

        INSERT INTO public.transaction_allocations (transaction_id, billing_period_id, amount_allocated) VALUES
          (v_lump_txn, v_bp_sep, v_amount),
          (v_lump_txn, v_bp_oct, v_amount);
      END;
    END IF;
  END LOOP;
END $$;

-- =====================================================================
-- STEP 6: WaterCharge transactions (pay-as-you-go, no billing_periods link)
-- =====================================================================
-- 6 rows spread across different houses/months, mixing UPI/Cash; one
-- (G1/Aditya) is left un-Verified to show the pending-review state.
DO $$
DECLARE
  v_society_id UUID;
  admin_id UUID;
  wc JSONB := '[
    {"house":"RW1","payer":"ananya.iyer@gmail.com","amount":300,"mode":"UPI","verified":true,"date":"2026-02-10","note":"Extra tanker water - February"},
    {"house":"RW3","payer":"vikram.malhotra@gmail.com","amount":250,"mode":"Cash","verified":true,"date":"2026-03-15","note":"Tanker water - March"},
    {"house":"RW7","payer":"sneha.reddy@gmail.com","amount":400,"mode":"UPI","verified":true,"date":"2026-04-20","note":"Extra water usage - April"},
    {"house":"G1","payer":"aditya.verma@gmail.com","amount":200,"mode":"UPI","verified":false,"date":"2026-05-05","note":"Tanker water"},
    {"house":"RW9","payer":"meera.joshi@gmail.com","amount":350,"mode":"Cash","verified":true,"date":"2026-06-12","note":"Extra water tanker - June"},
    {"house":"RW4","payer":"rohan.sharma@gmail.com","amount":300,"mode":"UPI","verified":true,"date":"2026-07-08","note":"Extra water usage - July"}
  ]'::jsonb;
  w JSONB;
  v_house_id UUID;
  v_payer_id UUID;
  v_txn_date TIMESTAMPTZ;
  v_utr TEXT;
  v_counter INT := 0;
BEGIN
  SELECT id INTO v_society_id FROM public.societies WHERE name = 'Rosewood Century';
  SELECT auth_user_id INTO admin_id FROM public.society_members WHERE society_id = v_society_id AND is_admin = true LIMIT 1;

  FOR w IN SELECT * FROM jsonb_array_elements(wc) LOOP
    v_counter := v_counter + 1;
    SELECT id INTO v_house_id FROM public.houses WHERE society_id = v_society_id AND house_number = w->>'house';
    SELECT sm.auth_user_id INTO v_payer_id FROM public.society_members sm JOIN auth.users u ON u.id = sm.auth_user_id WHERE sm.society_id = v_society_id AND u.email = w->>'payer';
    v_txn_date := ((w->>'date')::date + INTERVAL '9 hours')::timestamptz;
    v_utr := CASE WHEN w->>'mode' = 'UPI' THEN 'RWCWTR' || lpad(v_counter::text, 4, '0') ELSE NULL END;

    INSERT INTO public.transactions (
      society_id, house_id, submitted_by, amount, utr_number, txn_date,
      transaction_type, payment_mode, description, payment_status, processing_status,
      verified_by, verified_at, created_at, updated_at
    ) VALUES (
      v_society_id, v_house_id,
      CASE WHEN w->>'mode' = 'Cash' THEN admin_id ELSE v_payer_id END,
      (w->>'amount')::numeric, v_utr, v_txn_date,
      'WaterCharge', w->>'mode', w->>'note', 'Success',
      CASE WHEN (w->>'verified')::boolean THEN 'Verified' ELSE 'Submitted' END,
      CASE WHEN (w->>'verified')::boolean THEN admin_id ELSE NULL END,
      CASE WHEN (w->>'verified')::boolean THEN v_txn_date ELSE NULL END,
      v_txn_date, v_txn_date
    );
  END LOOP;
END $$;

-- =====================================================================
-- STEP 7: Monthly society expense transactions (Jan-Aug 2026)
-- =====================================================================
-- 5 recurring vendors/staff x 8 months = 40 rows. house_id NULL, all
-- submitted+auto-verified by the Admin, mixing Cash/NEFT_IMPS.
DO $$
DECLARE
  v_society_id UUID;
  admin_id UUID;
  categories JSONB := '[
    {"payee":"SecureGuard Security Agency","type":"Other","amount":10000,"desc":"Security agency charges","mode":"NEFT_IMPS"},
    {"payee":"State Electricity Board","type":"UtilityBill","amount":5000,"desc":"Common area electricity bill","mode":"NEFT_IMPS"},
    {"payee":"Green Thumb Gardening Services","type":"Salary","amount":2000,"desc":"Gardener monthly charges","mode":"Cash"},
    {"payee":"AquaClear STP Services","type":"Other","amount":5000,"desc":"STP maintenance charges","mode":"NEFT_IMPS"},
    {"payee":"Ramesh - Cleaning Staff","type":"Salary","amount":1500,"desc":"Cleaner monthly wages","mode":"Cash"}
  ]'::jsonb;
  c JSONB;
  i INT;
  v_month DATE;
  v_txn_date TIMESTAMPTZ;
  v_utr TEXT;
  v_counter INT := 0;
BEGIN
  SELECT id INTO v_society_id FROM public.societies WHERE name = 'Rosewood Century';
  SELECT auth_user_id INTO admin_id FROM public.society_members WHERE society_id = v_society_id AND is_admin = true LIMIT 1;

  FOR i IN 1..8 LOOP
    v_month := (DATE '2026-01-01' + ((i - 1) * INTERVAL '1 month'))::date;
    FOR c IN SELECT * FROM jsonb_array_elements(categories) LOOP
      v_counter := v_counter + 1;
      v_txn_date := (v_month + INTERVAL '2 days' + INTERVAL '10 hours')::timestamptz;
      v_utr := CASE WHEN c->>'mode' = 'Cash' THEN NULL ELSE 'RWCEXP' || lpad(v_counter::text, 4, '0') END;

      INSERT INTO public.transactions (
        society_id, house_id, submitted_by, amount, utr_number, txn_date,
        transaction_type, payment_mode, payee_name, description,
        payment_status, processing_status, verified_by, verified_at, created_at, updated_at
      ) VALUES (
        v_society_id, NULL, admin_id, (c->>'amount')::numeric, v_utr, v_txn_date,
        c->>'type', c->>'mode', c->>'payee', to_char(v_month, 'FMMonth YYYY') || ' - ' || (c->>'desc'),
        'Success', 'Verified', admin_id, v_txn_date, v_txn_date, v_txn_date
      );
    END LOOP;
  END LOOP;
END $$;

-- =====================================================================
-- STEP 8: Sanity-check counts
-- =====================================================================
SELECT 'societies' AS table_name, count(*) FROM public.societies
UNION ALL SELECT 'society_members', count(*) FROM public.society_members
UNION ALL SELECT 'houses', count(*) FROM public.houses
UNION ALL SELECT 'resident_house_assignments', count(*) FROM public.resident_house_assignments
UNION ALL SELECT 'billing_periods', count(*) FROM public.billing_periods
UNION ALL SELECT 'billing_periods (Open)', count(*) FROM public.billing_periods WHERE status = 'Open'
UNION ALL SELECT 'transactions', count(*) FROM public.transactions
UNION ALL SELECT 'transactions (Maintenance)', count(*) FROM public.transactions WHERE transaction_type = 'Maintenance'
UNION ALL SELECT 'transactions (WaterCharge)', count(*) FROM public.transactions WHERE transaction_type = 'WaterCharge'
UNION ALL SELECT 'transactions (expenses)', count(*) FROM public.transactions WHERE transaction_type IN ('UtilityBill', 'Salary', 'Other')
UNION ALL SELECT 'transaction_allocations', count(*) FROM public.transaction_allocations;
