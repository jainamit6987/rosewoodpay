-- Replaces society_members.role (VARCHAR 'Resident'/'Admin') with an
-- is_admin BOOLEAN, sitting alongside the existing is_committee_member
-- BOOLEAN. Motivation: "Admin" and "lives here and owes their own dues"
-- are not mutually exclusive in real societies - a secretary/treasurer
-- commonly also occupies a house - but role as a single exclusive value
-- forced every policy, and GET /me, to treat them as an either/or. Two
-- independent capability flags (both false = plain resident) let a member
-- be an admin AND have their own resident_house_assignments/personal dues
-- at the same time, with no special-casing anywhere.
--
-- role='Resident' never meant anything beyond "not an Admin" in this
-- schema - no policy ever required a house assignment to prove residency,
-- and nothing below invents an is_resident flag to replace it; a plain
-- resident is simply a row where both booleans are false.
--
-- This migration is a mechanical translation, not new authorization logic:
-- every policy across every table that referenced role (grep for
-- "role = 'Admin'"/"role = 'Resident'" across the initial schema and every
-- later migration finds all of them) must be dropped and recreated before
-- the column itself can be dropped, the same dependency reasoning as the
-- billing_period_id drop in 20260725020000_add_transaction_allocations_and_default_rate.sql.
-- Where a raw EXISTS subquery duplicated logic the existing SECURITY
-- DEFINER helper functions (is_society_admin / is_society_admin_or_committee,
-- from 20260724120000_fix_society_members_rls_recursion.sql) already
-- encapsulate, recreated policies call those functions instead - same
-- resulting access, less duplicated SQL, matching the style
-- transaction_allocations' policies already use.

--
-- 1. Add is_admin, backfill from role.
--
ALTER TABLE society_members ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;
UPDATE society_members SET is_admin = true WHERE role = 'Admin';

--
-- 2. Drop every policy that references role, across every table, before
-- the column can be dropped.
--
DROP POLICY IF EXISTS "Admins and Committee can view societies" ON societies;
DROP POLICY IF EXISTS "Residents can view their society" ON societies;
DROP POLICY IF EXISTS "Admins can update their society" ON societies;
DROP POLICY IF EXISTS "Admins and Committee can view houses" ON houses;
DROP POLICY IF EXISTS "Admins can manage houses" ON houses;
DROP POLICY IF EXISTS "Admins and Committee can view house assignments" ON resident_house_assignments;
DROP POLICY IF EXISTS "Admins can manage house assignments" ON resident_house_assignments;
DROP POLICY IF EXISTS "Admins and Committee can view billing periods" ON billing_periods;
DROP POLICY IF EXISTS "Admins can manage billing periods" ON billing_periods;
DROP POLICY IF EXISTS "Admins can insert transactions for residents" ON transactions;
DROP POLICY IF EXISTS "Admins and Committee can view all society transactions" ON transactions;
DROP POLICY IF EXISTS "Admins can update society transactions" ON transactions;
DROP POLICY IF EXISTS "Admins and Committee can view audit events" ON audit_events;
DROP POLICY IF EXISTS "Admins can insert audit events for their society" ON audit_events;

--
-- 3. Now safe to drop role entirely.
--
ALTER TABLE society_members DROP CONSTRAINT chk_member_role;
ALTER TABLE society_members DROP COLUMN role;

--
-- 4. Update the two helper functions to check is_admin. Signatures and
-- callers (society_members' own two policies, both transaction_allocations
-- policies) are unchanged - CREATE OR REPLACE means every existing caller
-- picks up the new behavior automatically, no further edits needed there.
--
CREATE OR REPLACE FUNCTION public.is_society_admin(target_society_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM society_members
    WHERE society_id = target_society_id
      AND auth_user_id = auth.uid()
      AND is_admin = true
  );
$$;

CREATE OR REPLACE FUNCTION public.is_society_admin_or_committee(target_society_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM society_members
    WHERE society_id = target_society_id
      AND auth_user_id = auth.uid()
      AND (is_admin = true OR is_committee_member = true)
  );
$$;

--
-- 5. Recreate every dropped policy.
--

-- societies: the old "Residents can view their society" / "Admins and
-- Committee can view societies" split only ever existed because role made
-- every member either-or - both policies already granted SELECT to every
-- member of the society, one way or the other, so this collapses into one
-- simpler policy with identical resulting access, not a behavior change.
CREATE POLICY "Members can view their own society" ON societies
FOR SELECT USING (
    EXISTS (SELECT 1 FROM society_members WHERE society_id = societies.id AND auth_user_id = auth.uid())
);
CREATE POLICY "Admins can update their society" ON societies
FOR UPDATE USING (
    public.is_society_admin(id)
) WITH CHECK (
    public.is_society_admin(id)
);

-- houses
CREATE POLICY "Admins and Committee can view houses" ON houses
FOR SELECT USING (
    public.is_society_admin_or_committee(society_id)
);
CREATE POLICY "Admins can manage houses" ON houses
FOR ALL USING (
    public.is_society_admin(society_id)
) WITH CHECK (
    public.is_society_admin(society_id)
);

-- resident_house_assignments
CREATE POLICY "Admins and Committee can view house assignments" ON resident_house_assignments
FOR SELECT USING (
    public.is_society_admin_or_committee((SELECT society_id FROM houses WHERE id = resident_house_assignments.house_id))
);
CREATE POLICY "Admins can manage house assignments" ON resident_house_assignments
FOR ALL USING (
    public.is_society_admin((SELECT society_id FROM houses WHERE id = resident_house_assignments.house_id))
) WITH CHECK (
    public.is_society_admin((SELECT society_id FROM houses WHERE id = resident_house_assignments.house_id))
);

-- billing_periods
CREATE POLICY "Admins and Committee can view billing periods" ON billing_periods
FOR SELECT USING (
    public.is_society_admin_or_committee(society_id)
);
CREATE POLICY "Admins can manage billing periods" ON billing_periods
FOR ALL USING (
    public.is_society_admin(society_id)
) WITH CHECK (
    public.is_society_admin(society_id)
);

-- transactions
CREATE POLICY "Admins can insert transactions for residents" ON transactions
FOR INSERT WITH CHECK (
    public.is_society_admin(society_id)
);
CREATE POLICY "Admins and Committee can view all society transactions" ON transactions
FOR SELECT USING (
    public.is_society_admin_or_committee(society_id)
);
CREATE POLICY "Admins can update society transactions" ON transactions
FOR UPDATE USING (
    public.is_society_admin(society_id)
) WITH CHECK (
    public.is_society_admin(society_id)
);

-- audit_events
CREATE POLICY "Admins and Committee can view audit events" ON audit_events
FOR SELECT USING (
    public.is_society_admin_or_committee(society_id)
);
CREATE POLICY "Admins can insert audit events for their society" ON audit_events
FOR INSERT WITH CHECK (
    public.is_society_admin(society_id)
);
