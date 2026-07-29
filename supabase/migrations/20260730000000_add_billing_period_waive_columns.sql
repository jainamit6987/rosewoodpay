-- Adds real columns to record a Waived billing period's reason/actor/time,
-- rather than leaving that information only in audit_events.
--
-- 'Waived' has been a valid billing_periods.status value since the initial
-- schema (chk_billing_status), and "Admins can manage billing periods" (FOR
-- ALL) already permits an Admin to set it - but nothing in this codebase
-- has ever actually set a period to Waived, and there was nowhere on the
-- row itself to say why. Every other status-transition action in this
-- codebase (reject, suspend, revoke) records its reason/actor only in
-- audit_events, but those are all transitions a resident/admin only ever
-- needs to look up occasionally, in a log. A Waived billing period is
-- different: it is meant to be visible every time that month is displayed
-- (e.g. on the billing-history screen already built) - "why does this
-- month show ₹0 due" needs to be answerable without a separate
-- audit_events join every time.

ALTER TABLE billing_periods
    ADD COLUMN waived_reason TEXT,
    ADD COLUMN waived_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    ADD COLUMN waived_at TIMESTAMPTZ;

COMMENT ON COLUMN billing_periods.waived_reason IS 'Why this period''s dues were forgiven. Required, alongside waived_by/waived_at, whenever status = Waived; NULL otherwise.';
COMMENT ON COLUMN billing_periods.waived_by IS 'The Admin who waived this period. Required, alongside waived_reason/waived_at, whenever status = Waived; NULL otherwise.';
COMMENT ON COLUMN billing_periods.waived_at IS 'When this period was waived. Required, alongside waived_reason/waived_by, whenever status = Waived; NULL otherwise.';

-- Enforced as a real DB constraint, not just an app-layer convention -
-- these three columns and status = 'Waived' must always agree, in both
-- directions: a Waived row can never be missing its reason/actor/time, and
-- an Open/Closed row can never carry stale ones left over from some other
-- transition.
ALTER TABLE billing_periods ADD CONSTRAINT chk_waived_fields_consistent CHECK (
    (status = 'Waived' AND waived_reason IS NOT NULL AND waived_by IS NOT NULL AND waived_at IS NOT NULL)
    OR
    (status != 'Waived' AND waived_reason IS NULL AND waived_by IS NULL AND waived_at IS NULL)
);
