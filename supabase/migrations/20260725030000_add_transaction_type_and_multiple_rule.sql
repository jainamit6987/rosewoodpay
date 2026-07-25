-- Adds a transaction_type field so a single transactions table can later
-- also hold non-resident-billing payments the society makes through the
-- same app (utility bills, labour salaries), not just resident maintenance
-- payments. Only 'Maintenance' is actually produced by any code path today;
-- 'UtilityBill', 'Salary', and 'Other' are added now so the column exists
-- and is constrained, ahead of the actual admin-expense feature being built.
--
-- Also documents (in comments only - the actual rule is enforced in
-- backend/src/routes/transactions.js, not the database) the accompanying
-- business rule: a 'Maintenance' transaction's amount must be a whole-number
-- multiple of the house's default_monthly_amount, so residents can pay for
-- one or more full months (including catching up several months of arrears
-- in one lump sum) but never a partial month. Non-'Maintenance' transactions
-- are exempt - a utility bill or salary payment has no monthly "base amount"
-- to be a multiple of.
--
-- Enforced in the application layer rather than a DB CHECK/trigger because
-- the "base amount" it validates against (houses.default_monthly_amount)
-- lives on a different table - a plain CHECK constraint cannot reference
-- another table's column - and POST /transactions is still the only insert
-- path for this table today (same reasoning already applied to the
-- amount-positive-and-has-proof validation, which is also app-layer only).
-- Revisit as a trigger if a second insert path is ever added that should
-- also be bound by this rule.

ALTER TABLE transactions ADD COLUMN transaction_type VARCHAR(20) NOT NULL DEFAULT 'Maintenance';

ALTER TABLE transactions ADD CONSTRAINT chk_transaction_type
CHECK (transaction_type IN ('Maintenance', 'UtilityBill', 'Salary', 'Other'));

COMMENT ON COLUMN transactions.transaction_type IS
'What this payment is for. ''Maintenance'' (default) is a resident''s regular house dues, and is the only value any code path produces today - it is the type the base-amount-multiple rule and the FIFO billing_periods allocation in POST /transactions both assume. ''UtilityBill'', ''Salary'', and ''Other'' are reserved for a future admin-recorded society-expense feature (utility bills, labour salaries) and are not yet wired into any allocation or validation logic beyond being exempt from the base-amount-multiple rule.';

CREATE INDEX idx_transactions_type ON transactions (society_id, transaction_type);
