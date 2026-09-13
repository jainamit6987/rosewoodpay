-- Lets a resident update their OWN society_members row's name/phone_number
-- from within the app - previously Admin-only. See
-- 20260725010000_add_phone_number_to_society_members.sql's own comment,
-- which explicitly deferred this: "self-service capture (a resident
-- setting/updating their own number) is deferred to the future onboarding
-- flow; for now this is only writable by an Admin, via the existing
-- 'Admins can manage society members' policy." This migration is that
-- deferred flow, finally being built.
--
-- Email is deliberately NOT covered here - it lives on auth.users, not
-- this table, and changing a login email is a separate, bigger decision
-- (re-verification, interaction with password reset) intentionally left
-- out of this pass. Also out of scope: is_admin, is_committee_member,
-- status, society_id - those stay Admin-only, exactly as PATCH
-- /members/:id (backend/src/routes/members.js) already treats them.
--
-- Two parts, both required together - an RLS policy alone is NOT enough
-- here:
--   1. A new RLS UPDATE policy granting residents write access to their
--      own row at all. There was previously no self-UPDATE policy
--      whatsoever on society_members - only the Admin "FOR ALL" policy
--      (20260724120000_fix_society_members_rls_recursion.sql) could ever
--      write to this table.
--   2. A BEFORE UPDATE trigger enforcing which COLUMNS that new self-access
--      may actually touch. RLS USING/WITH CHECK is inherently row-level,
--      not column-level - by itself it cannot stop a resident from also
--      slipping is_admin/status/society_id into the very same UPDATE. This
--      is a real risk in THIS app specifically, not just theoretical: the
--      PWA ships EXPO_PUBLIC_SUPABASE_URL/ANON_KEY in its own public JS
--      bundle (see PERSONAL_LAPTOP_SETUP_AND_TESTING.md's PWA section), so
--      a technically-inclined resident could call PostgREST directly with
--      their own session token, bypassing backend/src/routes/members.js's
--      field allowlist entirely. The trigger below is the actual
--      enforcement; the RLS policy just decides which ROWS reach it.

-- 1. Allow residents to update their own row. DROP IF EXISTS first - same
-- re-runnable-migration convention as
-- 20260724120000_fix_society_members_rls_recursion.sql and
-- 20260727000000_enforce_suspended_status_in_rls.sql already use
-- throughout this project (CREATE POLICY has no IF NOT EXISTS in
-- Postgres) - safe to paste this whole file into the SQL Editor again
-- even if an earlier version of it (e.g. before the self-demotion/
-- self-suspend hardening below was added) already ran once.
DROP POLICY IF EXISTS "Users can update their own society_member record" ON society_members;
CREATE POLICY "Users can update their own society_member record" ON society_members
FOR UPDATE USING (
    auth_user_id = auth.uid()
) WITH CHECK (
    auth_user_id = auth.uid()
);

-- 2. Column-level guard - fires on EVERY update to this table (including
-- the pre-existing Admin path through PATCH /members/:id), so this is
-- also a defense-in-depth re-check of that path, not just a gate on the
-- new one. An Admin's own PATCH /members/:id already blocks
-- self-demotion in application code (target.auth_user_id === req.user.id
-- && is_admin === false) - this does not change or duplicate that; it
-- only steps in when the row being changed is the CALLER's own AND a
-- privileged column is being touched, requiring the caller to
-- independently qualify as an Active Admin of that row's society (the
-- exact same test requireActiveAdmin() already runs in JS, now also
-- enforced at the database level).
CREATE OR REPLACE FUNCTION public.guard_society_member_privileged_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_admin IS DISTINCT FROM OLD.is_admin
     OR NEW.is_committee_member IS DISTINCT FROM OLD.is_committee_member
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.society_id IS DISTINCT FROM OLD.society_id
     OR NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id
  THEN
    IF NOT EXISTS (
      SELECT 1 FROM society_members
      WHERE auth_user_id = auth.uid()
        AND society_id = OLD.society_id
        AND is_admin = true
        AND status = 'Active'
    ) THEN
      RAISE EXCEPTION 'Only an Active Admin of this society may change role, status, or society_id.';
    END IF;
  END IF;

  -- Mirrors two more guards that were ALSO previously JS-only, found while
  -- auditing this same class of gap (asked directly by the user: "how do
  -- we safeguard against a direct-Supabase-call bypass?"): PATCH
  -- /members/:id's own `target.auth_user_id === req.user.id && is_admin
  -- === false` block, and POST /members/:id/suspend's own
  -- `member.auth_user_id === req.user.id` block. Both only ever existed in
  -- backend/src/routes/members.js - a direct PostgREST call using an
  -- Admin's own valid session previously had no database-level reason to
  -- refuse either. Lower severity than the privilege-escalation case
  -- above (requires already BEING an Admin to exploit - the "damage" is
  -- an Admin locking themselves out, not gaining anything), but the same
  -- "RLS/triggers are the only real boundary, JS checks alone are not"
  -- principle applies, so closed here too rather than left as a known gap.
  IF OLD.auth_user_id = auth.uid() THEN
    IF OLD.is_admin = true AND NEW.is_admin = false THEN
      RAISE EXCEPTION 'You cannot remove your own admin access. Ask another Admin to do this.';
    END IF;
    IF OLD.status = 'Active' AND NEW.status = 'Suspended' THEN
      RAISE EXCEPTION 'You cannot suspend your own account. Ask another Admin to do this.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_society_member_privileged_fields ON society_members;
CREATE TRIGGER trg_guard_society_member_privileged_fields
BEFORE UPDATE ON society_members
FOR EACH ROW
EXECUTE FUNCTION public.guard_society_member_privileged_fields();

-- Not affected by this trigger (verified before writing it): every
-- current UPDATE of society_members' privileged columns
-- (PATCH /members/:id, /suspend, /reactivate, all in
-- backend/src/routes/members.js) runs through req.supabase using the
-- calling Admin's own session - auth.uid() resolves to that Admin, who
-- already passed requireActiveAdmin() in application code before the
-- update statement even runs, so the EXISTS check above always finds
-- their own row and passes. The only society_members writes anywhere in
-- backend/ that use the service-role client (supabaseAdmin) are .insert()
-- (POST /members's own insert instead actually runs through req.supabase,
-- not supabaseAdmin) and .delete() (test-script cleanup only) - neither
-- is UPDATE, so neither fires this trigger at all.
--
-- The self-demotion/self-suspend blocks added above only ever trigger
-- when OLD.auth_user_id = auth.uid() - i.e. an Admin acting on THEIR OWN
-- row. Acting on a DIFFERENT member (the normal, legitimate use of both
-- endpoints) is untouched. Application code already refused to ever
-- attempt either self-targeting update in the first place, so no
-- currently-passing legitimate flow changes behavior here either - this
-- purely closes the direct-API-bypass path.
