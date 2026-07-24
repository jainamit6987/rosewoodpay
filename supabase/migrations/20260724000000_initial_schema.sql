-- Create the 'public' schema if it doesn't exist (Supabase usually handles this)
CREATE SCHEMA IF NOT EXISTS public;

-- Set search path for convenience
SET search_path TO public, auth;

--
-- Table: societies
--
CREATE TABLE societies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(150) NOT NULL,
    upi_vpa VARCHAR(100) NOT NULL,
    upi_payee_name VARCHAR(150) NOT NULL,
    timezone VARCHAR(50) NOT NULL DEFAULT 'Asia/Kolkata',
    status VARCHAR(20) NOT NULL DEFAULT 'Active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_societies_status CHECK (status IN ('Active', 'Inactive'))
);

COMMENT ON TABLE societies IS 'Stores each housing society and its payment configuration.';

--
-- Table: society_members
--
CREATE TABLE society_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    auth_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL,
    is_committee_member BOOLEAN NOT NULL DEFAULT false,
    status VARCHAR(20) NOT NULL DEFAULT 'Invited',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_society_member UNIQUE (society_id, auth_user_id),
    CONSTRAINT chk_member_role CHECK (role IN ('Resident', 'Admin')),
    CONSTRAINT chk_member_status CHECK (status IN ('Invited', 'Active', 'Suspended'))
);

COMMENT ON TABLE society_members IS 'Associates authenticated users with a society and role.';

--
-- Table: houses
--
CREATE TABLE houses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    house_number VARCHAR(20) NOT NULL,
    type VARCHAR(20) NOT NULL,
    owner_name VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'Active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_house_in_society UNIQUE (society_id, house_number),
    CONSTRAINT chk_house_type CHECK (type IN ('Rowhouse', 'Flat')),
    CONSTRAINT chk_house_status CHECK (status IN ('Active', 'Inactive'))
);

COMMENT ON TABLE houses IS 'Stores the homes (flats, rowhouses) that can be billed.';

--
-- Table: resident_house_assignments
--
CREATE TABLE resident_house_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_member_id UUID NOT NULL REFERENCES society_members(id) ON DELETE CASCADE,
    house_id UUID NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'Pending',
    approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL, -- Admin who approved
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_assignment_status CHECK (status IN ('Pending', 'Active', 'Revoked'))
);
COMMENT ON TABLE resident_house_assignments IS 'Links a resident to an approved house and preserves assignment history.';

--
-- Table: billing_periods
--
CREATE TABLE billing_periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    house_id UUID NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
    period_month DATE NOT NULL, -- First day of the billing month
    base_amount NUMERIC(10, 2) NOT NULL,
    late_fee NUMERIC(10, 2) NOT NULL DEFAULT 0,
    previous_balance NUMERIC(10, 2) NOT NULL DEFAULT 0,
    adjustment NUMERIC(10, 2) NOT NULL DEFAULT 0,
    amount_due NUMERIC(10, 2) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'Open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_billing_period_for_house UNIQUE (house_id, period_month),
    CONSTRAINT chk_billing_amount_positive CHECK (base_amount >= 0 AND late_fee >= 0 AND amount_due >= 0),
    CONSTRAINT chk_billing_status CHECK (status IN ('Open', 'Closed', 'Waived'))
);

COMMENT ON TABLE billing_periods IS 'Defines the charge for a flat for a specific month.';

--
-- Table: transactions
--
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    house_id UUID NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
    billing_period_id UUID REFERENCES billing_periods(id) ON DELETE SET NULL,
    submitted_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    raw_shared_payload TEXT,
    proof_file_path TEXT, -- Private storage path, not a public URL
    amount NUMERIC(10, 2),
    utr_number VARCHAR(32),
    txn_date TIMESTAMPTZ,
    payment_status VARCHAR(30),
    extraction_confidence NUMERIC(5, 4),
    processing_status VARCHAR(30) NOT NULL DEFAULT 'Submitted',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,
    locked_until TIMESTAMPTZ,
    last_error TEXT,
    manual_review_reason TEXT,
    verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_transaction_amount_positive CHECK (amount >= 0),
    CONSTRAINT chk_extraction_confidence_range CHECK (extraction_confidence >= 0 AND extraction_confidence <= 1),
    CONSTRAINT chk_payment_status CHECK (payment_status IN ('Success', 'Failed', 'Pending')),
    CONSTRAINT chk_processing_status CHECK (processing_status IN ('Submitted', 'Queued', 'Processing', 'Extracted', 'Pending_Verification', 'Manual_Review', 'Verified', 'Rejected', 'Failed'))
);

COMMENT ON TABLE transactions IS 'Stores payment submissions, extraction results, verification, and ledger state.';

-- Indexes for transactions table
CREATE INDEX idx_transactions_processing_status_next_attempt_at ON transactions (processing_status, next_attempt_at);
CREATE INDEX idx_transactions_society_house_billing ON transactions (society_id, house_id, billing_period_id);

