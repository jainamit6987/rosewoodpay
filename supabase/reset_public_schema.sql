-- Manual full reset for the hosted Supabase project, run via the Studio
-- SQL Editor. Drops only the app's own tables/functions (never the public
-- schema itself), so Supabase's default grants stay intact - no GRANT/
-- ALTER DEFAULT PRIVILEGES restoration needed afterward. Also removes the
-- seeded test auth users so seed.sql can re-insert them with the same
-- fixed UUIDs without a duplicate-key error.
--
-- After running this file, re-apply everything from scratch, in order:
--   1. supabase/migrations/20260724000000_initial_schema.sql
--   2. supabase/migrations/20260724100000_add_relationship_type_to_assignments.sql
--   3. supabase/migrations/20260724120000_fix_society_members_rls_recursion.sql
--   4. supabase/migrations/20260725000000_widen_transaction_visibility_to_coassignees.sql
--   5. supabase/migrations/20260725010000_add_phone_number_to_society_members.sql
--   6. supabase/migrations/20260725020000_add_transaction_allocations_and_default_rate.sql
--   7. supabase/migrations/20260725030000_add_transaction_type_and_multiple_rule.sql
--   8. supabase/migrations/20260725040000_add_audit_events_admin_insert_policy.sql
--   9. supabase/migrations/20260726000000_replace_role_with_boolean_flags.sql
--   10. supabase/seed.sql

-- 1. Drop tables, children before parents (mirrors the FK graph across all
--    migrations to date). IF EXISTS makes this safe to re-run.
DROP TABLE IF EXISTS transaction_allocations;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS billing_periods;
DROP TABLE IF EXISTS resident_house_assignments;
DROP TABLE IF EXISTS houses;
DROP TABLE IF EXISTS society_members;
DROP TABLE IF EXISTS societies;

-- 2. Drop the SECURITY DEFINER helper functions added in
--    20260724120000_fix_society_members_rls_recursion.sql. Safe now that
--    the policies referencing them are already gone with their tables.
DROP FUNCTION IF EXISTS public.is_society_admin(UUID);
DROP FUNCTION IF EXISTS public.is_society_admin_or_committee(UUID);

-- 3. Remove the seeded test users (data only, lives in the auth schema -
--    untouched structurally by any of this project's migrations).
--    auth.identities rows cascade-delete automatically via their FK to
--    auth.users(id) ON DELETE CASCADE.
DELETE FROM auth.users WHERE email LIKE '%@society.app';
