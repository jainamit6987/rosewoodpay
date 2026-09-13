const express = require('express');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

// Mirrors chk_phone_number_format from
// 20260725010000_add_phone_number_to_society_members.sql exactly - same
// pattern backend/src/routes/members.js's own Admin-edit path already
// validates against.
const PHONE_NUMBER_PATTERN = /^[0-9+\-\s()]{7,20}$/;

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
    .select('id, society_id, name, is_admin, is_committee_member, status, phone_number, societies(id, name, upi_vpa, upi_payee_name)')
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
      // Needed by the mobile app's new self-service Edit Profile screen to
      // target PATCH /me/profile at the right row - not previously
      // returned here since nothing before it ever needed to address a
      // specific membership row from the client side.
      id: membership.id,
      society: membership.societies,
      name: membership.name,
      isAdmin: membership.is_admin,
      isCommitteeMember: membership.is_committee_member,
      status: membership.status,
      phoneNumber: membership.phone_number,
    };

    // Personal dues are keyed off "does this member have any house
    // assignment at all", never off is_admin/is_committee_member - the two
    // are independent facts about the same person. A society secretary
    // (is_admin=true) who also personally owns/occupies a house owes their
    // own maintenance exactly like any other resident and must see it here;
    // an Admin with no house of their own simply gets empty arrays below,
    // same as always. This block now always runs.
    const { data: assignments, error: assignmentError } = await supabase
      .from('resident_house_assignments')
      .select('id, relationship_type, status, houses(id, house_number, type, status, owner_name, available_to_rent)')
      .eq('society_member_id', membership.id)
      .eq('status', 'Active');

    if (assignmentError) {
      return res.status(500).json({ error: assignmentError.message });
    }

    const houseIds = assignments.map((a) => a.houses?.id).filter(Boolean);

    // "Current billing period" for the resident dashboard means this
    // calendar month's own period, whatever its status - distinct from the
    // open-periods arrears list below. Null if this month's period hasn't
    // been generated yet.
    let currentPeriodByHouse = new Map();
    if (houseIds.length > 0) {
      const now = new Date();
      const currentMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const { data: currentPeriods, error: currentPeriodError } = await supabase
        .from('billing_periods')
        .select('id, house_id, period_month, amount_due, status')
        .in('house_id', houseIds)
        .eq('period_month', currentMonthStart);

      if (currentPeriodError) {
        return res.status(500).json({ error: currentPeriodError.message });
      }
      currentPeriodByHouse = new Map((currentPeriods || []).map((period) => [period.house_id, period]));
    }

    // "Last payment" is the most recently Verified transaction against each
    // house. Fetched once for every house this member has, then reduced to
    // one row per house_id here - PostgREST has no clean "latest per group"
    // shortcut, and per-member house counts are always small. Ordered (and
    // picked) by verified_at, not txn_date: txn_date is resident-supplied
    // and optional (see the same caution in routes/transactions.js's report
    // endpoint) so it can be NULL and is not safe to sort by. The date shown
    // below still prefers txn_date when present, purely for display - that
    // is the actual UPI payment date, which can genuinely be a day or two
    // before an Admin gets to verify it, and showing verified_at instead
    // would read as "wrong"/confusing to the resident.
    let lastPaymentByHouse = new Map();
    if (houseIds.length > 0) {
      const { data: verifiedTransactions, error: verifiedError } = await supabase
        .from('transactions')
        .select('house_id, amount, txn_date, verified_at')
        .in('house_id', houseIds)
        .eq('processing_status', 'Verified')
        .order('verified_at', { ascending: false });

      if (verifiedError) {
        return res.status(500).json({ error: verifiedError.message });
      }
      for (const transaction of verifiedTransactions || []) {
        if (!lastPaymentByHouse.has(transaction.house_id)) {
          lastPaymentByHouse.set(transaction.house_id, {
            amount: transaction.amount,
            date: transaction.txn_date || transaction.verified_at,
          });
        }
      }
    }

    let billingPeriods = [];
    if (houseIds.length > 0) {
      // Ordered oldest-first so this list always matches FIFO allocation
      // order - the first row here is exactly the one POST /transactions
      // will apply this member's next payment to.
      const { data: periods, error: periodsError } = await supabase
        .from('billing_periods')
        .select('id, house_id, period_month, amount_due, status')
        .in('house_id', houseIds)
        .eq('status', 'Open')
        .order('period_month', { ascending: true });

      if (periodsError) {
        return res.status(500).json({ error: periodsError.message });
      }

      // A period stays 'Open' right up until a Verified payment covers it -
      // so an Open period can already have a real payment sitting against
      // it, just not yet reviewed (see the close-on-verify logic in
      // routes/transactions.js's verify handler). Flag those here so the
      // mobile dues screen can grey them out rather than letting a resident
      // pay the same period twice while the first payment is still awaiting
      // an Admin's decision - FIFO would otherwise auto-allocate a second
      // payment to that exact same period. Only 'Submitted' is checked, not
      // the full processing_status list, since nothing in this codebase's
      // actual submission flow ever produces the other in-between OCR-
      // pipeline values (Queued/Processing/etc - see chk_processing_status);
      // Verified periods never reach here (status flips to 'Closed'), and
      // Rejected/Failed ones leave the period exactly as unpaid as before,
      // so there is nothing to flag for either of those.
      const periodIds = periods.map((period) => period.id);
      let pendingPeriodIds = new Set();
      if (periodIds.length > 0) {
        const { data: pendingAllocations, error: pendingError } = await supabase
          .from('transaction_allocations')
          .select('billing_period_id, transactions!inner(processing_status)')
          .in('billing_period_id', periodIds)
          .eq('transactions.processing_status', 'Submitted');

        if (pendingError) {
          return res.status(500).json({ error: pendingError.message });
        }
        pendingPeriodIds = new Set((pendingAllocations || []).map((allocation) => allocation.billing_period_id));
      }

      billingPeriods = periods.map((period) => ({
        ...period,
        hasPendingSubmission: pendingPeriodIds.has(period.id),
      }));
    }

    entry.houseAssignments = assignments.map((assignment) => {
      const houseId = assignment.houses?.id;
      return {
        ...assignment,
        currentPeriod: houseId ? currentPeriodByHouse.get(houseId) || null : null,
        lastPayment: houseId ? lastPaymentByHouse.get(houseId) || null : null,
      };
    });
    entry.openBillingPeriods = billingPeriods;
    // Convenience total so the client doesn't need to sum client-side -
    // this member's full personal outstanding balance across all open
    // periods on all their assigned houses, arrears included. Zero for a
    // member with no house assignments at all (e.g. a pure Admin).
    entry.totalOutstanding = billingPeriods.reduce((sum, period) => sum + Number(period.amount_due), 0);

    if (membership.is_admin || membership.is_committee_member) {
      // A count, not the houses themselves - a real society can have well
      // over a hundred houses, and this same /me response gets re-fetched
      // on essentially every screen (see App.js's own note on that
      // tradeoff). AdminHomeScreen's dashboard tile is the only consumer,
      // and only ever needed the count; HousesScreen used to read the full
      // array here too, but is now its own search-driven screen backed by
      // GET /houses/search instead of ever listing every house at once.
      // { count: 'exact', head: true } asks Postgres for just the row
      // count with no rows returned, not "select everything then measure
      // .length" - the earlier full unused society-wide billing_periods
      // fetch this block also used to do (nothing ever read entry.
      // billingPeriods) is dropped entirely for the same reason.
      const { count: houseCount, error: housesError } = await supabase
        .from('houses')
        .select('id', { count: 'exact', head: true })
        .eq('society_id', membership.society_id);

      if (housesError) {
        return res.status(500).json({ error: housesError.message });
      }

      entry.houseCount = houseCount ?? 0;
    }

    result.memberships.push(entry);
  }

  res.json(result);
});

