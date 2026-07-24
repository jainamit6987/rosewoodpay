-- Fix "infinite recursion detected in policy for relation society_members".
--
-- The original policies on society_members determined admin/committee
-- status by querying society_members itself inside their USING clause.
-- Evaluating that subquery re-applies RLS on society_members, which
-- re-evaluates the same policy, forever. This affects every query that
-- touches society_members, including from other tables' policies that
-- check role via a society_members subquery.
--
-- Fix: move the admin/committee lookup into SECURITY DEFINER functions.
-- These run as the function owner (the migration role, which owns the
-- table and therefore bypasses RLS on it), so the internal lookup never
-- re-triggers the calling policy.

CREATE OR REPLACE FUNCTION public.is_society_admin(target_society_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM society_members
    WHERE society_id = target_society_id
      AND auth_user_id = auth.uid()
      AND role = 'Admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_society_admin_or_committee(target_society_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM society_members
    WHERE society_id = target_society_id
      AND auth_user_id = auth.uid()
      AND (role = 'Admin' OR is_committee_member = true)
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_society_admin(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_society_admin_or_committee(UUID) TO authenticated;

-- Replace the two self-referencing policies on society_members.
DROP POLICY IF EXISTS "Admins and Committee can view all society members" ON society_members;
CREATE POLICY "Admins and Committee can view all society members" ON society_members
FOR SELECT USING (
    public.is_society_admin_or_committee(society_id)
);

DROP POLICY IF EXISTS "Admins can manage society members" ON society_members;
CREATE POLICY "Admins can manage society members" ON society_members
FOR ALL USING (
    public.is_society_admin(society_id)
) WITH CHECK (
    public.is_society_admin(society_id)
);
