-- Explicit Data API role grants (2026-10-18, production-rollout prep).
--
-- Every migration up to this point relied entirely on Supabase's own
-- implicit "automatically expose new tables" project default to grant
-- anon/authenticated/service_role their base table-level privileges -
-- confirmed by grepping this whole migrations/ folder: the only existing
-- GRANT statements anywhere (20260724120000, 20260805010000) are for two
-- FUNCTIONs, never a single table. supabase/reset_public_schema.sql says
-- this outright: "Supabase's default grants stay intact - no GRANT/ALTER
-- DEFAULT PRIVILEGES restoration needed afterward."
--
-- That implicit default is being deprecated/removed by Supabase
-- (2026-10-30, per this project's own supabase/config.toml comment on
-- auto_expose_new_tables) and a brand-new project created after that
-- point will no longer auto-grant anything - every table would otherwise
-- be unreachable via the Data API regardless of how correct its RLS
-- policies are (a missing base GRANT means PostgREST never even gets far
-- enough to evaluate RLS - "permission denied for table", not a 403).
--
-- This migration makes those grants explicit and permanent, independent
-- of that toggle, reproducing EXACTLY what the implicit default already
-- did - no behavior change versus every existing environment, just no
-- longer dependent on a setting that's going away. RLS remains the real
-- row-level gate on every table (unchanged, enforced via the policies
-- already in every prior migration) - this only restores the table-level
-- permission layer underneath it, same two-layer model Supabase projects
-- have always used.
--
-- anon is included for parity with Supabase's own default even though
-- neither backend/src nor mobile/src ever actually issues a direct
-- PostgREST table query as anon (confirmed by grep: mobile/src never
-- calls supabase.from(...) at all - see the comment in
-- mobile/src/config/supabaseClient.js, "all actual data access ... goes
-- through the Express backend instead of straight PostgREST" - and the
-- backend's own supabaseAnon client, in config/supabaseClient.js, is used
-- only for auth.signInWithPassword/signOut, never a table query either).
-- Harmless to include - RLS still gates every row regardless of this
-- grant - and keeps this migration a faithful, unsurprising reproduction
-- of the default rather than a hand-tuned subset that could silently
-- diverge from it.
--
-- GRANT ... ON ALL TABLES/SEQUENCES/ROUTINES covers every object that
-- already exists (everything from 20260724000000 through 20261010000000).
-- The three ALTER DEFAULT PRIVILEGES statements cover every object any
-- LATER migration creates too, so this is a one-time fix, not something
-- that needs repeating alongside every future migration.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES TO anon, authenticated, service_role;
