-- Two Medium-severity findings from the 2026-09-13 security audit
-- (separate from the Critical/High fixes in
-- 20260913010000_harden_transaction_insert_and_house_owner_update.sql).
-- Both are re-runnable (DROP IF EXISTS then CREATE), same convention as
-- every other migration in this project.

--
-- 1. Residents could attach a payment allocation to a Closed or Waived
-- billing period. The original Open-period requirement
-- (20260724000000_initial_schema.sql's own transactions INSERT policy)
-- was dropped when allocations moved into their own table
-- (20260725020000_add_transaction_allocations_and_default_rate.sql) and
-- never re-added to the new transaction_allocations INSERT policy -
-- confirmed by re-reading that policy's own history while writing this
-- fix. Not exploitable for double-payment today (application code
-- already only ever allocates against Open periods via computeAllocations
-- in backend/src/routes/transactions.js), but a direct PostgREST call
-- bypassing Express could otherwise attach a stray allocation row to an
-- already-Closed period.
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
        AND bp.status = 'Open'
        AND sm.auth_user_id = auth.uid()
        AND rha.status = 'Active'
        AND sm.status = 'Active'
    )
);

--
-- 2. A Suspended member could still update their own name/phone_number via
-- the self-service policy added in
-- 20260913000000_allow_resident_self_service_profile_update.sql - that
-- policy's own USING/WITH CHECK never looked at status at all, only
-- auth_user_id. Everywhere else in this schema, "Suspended loses every
-- resident capability" is the explicit, deliberate rule
-- (20260727000000_enforce_suspended_status_in_rls.sql) - this was a gap in
-- that rule, not an intentional exception.
--
-- The column-guard trigger from that same migration
-- (guard_society_member_privileged_fields) is untouched and still applies
-- on top of this - this only narrows WHICH ROWS the self-service policy
-- itself reaches.
DROP POLICY IF EXISTS "Users can update their own society_member record" ON society_members;
CREATE POLICY "Users can update their own society_member record" ON society_members
FOR UPDATE USING (
    auth_user_id = auth.uid()
    AND status = 'Active'
) WITH CHECK (
    auth_user_id = auth.uid()
    AND status = 'Active'
);

-- Not affected by either change above (verified before writing this):
--   - Admin-driven society_members updates (PATCH /members/:id, /suspend,
--     /reactivate) all go through the separate "Admins can manage society
--     members" FOR ALL policy (is_society_admin_or_committee-gated for
--     read, is_society_admin-gated for write), never this self-service
--     one - an Admin can still reactivate/edit a Suspended member exactly
--     as before.
--   - Every current allocation-creating code path
--     (POST /transactions and POST /transactions/upi-intent, both via
--     computeAllocations in backend/src/routes/transactions.js) already
--     only ever selects Open billing_periods to allocate against - no
--     application code change needed alongside this migration.
