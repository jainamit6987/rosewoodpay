-- Fixes "infinite recursion detected in policy for relation 'houses'",
-- hit live while testing PATCH /houses/:houseId/available-to-rent.
--
-- 20260805000000_add_available_to_rent_to_houses.sql's own Owner-update
-- policy on 'houses' ran an inline EXISTS against
-- resident_house_assignments/society_members. But
-- resident_house_assignments' own SELECT policies (see
-- 20260726000000_replace_role_with_boolean_flags.sql) look BACK UP at
-- houses to find its society_id
-- (`is_society_admin_or_committee((SELECT society_id FROM houses WHERE
-- id = resident_house_assignments.house_id))`) - a genuine cycle:
-- evaluating the houses policy requires reading
-- resident_house_assignments, which requires re-evaluating the houses
-- policy to resolve society_id, forever.
--
-- This exact class of problem already happened once before in this
-- schema (society_members' own self-referencing policies - see
-- 20260724120000_fix_society_members_rls_recursion.sql) and was fixed
-- the same way there: move the check into a SECURITY DEFINER function.
-- A SECURITY DEFINER function runs with its owner's privileges, which
-- bypasses RLS on the tables it queries internally - so
-- is_active_owner_of_house's own read of resident_house_assignments/
-- society_members below never re-triggers either table's policies,
-- breaking the cycle instead of just hiding it.
CREATE OR REPLACE FUNCTION public.is_active_owner_of_house(target_house_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM resident_house_assignments rha
    JOIN society_members sm ON sm.id = rha.society_member_id
    WHERE rha.house_id = target_house_id
      AND rha.relationship_type = 'Owner'
      AND rha.status = 'Active'
      AND sm.auth_user_id = auth.uid()
      AND sm.status = 'Active'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_active_owner_of_house(UUID) TO authenticated;

DROP POLICY IF EXISTS "Owners can update their own house's available_to_rent" ON houses;
CREATE POLICY "Owners can update their own house's available_to_rent" ON houses
FOR UPDATE USING (
    public.is_active_owner_of_house(houses.id)
) WITH CHECK (
    public.is_active_owner_of_house(houses.id)
);
