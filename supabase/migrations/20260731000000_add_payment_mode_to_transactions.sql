-- Adds a real payment_mode column to transactions, distinguishing how a
-- payment was actually made. Every payment recorded until now was
-- implicitly UPI (a resident paying via their own UPI app, then
-- self-reporting the UTR) - this column makes that explicit as the
-- default, rather than assuming every future row is the same, now that a
-- second mode (Cash) is being added.
--
-- Cash is for one specific, narrower case: an Admin/Committee member
-- physically received cash from a resident and is recording it on that
-- resident's behalf. It is not a resident-facing option - see
-- backend/src/routes/transactions.js's POST / handler for the matching
-- app-layer rules enforced on top of this column: Cash payments require
-- no utr_number/raw_shared_payload/proof_file_path (there is no UTR for
-- cash, and the Admin's own submission is itself the attestation, the same
-- reasoning already used for society expenses), are restricted to
-- Maintenance-type payments submitted by an Admin, and are auto-Verified
-- immediately rather than sitting Submitted awaiting a separate review.
ALTER TABLE transactions
    ADD COLUMN payment_mode VARCHAR(10) NOT NULL DEFAULT 'UPI';

ALTER TABLE transactions
    ADD CONSTRAINT chk_payment_mode CHECK (payment_mode IN ('UPI', 'Cash'));

COMMENT ON COLUMN transactions.payment_mode IS 'How this payment was made: UPI (resident self-service, the default/only mode before this column existed) or Cash (Admin-recorded on the payer''s behalf, auto-Verified immediately - see routes/transactions.js).';
