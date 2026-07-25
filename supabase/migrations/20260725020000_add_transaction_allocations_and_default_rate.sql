-- Fixes a real structural gap: transactions.billing_period_id was a single
-- FK, so one payment (one UTR) could only ever be linked to one billing
-- period. That breaks both "resident clears several months of arrears in
-- one lump payment" and "resident prepays a couple of months ahead" - both
-- need one transaction to map to multiple billing_periods rows.
--
-- Fix: a proper many-to-many join table, transaction_allocations, replaces
-- the single FK. transactions.billing_period_id is dropped entirely rather
-- than kept as a "primary period plus extras" hybrid - there is now exactly
-- one path (the allocations table) for every case, including the single-
-- period one.
--
-- Also adds houses.default_monthly_amount: the trusted, admin-configured
-- recurring rate used both for future bulk period generation and for
-- on-demand generation when a resident pays ahead of the billing cycle.
-- Deliberately never derived from a resident-submitted, unverified amount.

--
-- houses.default_monthly_amount
--
ALTER TABLE houses ADD COLUMN default_monthly_amount NUMERIC(10, 2);
ALTER TABLE houses ADD CONSTRAINT chk_default_monthly_amount_non_negative
CHECK (default_monthly_amount IS NULL OR default_monthly_amount >= 0);
COMMENT ON COLUMN houses.default_monthly_amount IS 'Recurring monthly maintenance rate for this house. Used by bulk and on-demand billing_periods generation. Nullable until an admin configures it - generation is blocked (not defaulted to zero) until then.';

--
-- Drop the policies and index that reference transactions.billing_period_id
-- before dropping the column itself.
--
DROP POLICY IF EXISTS "Residents can insert their own transactions" ON transactions;
DROP POLICY IF EXISTS "Admins can insert transactions for residents" ON transactions;
DROP INDEX IF EXISTS idx_transactions_society_house_billing;

ALTER TABLE transactions DROP COLUMN billing_period_id;

CREATE INDEX idx_transactions_society_house ON transactions (society_id, house_id);

-- Recreated without the old "AND EXISTS billing_periods bp ... status = 'Open'"
-- clause - that check now lives on transaction_allocations instead, since
-- period validity is now a property of each allocation, not of the
-- transaction row itself.
CREATE POLICY "Residents can insert their own transactions" ON transactions
FOR INSERT WITH CHECK (
    submitted_by = auth.uid()
    AND EXISTS (
        SELECT 1 FROM resident_house_assignments rha
        JOIN society_members sm ON rha.society_member_id = sm.id
        WHERE rha.house_id = transactions.house_id
        AND sm.auth_user_id = auth.uid()
        AND rha.status = 'Active'
    )
);

CREATE POLICY "Admins can insert transactions for residents" ON transactions
FOR INSERT WITH CHECK (
    EXISTS (
        SELECT 1 FROM society_members sm_admin
        WHERE sm_admin.society_id = transactions.society_id
        AND sm_admin.auth_user_id = auth.uid()
        AND sm_admin.role = 'Admin'
    )
);

--
-- Table: transaction_allocations
--
CREATE TABLE transaction_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    billing_period_id UUID NOT NULL REFERENCES billing_periods(id) ON DELETE RESTRICT,
    amount_allocated NUMERIC(10, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_amount_allocated_positive CHECK (amount_allocated > 0),
    CONSTRAINT unique_allocation_per_transaction_period UNIQUE (transaction_id, billing_period_id)
);

COMMENT ON TABLE transaction_allocations IS 'Splits one transaction (one payment, one UTR) across the one or more billing periods it covers - arrears catch-up and advance payments both produce more than one row here for a single transaction.';

CREATE INDEX idx_transaction_allocations_transaction ON transaction_allocations (transaction_id);
CREATE INDEX idx_transaction_allocations_billing_period ON transaction_allocations (billing_period_id);

ALTER TABLE transaction_allocations ENABLE ROW LEVEL SECURITY;

-- SELECT: visible to anyone who can already see the parent transaction -
-- mirrors the widened co-assignee transactions policy from
-- 20260725000000_widen_transaction_visibility_to_coassignees.sql exactly,
-- so allocation visibility never leaks beyond transaction visibility.
CREATE POLICY "Residents can view allocations for visible transactions" ON transaction_allocations
FOR SELECT USING (
    EXISTS (
        SELECT 1 FROM transactions t
        WHERE t.id = transaction_allocations.transaction_id
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

CREATE POLICY "Admins and Committee can view all society allocations" ON transaction_allocations
FOR SELECT USING (
    EXISTS (
        SELECT 1 FROM transactions t
        WHERE t.id = transaction_allocations.transaction_id
        AND public.is_society_admin_or_committee(t.society_id)
    )
);

-- INSERT: the caller must be allowed to submit the parent transaction AND
-- have visibility into the specific billing period being allocated to
-- (i.e. an active assignment to that period's house) - this is where the
-- "must be an open, valid billing period for this house" check that used
-- to live on transactions.billing_period_id now lives.
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
    )
);

CREATE POLICY "Admins can allocate transactions in their society" ON transaction_allocations
FOR INSERT WITH CHECK (
    EXISTS (
        SELECT 1 FROM transactions t
        WHERE t.id = transaction_allocations.transaction_id
        AND public.is_society_admin(t.society_id)
    )
);
