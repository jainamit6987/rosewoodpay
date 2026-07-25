const express = require('express');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

// Every query below runs through req.supabase, which carries the caller's
// access token - Row Level Security decides what comes back, this route
// does not add its own authorization checks.
router.get('/', authenticate, async (req, res) => {
  const supabase = req.supabase;

  // RLS also permits admins/committee members to read every membership row
  // in their society (by design, for member-management screens). This
  // endpoint must still filter to the caller's own row(s) explicitly -
  // RLS controls what the database *could* return, not what this specific
  // endpoint *should* return.
  const { data: memberships, error: membershipError } = await supabase
    .from('society_members')
    .select('id, society_id, role, is_committee_member, status, phone_number, societies(name, upi_vpa, upi_payee_name)')
    .eq('auth_user_id', req.user.id);

  if (membershipError) {
    return res.status(500).json({ error: membershipError.message });
  }

  const result = {
    user: { id: req.user.id, email: req.user.email },
    memberships: [],
  };

  for (const membership of memberships) {
    const entry = {
      society: membership.societies,
      role: membership.role,
      isCommitteeMember: membership.is_committee_member,
      status: membership.status,
      phoneNumber: membership.phone_number,
    };

    if (membership.role === 'Resident') {
      const { data: assignments, error: assignmentError } = await supabase
        .from('resident_house_assignments')
        .select('id, relationship_type, status, houses(id, house_number, type, status)')
        .eq('society_member_id', membership.id)
        .eq('status', 'Active');

      if (assignmentError) {
        return res.status(500).json({ error: assignmentError.message });
      }

      const houseIds = assignments.map((a) => a.houses?.id).filter(Boolean);

      let billingPeriods = [];
      if (houseIds.length > 0) {
        // Ordered oldest-first so this list always matches FIFO allocation
        // order - the first row here is exactly the one POST /transactions
        // will apply the resident's next payment to.
        const { data: periods, error: periodsError } = await supabase
          .from('billing_periods')
          .select('id, house_id, period_month, amount_due, status')
          .in('house_id', houseIds)
          .eq('status', 'Open')
          .order('period_month', { ascending: true });

        if (periodsError) {
          return res.status(500).json({ error: periodsError.message });
        }
        billingPeriods = periods;
      }

      entry.houseAssignments = assignments;
      entry.openBillingPeriods = billingPeriods;
      // Convenience total so the client doesn't need to sum client-side -
      // this is the resident's full outstanding balance across all open
      // periods on all their assigned houses, arrears included.
      entry.totalOutstanding = billingPeriods.reduce((sum, period) => sum + Number(period.amount_due), 0);
    }

    if (membership.role === 'Admin' || membership.is_committee_member) {
      const { data: houses, error: housesError } = await supabase
        .from('houses')
        .select('id, house_number, type, owner_name, status')
        .eq('society_id', membership.society_id);

      if (housesError) {
        return res.status(500).json({ error: housesError.message });
      }

      const { data: billingPeriods, error: periodsError } = await supabase
        .from('billing_periods')
        .select('id, house_id, period_month, amount_due, status')
        .eq('society_id', membership.society_id);

      if (periodsError) {
        return res.status(500).json({ error: periodsError.message });
      }

      entry.houses = houses;
      entry.billingPeriods = billingPeriods;
    }

    result.memberships.push(entry);
  }

  res.json(result);
});

module.exports = router;
