-- Lets an Owner flag their own house as available to rent - a simple,
-- owner-managed signal ("I want to rent this out"), distinct from
-- resident_house_assignments' relationship_type/status columns, which
-- describe who actually lives there right now, not intent about the
-- future. Deliberately a single boolean with no separate listings/history
-- table - discussed directly with the user, who compared both approaches:
-- the only data ever needed here is "is this house currently available"
-- plus the house's own already-existing house_number/owner_name for
-- display; no rent amount, contact field, or note was asked for, so
-- there is nothing else to store. The resident-facing "browse all
-- available houses" screen is a deliberately separate, later follow-up -
-- this migration only covers the flag itself and an owner's own ability
-- to set it.
ALTER TABLE houses
    ADD COLUMN available_to_rent BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN houses.available_to_rent IS
    'Owner-managed flag: true means the owner has marked this house as available to rent out. Automatically cleared back to false the moment a new Tenant/Occupant assignment actually goes Active for this house (see routes/assignments.js''s autoClearAvailableToRent) - a stale listing is never left dangling once the house is actually rented; the owner can also withdraw it manually at any time before that happens.';

-- The first-ever resident (non-Admin) write policy on 'houses' - until now
-- this table only had Admin-write ("Admins can manage houses") and
-- everyone-read policies. RLS is row-level, not column-level: this
-- technically grants UPDATE on the whole houses row to whoever currently
-- holds an Active Owner assignment on it, the same shape as "Admins can
-- manage houses" already grants full-row access to an Admin. What
-- actually keeps this narrow in practice is the Express layer -
-- PATCH /houses/:houseId/available-to-rent (routes/houses.js) only ever
-- sends { available_to_rent } in its own .update() call, never any other
-- column - matching how every other Admin-only house edit already relies
-- on the same broad-RLS-plus-narrow-app-layer pattern used throughout
-- this codebase.
CREATE POLICY "Owners can update their own house's available_to_rent" ON houses
FOR UPDATE USING (
    EXISTS (
        SELECT 1 FROM resident_house_assignments rha
        JOIN society_members sm ON sm.id = rha.society_member_id
        WHERE rha.house_id = houses.id
          AND rha.relationship_type = 'Owner'
          AND rha.status = 'Active'
          AND sm.auth_user_id = auth.uid()
          AND sm.status = 'Active'
    )
) WITH CHECK (
    EXISTS (
        SELECT 1 FROM resident_house_assignments rha
        JOIN society_members sm ON sm.id = rha.society_member_id
        WHERE rha.house_id = houses.id
          AND rha.relationship_type = 'Owner'
          AND rha.status = 'Active'
          AND sm.auth_user_id = auth.uid()
          AND sm.status = 'Active'
    )
);