-- Create a partial unique index to enforce uniqueness on non-null utr_number per society.
-- This prevents duplicate payment submissions for the same UTR within a society.
CREATE UNIQUE INDEX unique_utr_per_society_when_not_null
ON transactions (society_id, utr_number) WHERE (utr_number IS NOT NULL);

--
-- Table: audit_events
--
CREATE TABLE audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID NOT NULL,
    action VARCHAR(50) NOT NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE audit_events IS 'Records sensitive administrative and verification actions.';

--
-- Row Level Security (RLS) Policies
--

-- Enable RLS on all tables
ALTER TABLE societies ENABLE ROW LEVEL SECURITY;
ALTER TABLE society_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE houses ENABLE ROW LEVEL SECURITY;
ALTER TABLE resident_house_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

-- Policies for 'societies'
-- Admins/Committee can see all societies they are members of
CREATE POLICY "Admins and Committee can view societies" ON societies
FOR SELECT USING (
    EXISTS (SELECT 1 FROM society_members WHERE society_id = societies.id AND auth_user_id = auth.uid() AND (role = 'Admin' OR is_committee_member = true))
);
-- Residents can view societies they are members of
CREATE POLICY "Residents can view their society" ON societies
FOR SELECT USING (
    EXISTS (SELECT 1 FROM society_members WHERE society_id = societies.id AND auth_user_id = auth.uid() AND role = 'Resident')
);
-- Admins can update their society's details
CREATE POLICY "Admins can update their society" ON societies
FOR UPDATE USING (
    EXISTS (SELECT 1 FROM society_members WHERE society_id = societies.id AND auth_user_id = auth.uid() AND role = 'Admin')
) WITH CHECK (
    EXISTS (SELECT 1 FROM society_members WHERE society_id = societies.id AND auth_user_id = auth.uid() AND role = 'Admin')
);


-- Policies for 'society_members'
-- Users can view their own society_member record
CREATE POLICY "Users can view their own society_member record" ON society_members
FOR SELECT USING (auth_user_id = auth.uid());
-- Admins/Committee can view all members in their society
CREATE POLICY "Admins and Committee can view all society members" ON society_members
FOR SELECT USING (
    EXISTS (SELECT 1 FROM society_members sm_admin WHERE sm_admin.society_id = society_members.society_id AND sm_admin.auth_user_id = auth.uid() AND (sm_admin.role = 'Admin' OR sm_admin.is_committee_member = true))
);
-- Admins can manage society members
CREATE POLICY "Admins can manage society members" ON society_members
FOR ALL USING (
    EXISTS (SELECT 1 FROM society_members sm_admin WHERE sm_admin.society_id = society_members.society_id AND sm_admin.auth_user_id = auth.uid() AND sm_admin.role = 'Admin')
) WITH CHECK (
    EXISTS (SELECT 1 FROM society_members sm_admin WHERE sm_admin.society_id = society_members.society_id AND sm_admin.auth_user_id = auth.uid() AND sm_admin.role = 'Admin')
);

-- Policies for 'houses'
-- Residents can view houses in their society
CREATE POLICY "Residents can view houses in their society" ON houses
FOR SELECT USING (
    EXISTS (SELECT 1 FROM society_members WHERE society_id = houses.society_id AND auth_user_id = auth.uid())
);
-- Admins/Committee can view houses in their society
CREATE POLICY "Admins and Committee can view houses" ON houses
FOR SELECT USING (
    EXISTS (SELECT 1 FROM society_members WHERE society_id = houses.society_id AND auth_user_id = auth.uid() AND (role = 'Admin' OR is_committee_member = true))
);
-- Admins can manage houses in their society
CREATE POLICY "Admins can manage houses" ON houses
FOR ALL USING (
    EXISTS (SELECT 1 FROM society_members WHERE society_id = houses.society_id AND auth_user_id = auth.uid() AND role = 'Admin')
) WITH CHECK (
    EXISTS (SELECT 1 FROM society_members WHERE society_id = houses.society_id AND auth_user_id = auth.uid() AND role = 'Admin')
);

