-- Adds a contact phone number to society_members, ahead of any feature that
-- needs it (visitor management gate calls, complaint follow-up, etc.).
-- Nullable and unvalidated in format beyond a loose length/character check -
-- self-service capture (a resident setting/updating their own number) is
-- deferred to the future onboarding flow; for now this is only writable by
-- an Admin, via the existing "Admins can manage society members" policy.
ALTER TABLE society_members
ADD COLUMN phone_number VARCHAR(20);

ALTER TABLE society_members
ADD CONSTRAINT chk_phone_number_format
CHECK (phone_number IS NULL OR phone_number ~ '^[0-9+\-\s()]{7,20}$');

COMMENT ON COLUMN society_members.phone_number IS 'Contact number for the resident/admin, independent of their login email. Optional.';
