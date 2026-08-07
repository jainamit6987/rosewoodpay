-- Two additions for the new Month-End Closing report (discussed and
-- designed with the user - a monthly Income/Expense-by-payment-mode
-- statement, split Bank vs Cash, shared externally with residents as a
-- PDF export):
--
-- 1. A real `direction` column on transactions, replacing the
--    hardcoded-by-transaction_type Cr/Dr inference that
--    GET /society/:id/transaction-report used until now (Maintenance/
--    WaterCharge always Cr, UtilityBill/Salary/Other always Dr - see that
--    route's own comment, being replaced in the same change as this
--    migration). That inference had no way to represent an "Other"
--    transaction that is actually money coming IN (e.g. a refund, a bank
--    interest credit, a one-off donation) - discussed with the user while
--    designing the Month-End Closing report's "Other" income/expense
--    breakdown, which needs exactly that.
--
-- 2. society_month_closings: one row per society per month holding the
--    Admin-supplied opening balances and the computed closing balances.
--
-- direction is NOT NULL with no default - every INSERT must set it
-- explicitly (see routes/transactions.js), so there is no silent
-- "forgot to set it" gap. Backfilled below from the exact rule the
-- application layer already used before this column existed.
ALTER TABLE transactions ADD COLUMN direction VARCHAR(2);

UPDATE transactions
SET direction = CASE
    WHEN transaction_type IN ('Maintenance', 'WaterCharge') THEN 'Cr'
    ELSE 'Dr'
END;

ALTER TABLE transactions ALTER COLUMN direction SET NOT NULL;

ALTER TABLE transactions ADD CONSTRAINT chk_direction CHECK (direction IN ('Cr', 'Dr'));

-- Maintenance/WaterCharge stay permanently Cr and Salary/UtilityBill stay
-- permanently Dr, matching what the application layer already enforces
-- unconditionally for those four types - only Other is actually free to
-- be either direction, since it is the one type that can genuinely be
-- either a miscellaneous receipt (Cr) or a miscellaneous payment (Dr).
ALTER TABLE transactions ADD CONSTRAINT chk_direction_matches_type CHECK (
    (transaction_type IN ('Maintenance', 'WaterCharge') AND direction = 'Cr')
    OR (transaction_type IN ('Salary', 'UtilityBill') AND direction = 'Dr')
    OR (transaction_type = 'Other')
);

COMMENT ON COLUMN transactions.direction IS 'Cr (money in) or Dr (money out). Fixed by transaction_type for Maintenance/WaterCharge (always Cr) and Salary/UtilityBill (always Dr) - only Other can genuinely be either, e.g. a refund/interest credit (Cr) vs a donation/misc purchase (Dr). See chk_direction_matches_type and routes/transactions.js.';

-- Month-End Closing report: one row per society per calendar month,
-- holding the Admin-supplied Bank and Cash Opening Balances for that
-- month, plus the Bank/Cash Closing Balances computed and stored at
-- generation time (Opening + that month's own Bank/Cash income - that
-- month's own Bank/Cash expense, where "Bank" is
-- payment_mode IN ('UPI','NEFT_IMPS','Cheque') and "Cash" is
-- payment_mode = 'Cash' - see routes/society.js's month-end-closing
-- routes). Freely regenerable, no lock/finalize flag - re-running
-- POST .../month-end-closing for an already-generated month recomputes
-- and overwrites both closing balances (e.g. a backdated transaction gets
-- verified after the month was first generated). What actually keeps the
-- numbers trustworthy is the generation-time guard in the route (blocks
-- if any Submitted transaction dated on/before this month is still
-- unresolved), not a stored lock here.
CREATE TABLE society_month_closings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    month DATE NOT NULL,
    bank_opening_balance NUMERIC(12, 2) NOT NULL,
    cash_opening_balance NUMERIC(12, 2) NOT NULL,
    bank_closing_balance NUMERIC(12, 2) NOT NULL,
    cash_closing_balance NUMERIC(12, 2) NOT NULL,
    generated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_society_month_closings_society_month UNIQUE (society_id, month),
    CONSTRAINT chk_society_month_closings_month_is_first_of_month CHECK (date_trunc('month', month) = month)
);

COMMENT ON TABLE society_month_closings IS 'One row per society per calendar month - Admin-supplied Bank/Cash Opening Balances and the computed Bank/Cash Closing Balances for the Month-End Closing report. See routes/society.js GET/POST /:id/month-end-closing.';

ALTER TABLE society_month_closings ENABLE ROW LEVEL SECURITY;

-- Same Admin-or-Committee-can-view / Admin-only-can-write split as
-- billing_periods and audit_events, using the same two SECURITY DEFINER
-- helpers every other table's policies already call (see
-- 20260726000000_replace_role_with_boolean_flags.sql /
-- 20260727000000_enforce_suspended_status_in_rls.sql) - both already
-- check status = 'Active', so no separate check is needed here.
CREATE POLICY "Admins and Committee can view month closings" ON society_month_closings
FOR SELECT USING (
    public.is_society_admin_or_committee(society_id)
);

CREATE POLICY "Admins can manage month closings" ON society_month_closings
FOR ALL USING (
    public.is_society_admin(society_id)
) WITH CHECK (
    public.is_society_admin(society_id)
);
