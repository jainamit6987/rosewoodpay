-- Closes the gap called out in the transaction_type migration
-- (20260725030000_add_transaction_type_and_multiple_rule.sql): UtilityBill/
-- Salary/Other transactions were accepted by the CHECK constraint but had
-- nowhere sensible to go - POST /transactions forced every transaction
-- through the same house-scoped, billing-period-consuming FIFO allocation
-- as Maintenance, which is conceptually wrong for a society-wide utility
-- bill or a labour salary payment: neither is "owed" by any specific
-- house's billing periods. Those are the society itself paying a vendor
-- or an employee, not a resident paying the society.
--
-- Fix: house_id becomes optional, enforced by a real CHECK constraint
-- (both columns live on the same row, so - unlike the base-amount-multiple
-- rule, which needed houses.default_monthly_amount from a different
-- table - this one can genuinely live in the database, not just the app
-- layer). A new payee_name column identifies who/what was paid for the
-- types that have no house to identify it via.

ALTER TABLE transactions ALTER COLUMN house_id DROP NOT NULL;

ALTER TABLE transactions ADD COLUMN payee_name VARCHAR(150);

ALTER TABLE transactions ADD CONSTRAINT chk_house_id_required_for_maintenance_only CHECK (
    (transaction_type = 'Maintenance' AND house_id IS NOT NULL)
    OR (transaction_type <> 'Maintenance' AND house_id IS NULL)
);

ALTER TABLE transactions ADD CONSTRAINT chk_payee_name_required_for_expenses CHECK (
    (transaction_type = 'Maintenance')
    OR (payee_name IS NOT NULL AND length(btrim(payee_name)) > 0)
);

COMMENT ON COLUMN transactions.payee_name IS 'Who or what was paid - required for UtilityBill/Salary/Other transactions (e.g. "BEST Electricity", "Ramesh - Security Guard"). Always NULL for Maintenance, where the house_id itself identifies the payer.';

-- No RLS policy changes needed. Neither existing INSERT policy references
-- house_id at all:
--   - "Residents can insert their own transactions" requires an active
--     resident_house_assignments row matching transactions.house_id - a
--     NULL house_id can never satisfy that EXISTS clause, so residents are
--     already blocked from inserting expense-type rows purely by this
--     existing policy, with no policy change required.
--   - "Admins can insert transactions for residents" only checks
--     is_society_admin(society_id) - it already permits an Admin to
--     insert a transaction with house_id = NULL for their own society.
-- The Admin-only requirement for expense types is enforced explicitly in
-- the application layer (backend/src/routes/transactions.js) for a clean
-- 403 message, with RLS as the real enforcement boundary underneath it,
-- matching every other admin-only action in this codebase.