// PATCH /me/profile - self-service counterpart to Admin-only PATCH
// /members/:id, scoped to exactly the fields a resident may change about
// themselves: name and phone_number. Never email (lives on auth.users,
// out of scope here - see the migration's own comment) or
// is_admin/is_committee_member/status/society_id (Admin-only, and now
// also blocked at the database level regardless of caller by
// guard_society_member_privileged_fields() -
// 20260913000000_allow_resident_self_service_profile_update.sql).
//
// `society_member_id` is required in the body rather than inferred
// solely from the caller's token: GET /me already returns an array of
// memberships (a person can belong to more than one society - see its
// own `unique_society_member UNIQUE (society_id, auth_user_id)`
// constraint, one row per society), so the client must say which one it
// means. The ownership check below (`target.auth_user_id === req.user.id`)
// is what actually matters for security - the new RLS UPDATE policy
// would reject any other row before the query even gets this far, this
// is just a clearer 403 than a generic RLS-denied error would be.
router.patch('/profile', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { society_member_id, name, phone_number } = req.body || {};

  if (!society_member_id) {
    return res.status(400).json({ error: 'society_member_id is required.' });
  }
  if (name === undefined && phone_number === undefined) {
    return res.status(400).json({ error: 'Provide at least one of name or phone_number to update.' });
  }
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ error: 'name, if provided, must be a non-empty string.' });
  }
  if (phone_number !== undefined && phone_number !== null && !PHONE_NUMBER_PATTERN.test(phone_number)) {
    return res.status(400).json({
      error: 'phone_number must be 7-20 characters of digits, spaces, +, -, or parentheses.',
    });
  }

  const { data: target, error: targetError } = await supabase
    .from('society_members')
    .select('id, auth_user_id')
    .eq('id', society_member_id)
    .maybeSingle();

  if (targetError) {
    return res.status(500).json({ error: targetError.message });
  }
  if (!target) {
    return res.status(404).json({ error: 'Membership not found or not accessible.' });
  }
  if (target.auth_user_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only update your own profile.' });
  }

  const updates = {};
  if (name !== undefined) updates.name = name.trim();
  if (phone_number !== undefined) updates.phone_number = phone_number;

  const { data: updated, error: updateError } = await supabase
    .from('society_members')
    .update(updates)
    .eq('id', society_member_id)
    .select('id, name, phone_number')
    .single();

  if (updateError) {
    return res.status(500).json({ error: updateError.message });
  }

  // Deliberately no audit_events entry here, unlike PATCH /members/:id -
  // that table's own RLS INSERT policy is Admin-only ("Admins can insert
  // audit events for their society"), and audit_events is documented as
  // being for "sensitive administrative and verification actions"
  // (see its COMMENT ON TABLE in 20260724000000_initial_schema.sql) - a
  // resident editing their own contact details isn't that; there is
  // nothing here for an Admin to need an audit trail of.
  res.json({ id: updated.id, name: updated.name, phoneNumber: updated.phone_number });
});

module.exports = router;
