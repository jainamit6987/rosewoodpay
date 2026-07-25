-- audit_events had a SELECT policy for Admins/Committee from the initial
-- schema, but no INSERT policy at all - meaning no one, including an Admin,
-- could actually write an audit row via their own RLS-scoped client (RLS
-- defaults to deny with no matching policy). The transaction verify/reject
-- endpoint needs to write one as a side effect of an Admin action, so this
-- adds the missing INSERT policy rather than reaching for the service-role
-- client - the caller is already a confirmed Admin of the society by the
-- time this fires, so there is no reason to bypass RLS here.
CREATE POLICY "Admins can insert audit events for their society" ON audit_events
FOR INSERT WITH CHECK (
    EXISTS (
        SELECT 1 FROM society_members
        WHERE society_id = audit_events.society_id
        AND auth_user_id = auth.uid()
        AND role = 'Admin'
    )
);
