-- Widen transaction visibility to co-assignees of the same house.
--
-- Prior behaviour: "Residents can view their own transactions" only allowed
-- submitted_by = auth.uid(). This meant an owner who rents out a house to a
-- tenant (both with active resident_house_assignments rows on that house)
-- had no way to see whether the tenant had paid that month's dues - they
-- would need to ask the tenant directly or be an Admin/Committee member.
--
-- Fix: any resident with an active assignment to a transaction's house_id
-- may view that house's transactions, not just the ones they submitted
-- themselves. This mirrors the existing pattern already used for the
-- billing_periods read policy.

DROP POLICY IF EXISTS "Residents can view their own transactions" ON transactions;

CREATE POLICY "Residents can view transactions for their assigned houses" ON transactions
FOR SELECT USING (
    submitted_by = auth.uid()
    OR EXISTS (
        SELECT 1 FROM resident_house_assignments rha
        JOIN society_members sm ON rha.society_member_id = sm.id
        WHERE rha.house_id = transactions.house_id
        AND sm.auth_user_id = auth.uid()
        AND rha.status = 'Active'
    )
);