-- Policies for 'resident_house_assignments'
-- Residents can view their own active assignments
CREATE POLICY "Residents can view their own active assignments" ON resident_house_assignments
FOR SELECT USING (
    EXISTS (SELECT 1 FROM society_members WHERE id = resident_house_assignments.society_member_id AND auth_user_id = auth.uid())
);
-- Admins/Committee can view assignments in their society
CREATE POLICY "Admins and Committee can view house assignments" ON resident_house_assignments
FOR SELECT USING (
    EXISTS (SELECT 1 FROM society_members sm_admin WHERE sm_admin.society_id = (SELECT society_id FROM houses WHERE id = resident_house_assignments.house_id) AND sm_admin.auth_user_id = auth.uid() AND (sm_admin.role = 'Admin' OR sm_admin.is_committee_member = true))
);
-- Admins can manage assignments in their society
CREATE POLICY "Admins can manage house assignments" ON resident_house_assignments
FOR ALL USING (
    EXISTS (SELECT 1 FROM society_members sm_admin WHERE sm_admin.society_id = (SELECT society_id FROM houses WHERE id = resident_house_assignments.house_id) AND sm_admin.auth_user_id = auth.uid() AND sm_admin.role = 'Admin')
) WITH CHECK (
    EXISTS (SELECT 1 FROM society_members sm_admin WHERE sm_admin.society_id = (SELECT society_id FROM houses WHERE id = resident_house_assignments.house_id) AND sm_admin.auth_user_id = auth.uid() AND sm_admin.role = 'Admin')
);

-- Policies for 'billing_periods'
-- Residents can view billing periods for their assigned houses
CREATE POLICY "Residents can view billing periods for their assigned flats" ON billing_periods
FOR SELECT USING (
    EXISTS (
        SELECT 1 FROM resident_house_assignments rha
        JOIN society_members sm ON rha.society_member_id = sm.id
        WHERE rha.house_id = billing_periods.house_id
        AND sm.auth_user_id = auth.uid()
        AND rha.status = 'Active'
    )
);
-- Admins/Committee can view billing periods in their society
CREATE POLICY "Admins and Committee can view billing periods" ON billing_periods
FOR SELECT USING (
    EXISTS (SELECT 1 FROM society_members WHERE society_id = billing_periods.society_id AND auth_user_id = auth.uid() AND (role = 'Admin' OR is_committee_member = true))
);
-- Admins can manage billing periods in their society
CREATE POLICY "Admins can manage billing periods" ON billing_periods
FOR ALL USING (
    EXISTS (SELECT 1 FROM society_members WHERE society_id = billing_periods.society_id AND auth_user_id = auth.uid() AND role = 'Admin')
) WITH CHECK (
    EXISTS (SELECT 1 FROM society_members WHERE society_id = billing_periods.society_id AND auth_user_id = auth.uid() AND role = 'Admin')
);

-- Policies for 'transactions'
-- Residents can insert transactions for their approved houses and open billing periods
CREATE POLICY "Residents can insert their own transactions" ON transactions
FOR INSERT WITH CHECK (
    submitted_by = auth.uid()
    AND EXISTS (
        SELECT 1 FROM resident_house_assignments rha
        JOIN society_members sm ON rha.society_member_id = sm.id
        WHERE rha.house_id = transactions.house_id
        AND sm.auth_user_id = auth.uid()
        AND rha.status = 'Active'
    )
    AND EXISTS (
        SELECT 1 FROM billing_periods bp
        WHERE bp.id = transactions.billing_period_id
        AND bp.house_id = transactions.house_id
        AND bp.status = 'Open'
    )
);
-- Admins can insert transactions on behalf of residents (e.g., cash payments)
CREATE POLICY "Admins can insert transactions for residents" ON transactions
FOR INSERT WITH CHECK (
    EXISTS (
        SELECT 1 FROM society_members sm_admin
        WHERE sm_admin.society_id = transactions.society_id
        AND sm_admin.auth_user_id = auth.uid()
        AND sm_admin.role = 'Admin'
    )
    AND EXISTS (
        SELECT 1 FROM billing_periods bp
        WHERE bp.id = transactions.billing_period_id
        AND bp.house_id = transactions.house_id
        AND bp.status = 'Open'
    )
);
-- Residents can view their own transactions
CREATE POLICY "Residents can view their own transactions" ON transactions
FOR SELECT USING (submitted_by = auth.uid());
-- Admins/Committee can view all transactions in their society
CREATE POLICY "Admins and Committee can view all society transactions" ON transactions
FOR SELECT USING (
    EXISTS (SELECT 1 FROM society_members WHERE society_id = transactions.society_id AND auth_user_id = auth.uid() AND (role = 'Admin' OR is_committee_member = true))
);
-- Admins can update transactions in their society (e.g., verification)
CREATE POLICY "Admins can update society transactions" ON transactions
FOR UPDATE USING (
    EXISTS (SELECT 1 FROM society_members WHERE society_id = transactions.society_id AND auth_user_id = auth.uid() AND role = 'Admin')
) WITH CHECK (
    EXISTS (SELECT 1 FROM society_members WHERE society_id = transactions.society_id AND auth_user_id = auth.uid() AND role = 'Admin')
);

-- Policies for 'audit_events'
-- Only Admins/Committee can read audit events in their society
CREATE POLICY "Admins and Committee can view audit events" ON audit_events
FOR SELECT USING (
    EXISTS (SELECT 1 FROM society_members WHERE society_id = audit_events.society_id AND auth_user_id = auth.uid() AND (role = 'Admin' OR is_committee_member = true))
);