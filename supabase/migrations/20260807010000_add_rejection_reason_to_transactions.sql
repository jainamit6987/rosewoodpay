-- Adds a resident-facing rejection reason directly on `transactions`. Up to
-- now, a reject's reason (POST /transactions/:id/reject's required `reason`
-- body field) was only ever written into `audit_events.metadata.reason` -
-- readable exclusively via GET /society/:id/audit-log, which is gated
-- Admin/Committee-only. A resident whose own payment got rejected had no
-- way to ever see WHY, anywhere in the API surface.
--
-- This is for the new Maintenance Receipt feature: a resident's per-period
-- receipt (GET /houses/:houseId/billing-periods/:periodId/receipt) needs to
-- show the rejection reason directly to the resident who submitted it, so
-- it needs to live somewhere their own RLS-scoped read access already
-- reaches - the transaction row itself (same "Residents can view their own
-- transactions" / co-assignee policy every other transaction field already
-- relies on), not the Admin-only audit log.
--
-- Nullable, and never touched for a Verified/Submitted transaction - only
-- POST /transactions/:id/reject ever writes it, at the same moment it
-- writes the identical string into the audit log. Both are kept (not a
-- replacement): the audit log remains the durable, tamper-evident record of
-- every admin action; this column is purely a read-optimized copy for the
-- one resident-facing surface that needs it without an Admin-only join.
ALTER TABLE transactions
ADD COLUMN rejection_reason TEXT;

COMMENT ON COLUMN transactions.rejection_reason IS 'The reason given by the Admin who rejected this transaction (POST /transactions/:id/reject). NULL unless processing_status = ''Rejected''. Resident-readable copy of the same string already recorded in audit_events.metadata.reason for that action.';
