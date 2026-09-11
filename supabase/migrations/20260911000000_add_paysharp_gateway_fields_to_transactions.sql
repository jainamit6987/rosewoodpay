-- Adds PaySharp UPI Intent API gateway fields to `transactions`, per
-- PAYSHARP_UPI_INTENT_INTEGRATION_PLAN.md. These support the new
-- POST /transactions/upi-intent flow (backend-initiated order via
-- PaySharp, confirmed by their webhook or by polling GET /order/{orderId})
-- alongside the existing resident-self-reported-UTR flow, which keeps
-- working completely unchanged - every column added here stays NULL for
-- it, same as it already is for Cash and society-expense rows today.

ALTER TABLE transactions
ADD COLUMN payment_gateway VARCHAR(20),
ADD COLUMN paysharp_order_id VARCHAR(36),
ADD COLUMN paysharp_reference_no VARCHAR(64),
ADD COLUMN gateway_status VARCHAR(20),
ADD COLUMN gateway_failure_reason TEXT;

ALTER TABLE transactions
ADD CONSTRAINT chk_payment_gateway CHECK (payment_gateway IS NULL OR payment_gateway = 'paysharp');

-- payment_gateway and paysharp_order_id must always be set together -
-- never one without the other - so a row can never end up in the
-- ambiguous "has a gateway order id but no gateway name" state (or vice
-- versa).
ALTER TABLE transactions
ADD CONSTRAINT chk_paysharp_order_id_requires_gateway CHECK (
    (payment_gateway IS NULL AND paysharp_order_id IS NULL)
    OR (payment_gateway IS NOT NULL AND paysharp_order_id IS NOT NULL)
);

-- Mirrors PaySharp's own status vocabulary (UPI Order Status API / Webhook
-- docs: PENDING / ON PROGRESS / SUCCESS / FAILED / EXPIRED) rather than
-- reusing processing_status - the two are deliberately not the same enum.
-- A row can sit gateway_status='PENDING' while processing_status=
-- 'Submitted' for a while, exactly like a resident's self-reported UPI
-- submission does today before an Admin acts on it.
ALTER TABLE transactions
ADD CONSTRAINT chk_gateway_status CHECK (
    gateway_status IS NULL OR gateway_status IN ('PENDING', 'ON PROGRESS', 'SUCCESS', 'FAILED', 'EXPIRED')
);

-- Our own generated orderId is what both PaySharp's webhook and our own
-- polling fallback (GET /transactions/:id/status) use to find the right
-- row - must be unique. Partial index since it is NULL for every
-- non-gateway row (Cash, self-reported UPI, society expenses).
CREATE UNIQUE INDEX idx_transactions_paysharp_order_id ON transactions (paysharp_order_id) WHERE paysharp_order_id IS NOT NULL;

COMMENT ON COLUMN transactions.payment_gateway IS 'NULL for every existing row (Cash, self-reported UPI, society expenses). ''paysharp'' for a transaction created via POST /transactions/upi-intent.';
COMMENT ON COLUMN transactions.paysharp_order_id IS 'Our own generated orderId (crypto.randomUUID()), sent to PaySharp as `orderId` on POST /order/intent and echoed back on every webhook/status call. Set only when payment_gateway = ''paysharp''.';
COMMENT ON COLUMN transactions.paysharp_reference_no IS 'PaySharp''s own paysharpReferenceNo, for support/reconciliation only - never used to look up rows (paysharp_order_id is, via idx_transactions_paysharp_order_id).';
COMMENT ON COLUMN transactions.gateway_status IS 'Mirrors PaySharp''s own status vocabulary (PENDING/ON PROGRESS/SUCCESS/FAILED/EXPIRED) - kept separate from processing_status, see this migration''s own header comment for why.';
COMMENT ON COLUMN transactions.gateway_failure_reason IS 'PaySharp''s own failureReason (e.g. "Collect Expired"), so an auto-rejected gateway payment shows the resident why - also copied into the existing rejection_reason column so it surfaces on the same resident-facing receipt/history views a manually-rejected payment already does.';
