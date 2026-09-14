-- New business rule (2026-09-14, requested directly by the user): a
-- house may have at most ONE Active Tenant at any point in time - before
-- adding a new Tenant, the Admin must first remove (revoke) the existing
-- one. Owner is deliberately NOT touched by this migration - co-owners
-- remain explicitly allowed, exactly as before (see hasOtherActiveOwner's
-- own comment in backend/src/routes/assignments.js and the "schema allows
-- co-owners" note in backend/src/routes/houses.js's GET
-- /:houseId/profile). Occupant is also untouched - any number of Active
-- Occupants on one house remains allowed (e.g. multiple family members
-- living in).
--
-- Enforced primarily in application code
-- (backend/src/routes/assignments.js's hasActiveTenantOnHouse, checked on
-- create/approve/reassign) - this partial unique index is the
-- belt-and-suspenders DB-level backstop against a race between two
-- concurrent requests, same reasoning as unique_active_assignment_per_
-- member_house in 20260724100000_add_relationship_type_to_assignments.sql.
--
-- If this migration fails to apply, live data already has a house with
-- 2+ simultaneous Active Tenants - run this first to find the offending
-- house(s) and revoke down to one before retrying:
--   SELECT house_id, count(*)
--   FROM resident_house_assignments
--   WHERE status = 'Active' AND relationship_type = 'Tenant'
--   GROUP BY house_id
--   HAVING count(*) > 1;
CREATE UNIQUE INDEX unique_active_tenant_per_house
ON resident_house_assignments (house_id)
WHERE (status = 'Active' AND relationship_type = 'Tenant');
