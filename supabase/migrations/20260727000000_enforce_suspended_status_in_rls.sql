-- Makes society_members.status a real access-control gate, not just a
-- display label. Audited every RLS policy in the schema and found that
-- NOT ONE of them ever checked status - is_society_admin/
-- is_society_admin_or_committee (the two SECURITY DEFINER helpers used
-- everywhere) only ever checked is_admin/is_committee_member, and every
-- resident-facing policy only ever checked resident_house_assignments.status
-- ('Active' assignment), never society_members.status itself. A member
-- set to 'Suspended' today would keep every capability they had a moment
-- before - the column existed since the initial schema and seed.sql sets
-- it, but nothing anywhere ever read it.
--
-- Decision (discussed with the user before building the Members CRUD
-- feature that finally needed a real Suspend action): full enforcement -
-- a Suspended member loses admin/committee powers AND their own resident
-- actions (submit payments, view dues/houses/assignments) - not just a
-- partial "admin powers only" cut. Deliberately NOT touched:
--   - "Users can view their own society_member record" (society_members
--     SELECT) - a member must always be able to see their OWN row,
--     otherwise they - and GET /me - have no way to discover they've been
--     suspended at all, rather than just seeing everything else go empty
--     for no visible reason.
--   - "Members can view their own society" (societies SELECT) - left as
--     just basic society identity (name/UPI info), not resident/admin
--     "action" data - low value to gate, and gating it risks subtly
--     breaking something that joins through it later for no real
--     security benefit.

--
-- 1. The two SECURITY DEFINER helpers - fixing these alone covers every
-- policy that calls them: societies UPDATE, houses SELECT+ALL,
-- resident_house_assignments SELECT+ALL, billing_periods SELECT+ALL,
-- transactions SELECT+INSERT(admin)+UPDATE, audit_events SELECT+INSERT,
-- society_members SELECT("view all")+ALL("manage"). Same CREATE OR
-- REPLACE pattern as 20260726000000 - existing callers pick this up with
-- no further edits.
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
      AND status = 'Active'
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
      AND status = 'Active'
  );
$$;

--
-- 2. Direct resident-facing policies that never went through the helper
-- functions above, so each needs its own status = 'Active' check added.
--

-- houses: residents can view houses in their own society.
DROP POLICY IF EXISTS "Residents can view houses in their society" ON houses;
CREATE POLICY "Residents can view houses in their society" ON houses
FOR SELECT USING (
    EXISTS (SELECT 1 FROM society_members WHERE society_id = houses.society_id AND auth_user_id = auth.uid() AND status = 'Active')
);

-- resident_house_assignments: a resident's own assignment rows.
DROP POLICY IF EXISTS "Residents can view their own active assignments" ON resident_house_assignments;
CREATE POLICY "Residents can view their own active assignments" ON resident_house_assignments
FOR SELECT USING (
    EXISTS (SELECT 1 FROM society_members WHERE id = resident_house_assignments.society_member_id AND auth_user_id = auth.uid() AND status = 'Active')
);

-- billing_periods: residents viewing their own assigned houses' periods.
DROP POLICY IF EXISTS "Residents can view billing periods for their assigned flats" ON billing_periods;
CREATE POLICY "Residents can view billing periods for their assigned flats" ON billing_periods
FOR SELECT USING (
    EXISTS (
        SELECT 1 FROM resident_house_assignments rha
        JOIN society_members sm ON rha.society_member_id = sm.id
        WHERE rha.house_id = billing_periods.house_id
        AND sm.auth_user_id = auth.uid()
        AND rha.status = 'Active'
        AND sm.status = 'Active'
    )
);

-- transactions: residents submitting their own payment.
DROP POLICY IF EXISTS "Residents can insert their own transactions" ON transactions;
CREATE POLICY "Residents can insert their own transactions" ON transactions
FOR INSERT WITH CHECK (
    submitted_by = auth.uid()
    AND EXISTS (
        SELECT 1 FROM resident_house_assignments rha
        JOIN society_members sm ON rha.society_member_id = sm.id
        WHERE rha.house_id = transactions.house_id
        AND sm.auth_user_id = auth.uid()
        AND rha.status = 'Active'
        AND sm.status = 'Active'
    )
);

-- transactions: residents/co-assignees viewing transactions - wrapped in
-- an outer "caller is an Active member of this transaction's own society"
-- gate, since the submitted_by = auth.uid() branch has no natural join
-- point of its own to attach a status check to otherwise.
DROP POLICY IF EXISTS "Residents can view transactions for their assigned houses" ON transactions;
CREATE POLICY "Residents can view transactions for their assigned houses" ON transactions
FOR SELECT USING (
    EXISTS (
        SELECT 1 FROM society_members sm2
        WHERE sm2.auth_user_id = auth.uid() AND sm2.society_id = transactions.society_id AND sm2.status = 'Active'
    )
    AND (
        submitted_by = auth.uid()
        OR EXISTS (
            SELECT 1 FROM resident_house_assignments rha
            JOIN society_members sm ON rha.society_member_id = sm.id
            WHERE rha.house_id = transactions.house_id
            AND sm.auth_user_id = auth.uid()
            AND rha.status = 'Active'
        )
    )
);

-- transaction_allocations: mirrors the transactions SELECT policy exactly
-- (allocation visibility must never exceed transaction visibility).
DROP POLICY IF EXISTS "Residents can view allocations for visible transactions" ON transaction_allocations;
CREATE POLICY "Residents can view allocations for visible transactions" ON transaction_allocations
FOR SELECT USING (
    EXISTS (
        SELECT 1 FROM transactions t
        WHERE t.id = transaction_allocations.transaction_id
        AND EXISTS (
            SELECT 1 FROM society_members sm2
            WHERE sm2.auth_user_id = auth.uid() AND sm2.society_id = t.society_id AND sm2.status = 'Active'
        )
        AND (
            t.submitted_by = auth.uid()
            OR EXISTS (
                SELECT 1 FROM resident_house_assignments rha
                JOIN society_members sm ON rha.society_member_id = sm.id
                WHERE rha.house_id = t.house_id
                AND sm.auth_user_id = auth.uid()
                AND rha.status = 'Active'
            )
        )
    )
);

-- transaction_allocations: residents allocating their own transaction - the
-- second EXISTS already joins society_members as sm, so this is a plain
-- added condition, same as billing_periods/insert above.
DROP POLICY IF EXISTS "Residents can allocate their own transactions to their houses" ON transaction_allocations;
CREATE POLICY "Residents can allocate their own transactions to their houses" ON transaction_allocations
FOR INSERT WITH CHECK (
    EXISTS (
        SELECT 1 FROM transactions t
        WHERE t.id = transaction_allocations.transaction_id
        AND t.submitted_by = auth.uid()
    )
    AND EXISTS (
        SELECT 1 FROM billing_periods bp
        JOIN resident_house_assignments rha ON rha.house_id = bp.house_id
        JOIN society_members sm ON sm.id = rha.society_member_id
        WHERE bp.id = transaction_allocations.billing_period_id
        AND sm.auth_user_id = auth.uid()
        AND rha.status = 'Active'
        AND sm.status = 'Active'
    )
);

-- NOTE for backend/src/routes/transactions.js: three app-layer checks
-- there query society_members directly for `is_admin = true` on the
-- CALLER'S OWN row (not through either helper function above) - and a
-- member can always see their own row via the deliberately-ungated
-- "Users can view their own society_member record" policy, regardless of
-- status. So those three checks needed `.eq('status', 'Active')` added
-- explicitly in application code - this migration's RLS changes alone do
-- NOT close that gap for them. Fixed in the same change as this migration.
