-- Extends the society-expense feature added in
-- 20260726010000_society_expenses_house_optional.sql for a new Admin
-- "Record Expense" mobile screen (salary, security agency, utility bills,
-- other misc society-level payments made FROM the society's own account -
-- there is no confirmed UPI-collect setup for the society account itself
-- yet, so this is bookkeeping only, not a real payment gateway).
--
-- Two changes:
--
-- 1. payment_mode gains two more values: NEFT_IMPS and Cheque, alongside
--    the existing UPI/Cash added in 20260731000000_add_payment_mode_to_
--    transactions.sql. That migration's own Cash rules were written when
--    Cash only ever meant "Admin recorded a resident's in-person cash
--    payment against dues" - discussed and confirmed with the user, Cash
--    is now also a valid way for the society itself to pay someone (e.g.
--    a small cash payment to a vendor), so the app-layer
--    "Cash is Maintenance-only" restriction is being lifted in the same
--    change that adds this migration (see routes/transactions.js) - this
--    CHECK constraint only ever governed the *value*, not which
--    transaction_type it could pair with, so no change is needed here for
--    that half.
--
-- 2. A new description column captures free text on what the payment was
--    for (e.g. "July security guard salary", "Diwali decoration
--    contractor") - distinct from payee_name (who was paid) and from
--    raw_shared_payload (reserved for pasted UPI SMS/screenshot text meant
--    for OCR extraction on the Maintenance side, not a manually-typed
--    note). Required for non-Maintenance transactions, mirroring
--    chk_payee_name_required_for_expenses exactly - optional and unused
--    for Maintenance today, but left generically available on the column
--    rather than expense-only, in case a future Maintenance flow wants to
--    attach a note too.
ALTER TABLE transactions DROP CONSTRAINT chk_payment_mode;

ALTER TABLE transactions ADD CONSTRAINT chk_payment_mode CHECK (payment_mode IN ('UPI', 'Cash', 'NEFT_IMPS', 'Cheque'));

COMMENT ON COLUMN transactions.payment_mode IS 'How this payment was made: UPI / Cash / NEFT_IMPS / Cheque. Cash and the wire-transfer-ish modes (NEFT_IMPS, Cheque) can be Admin-recorded for either a resident''s Maintenance payment or a society-level expense - see routes/transactions.js.';

ALTER TABLE transactions ADD COLUMN description TEXT;

ALTER TABLE transactions ADD CONSTRAINT chk_description_required_for_expenses CHECK (
    (transaction_type = 'Maintenance')
    OR (description IS NOT NULL AND length(btrim(description)) > 0)
);

COMMENT ON COLUMN transactions.description IS 'Free-text note on what this payment was for (e.g. "July security guard salary") - required for UtilityBill/Salary/Other transactions, always optional for Maintenance. Distinct from payee_name (who was paid) and raw_shared_payload (reserved for pasted UPI SMS/screenshot text on Maintenance payments).';
