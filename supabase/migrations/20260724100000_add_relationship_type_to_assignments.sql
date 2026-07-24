-- Support residents who own multiple houses and may rent some out to other
-- residents, while an owner who occupies their own house remains a single row.
--
-- Multiple houses per resident were already possible: resident_house_assignments
-- had no constraint tying a society_member to a single house. The gaps this
-- migration closes are:
--   1. No way to distinguish an owner assignment from a tenant/occupant assignment.
--   2. No safeguard against duplicate active rows for the same person + house.
--
-- After this migration, a single house can have two concurrent 'Active'
-- assignments: one 'Owner' (for liability/notification/history) and one
-- 'Tenant' or 'Occupant' (the person actually billed and paying maintenance).

ALTER TABLE resident_house_assignments
    ADD COLUMN relationship_type VARCHAR(20) NOT NULL DEFAULT 'Owner';

ALTER TABLE resident_house_assignments
    ADD CONSTRAINT chk_assignment_relationship_type
    CHECK (relationship_type IN ('Owner', 'Tenant', 'Occupant'));

COMMENT ON COLUMN resident_house_assignments.relationship_type IS
    'Owner: holds title to the house. Tenant: rents the house from the owner. Occupant: lives there without a formal tenancy (e.g. family member).';

-- Prevent the same resident from being linked to the same house by more than
-- one simultaneous active assignment, without blocking:
--   - one resident holding active assignments to several different houses
--   - one house having active assignments to several different residents
--     (e.g. an Owner row and a Tenant row on the same house)
CREATE UNIQUE INDEX unique_active_assignment_per_member_house
ON resident_house_assignments (society_member_id, house_id)
WHERE (status = 'Active');
