-- Closes two gaps found in a full security audit ahead of production
-- rollout to real residents/real money:
--
-- 1. CRITICAL - "Residents can insert their own transactions" (added in
--    20260724000000_initial_schema.sql, last touched in
--    20260727000000_enforce_suspended_status_in_rls.sql) only ever
--    checked submitted_by + an active house assignment. It never
--    restricted WHICH columns a resident's own insert may set. Since the
--    PWA ships the public anon key in its own JS bundle (same fact
--    already documented in 20260913000000's own header comment), any
--    resident could call PostgREST directly with their own session token
--    and INSERT a transaction with processing_status='Verified',
--    payment_status='Success', an arbitrary utr_number, and no real
--    PaySharp order or Admin review behind it at all - marking their own
--    dues "paid" for free. Every backend safeguard in
--    routes/transactions.js is irrelevant here, since this bypasses
--    Express entirely.
--
-- 2. HIGH - "Owners can update their own house's available_to_rent"
--    (20260805010000_fix_available_to_rent_rls_recursion.sql) grants
--    UPDATE on the WHOLE houses row - that migration's own comment
--    already flags this ("What actually keeps this narrow in practice is
--    the Express layer... PATCH /houses/:houseId/available-to-rent only
--    ever sends { available_to_rent }") but never closed it at the
--    database level. A direct PostgREST call from an Owner's own session
--    could change default_monthly_amount, status, house_number, or
--    owner_name on their own house.
--
-- Both are re-runnable (DROP IF EXISTS / CREATE OR REPLACE throughout),
-- same convention as every other migration in this project.

--
-- 1. Tighten the resident transaction INSERT policy.
--
-- A genuine resident-initiated insert only ever comes from one of two
-- code paths in backend/src/routes/transactions.js, both using the
-- caller's own RLS-scoped client (req.supabase), never supabaseAdmin:
--   a) POST /transactions (manual self-report) - payment_mode is
--      resident-chosen among 'UPI'/'NEFT_IMPS'/'Cheque' (a resident can
--      self-report having paid by bank transfer or cheque too, pending
--      the same Admin review a self-reported UPI UTR gets - confirmed
--      against backend/scripts/test-maintenance-receipt.js's own "second
--      payment submitted" case, which does exactly this with a resident
--      token). No gateway_* columns at all (all NULL), processing_status
--      left at its table default 'Submitted'.
--   b) POST /transactions/upi-intent (backend-initiated PaySharp order) -
--      payment_mode='UPI' (hardcoded - PaySharp intents are UPI-only),
--      payment_gateway='paysharp', a fresh paysharp_order_id,
--      gateway_status always exactly 'PENDING' at insert time (only
--      transactionGateway.js, running as supabaseAdmin/service-role after
--      a real PaySharp confirmation, may ever move it past that).
-- 'Cash' is the one payment_mode that is genuinely Admin-only - the ONLY
-- one with its own explicit admin-membership check in application code
-- (routes/transactions.js's own `resolvedPaymentMode === CASH_MODE`
-- branch) - and goes through a SEPARATE policy entirely ("Admins can
-- insert transactions for residents", is_society_admin(society_id) with
-- no column restrictions, unaffected by this change), so it is
-- deliberately excluded from what a resident's own policy allows below.
-- Residents have no UPDATE policy on this table at all (confirmed while
-- writing this fix), so restricting INSERT alone is a complete fix -
-- there is no follow-up write a resident could ever make to move a row
-- past what they set here.
DROP POLICY IF EXISTS "Residents can insert their own transactions" ON transactions;
CREATE POLICY "Residents can insert their own transactions" ON transactions
FOR INSERT WITH CHECK (
    submitted_by = auth.uid()
    AND payment_mode IN ('UPI', 'NEFT_IMPS', 'Cheque')
    AND processing_status = 'Submitted'
    AND payment_status IS NULL
    AND verified_by IS NULL
    AND verified_at IS NULL
    AND rejection_reason IS NULL
    AND gateway_failure_reason IS NULL
    AND (
        (payment_gateway IS NULL AND paysharp_order_id IS NULL AND gateway_status IS NULL)
        OR
        (payment_gateway = 'paysharp' AND paysharp_order_id IS NOT NULL AND gateway_status = 'PENDING')
    )
    AND EXISTS (
        SELECT 1 FROM resident_house_assignments rha
        JOIN society_members sm ON rha.society_member_id = sm.id
        WHERE rha.house_id = transactions.house_id
        AND sm.auth_user_id = auth.uid()
        AND rha.status = 'Active'
        AND sm.status = 'Active'
    )
);

--
-- 2. Column-guard trigger for the Owner house-update policy - same
-- "RLS decides which rows, a trigger decides which columns" pattern
-- already used for society_members
-- (20260913000000_allow_resident_self_service_profile_update.sql). Fires
-- on every UPDATE to houses, but only actually restricts anything when
-- the caller is an active Owner of that specific house AND is not also a
-- society Admin (an Admin editing any house's full details, including
-- their own if they happen to also be an owner, is unaffected).
CREATE OR REPLACE FUNCTION public.guard_house_owner_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.is_active_owner_of_house(OLD.id) AND NOT public.is_society_admin(OLD.society_id) THEN
    IF NEW.house_number IS DISTINCT FROM OLD.house_number
       OR NEW.type IS DISTINCT FROM OLD.type
       OR NEW.owner_name IS DISTINCT FROM OLD.owner_name
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.default_monthly_amount IS DISTINCT FROM OLD.default_monthly_amount
       OR NEW.society_id IS DISTINCT FROM OLD.society_id
    THEN
      RAISE EXCEPTION 'Owners may only change available_to_rent on their own house. Ask an Admin for any other change.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_house_owner_update ON houses;
CREATE TRIGGER trg_guard_house_owner_update
BEFORE UPDATE ON houses
FOR EACH ROW
EXECUTE FUNCTION public.guard_house_owner_update();

-- Not affected by either change above (verified before writing this):
--   - Admin house edits (whatever route/columns those use today) call
--     is_society_admin(society_id), which is TRUE for them, so the
--     trigger's guard condition never applies to an Admin's own updates.
--   - PATCH /houses/:houseId/available-to-rent (routes/houses.js) only
--     ever sends { available_to_rent } - identical to OLD on every other
--     column - so the trigger's IS DISTINCT FROM checks all evaluate
--     false for that route's own real traffic and it keeps working
--     exactly as before.
--   - Both resident transaction-insert code paths in
--     routes/transactions.js (manual UPI and PaySharp intent) were
--     re-read while writing this migration and insert exactly the column
--     shapes the new WITH CHECK above allows - no application code change
--     needed alongside this migration.
