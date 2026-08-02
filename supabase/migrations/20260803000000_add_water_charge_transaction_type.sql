-- Adds a new "WaterCharge" transaction_type: the society charging a
-- resident's house extra for above-and-beyond water usage, paid by the
-- resident themselves (UPI, reviewed the same as Maintenance) or recorded
-- by an Admin in Cash on the house's behalf.
--
-- Deliberately modeled as "pay-as-you-go", not pre-billed: discussed and
-- confirmed with the user, there is no admin-created "water charge due"
-- row analogous to billing_periods here - the amount is whatever was
-- actually used, decided at payment time, with no outstanding balance
-- tracked beforehand. It is otherwise treated like Maintenance in every
-- way that matters for the CHECK constraints below (house-linked, no
-- payee_name/description required) - the one place it genuinely diverges
-- is application-layer, not schema-layer: routes/transactions.js skips
-- the Maintenance-only FIFO billing_periods allocation loop and the
-- base-amount-multiple rule for this type, inserting it with zero
-- transaction_allocations rows instead.
ALTER TABLE transactions DROP CONSTRAINT chk_transaction_type;

ALTER TABLE transactions ADD CONSTRAINT chk_transaction_type
CHECK (transaction_type IN ('Maintenance', 'WaterCharge', 'UtilityBill', 'Salary', 'Other'));

ALTER TABLE transactions DROP CONSTRAINT chk_house_id_required_for_maintenance_only;

ALTER TABLE transactions ADD CONSTRAINT chk_house_id_required_for_house_linked_types CHECK (
    (transaction_type IN ('Maintenance', 'WaterCharge') AND house_id IS NOT NULL)
    OR (transaction_type NOT IN ('Maintenance', 'WaterCharge') AND house_id IS NULL)
);

ALTER TABLE transactions DROP CONSTRAINT chk_payee_name_required_for_expenses;

ALTER TABLE transactions ADD CONSTRAINT chk_payee_name_required_for_expenses CHECK (
    (transaction_type IN ('Maintenance', 'WaterCharge'))
    OR (payee_name IS NOT NULL AND length(btrim(payee_name)) > 0)
);

ALTER TABLE transactions DROP CONSTRAINT chk_description_required_for_expenses;

ALTER TABLE transactions ADD CONSTRAINT chk_description_required_for_expenses CHECK (
    (transaction_type IN ('Maintenance', 'WaterCharge'))
    OR (description IS NOT NULL AND length(btrim(description)) > 0)
);

-- No RLS policy changes needed - both existing INSERT policies ("Residents
-- can insert their own transactions", "Admins can insert transactions for
-- residents", see 20260727000000_enforce_suspended_status_in_rls.sql) key
-- off resident_house_assignments/is_society_admin generically, never
-- transaction_type, so WaterCharge rows (house_id NOT NULL, same as
-- Maintenance) are already covered exactly like Maintenance rows are.
