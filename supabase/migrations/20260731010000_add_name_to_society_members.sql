-- Adds a real display name to society_members. No such field existed
-- anywhere before this - not on society_members, not captured at account
-- creation - houses.owner_name is a *house-level* fact (who legally owns
-- that house, unaffected by who currently lives there) and was already
-- deliberately kept separate from "the logged-in person's own name" (see
-- ResidentHomeScreen's "Owner's Name" labeling decision). The Members
-- management UI (view/create/suspend members, and the simplified
-- name-plus-role resident cards on the House Dashboard) needs the latter,
-- which this column is.
--
-- Nullable: every existing member predates this column and has no name on
-- file yet - not backfilled here, an Admin fills it in later via
-- PATCH /members/:id. New members created going forward are expected (at
-- the application layer, POST /members) to always supply one; not
-- enforced as NOT NULL at the DB level purely to avoid breaking every
-- pre-existing row the moment this migration runs.
ALTER TABLE society_members
ADD COLUMN name VARCHAR(120);

COMMENT ON COLUMN society_members.name IS 'The member''s own display name (independent of houses.owner_name, which is a house-level fact, not a person one). Nullable for members created before this column existed; required going forward at the application layer (POST /members).';
