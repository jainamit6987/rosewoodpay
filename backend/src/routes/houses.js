const express = require('express');
const authenticate = require('../middleware/authenticate');
const supabaseAdmin = require('../config/supabaseAdmin');

const router = express.Router();

const PG_UNIQUE_VIOLATION = '23505';
const MAX_MONTHS_PER_REQUEST = 24; // guardrail against a fat-fingered "months" value, not a real business rule
const MAX_SEARCH_RESULTS = 5;

// Admin/Committee-only: case-insensitive partial match on house_number OR
// owner_name, across every society the caller administers or sits on the
// committee of - the same "collect societyIds from an Active is_admin/
// is_committee_member membership, 403 if none" shape GET /transactions/
// pending and GET /members already use. This exists because a real society
// can have well over a hundred houses - GET /me used to embed the full
// houses array for exactly this screen, but "scroll through all of them"
// stops being usable long before 100, and re-fetching that whole array on
// every /me call (which happens on nearly every screen - see App.js) only
// gets more wasteful as the list grows. Capped at MAX_SEARCH_RESULTS
// regardless of match count; an empty/missing q returns an empty array
// rather than "everything" - there is no sensible default page of 100+
// houses to show before the admin has typed anything.
//
// Two separate ilike queries, not one combined filter, deliberately: the
// PostgREST .or() string syntax treats commas/parentheses as its own
// delimiters, so splicing a raw, arbitrary search term into one would
// either break on a term containing either character or need its own
// fragile manual escaping. Running two simple, safe queries and merging in
// JS avoids that class of bug entirely, and neither query is expensive at
// this scale.
router.get('/search', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  if (!q) {
    return res.json([]);
  }

  const { data: memberships, error: membershipError } = await supabase
    .from('society_members')
    .select('society_id')
    .eq('auth_user_id', req.user.id)
    .eq('status', 'Active')
    .or('is_admin.eq.true,is_committee_member.eq.true');

  if (membershipError) {
    return res.status(500).json({ error: membershipError.message });
  }

  const societyIds = [...new Set((memberships || []).map((m) => m.society_id))];
  if (societyIds.length === 0) {
    return res.status(403).json({ error: 'Only an Admin or Committee member can search houses.' });
  }

  const houseFields = 'id, house_number, type, owner_name, status, default_monthly_amount';
  const [byNumber, byOwner] = await Promise.all([
    supabase
      .from('houses')
      .select(houseFields)
      .in('society_id', societyIds)
      .ilike('house_number', `%${q}%`)
      .order('house_number', { ascending: true })
      .limit(MAX_SEARCH_RESULTS),
    supabase
      .from('houses')
      .select(houseFields)
      .in('society_id', societyIds)
      .ilike('owner_name', `%${q}%`)
      .order('house_number', { ascending: true })
      .limit(MAX_SEARCH_RESULTS),
  ]);

  if (byNumber.error) {
    return res.status(500).json({ error: byNumber.error.message });
  }
  if (byOwner.error) {
    return res.status(500).json({ error: byOwner.error.message });
  }

  const houseById = new Map();
  for (const house of [...(byNumber.data || []), ...(byOwner.data || [])]) {
    houseById.set(house.id, house);
  }

  const results = [...houseById.values()]
    .sort((a, b) => a.house_number.localeCompare(b.house_number))
    .slice(0, MAX_SEARCH_RESULTS);

  res.json(results);
});

// Admin/Committee-only: a single house's own "dashboard" - the same shape
// of information ResidentHomeScreen shows a resident about their own house
// (current billing period, current due, last payment), reached by tapping
// a result on the search screen above. Deliberately does NOT rely on the
// looser "houses RLS lets any member of the same society see the house
// row" gate the sibling /:houseId/transactions and /:houseId/billing-
// periods routes use below - those return rows whose *own* RLS policies
// already filter out anything a merely-same-society caller shouldn't see,
// but this response includes an assigned resident's email/phone directly,
// which must not be reachable by just any member who happens to know or
// guess a house's id. Explicit Admin/Committee check instead, same shape
// as the create/waive billing-period routes further below.
router.get('/:houseId/dashboard', authenticate, async (req, res) => {
  const { houseId } = req.params;
  const supabase = req.supabase;

  const { data: house, error: houseError } = await supabase
    .from('houses')
    .select('id, society_id, house_number, type, owner_name, status, default_monthly_amount')
    .eq('id', houseId)
    .maybeSingle();

  if (houseError) {
    return res.status(500).json({ error: houseError.message });
  }
  if (!house) {
    return res.status(404).json({ error: 'House not found or not accessible.' });
  }

  const { data: membership, error: membershipError } = await supabase
    .from('society_members')
    .select('id')
    .eq('society_id', house.society_id)
    .eq('auth_user_id', req.user.id)
    .eq('status', 'Active')
    .or('is_admin.eq.true,is_committee_member.eq.true')
    .maybeSingle();

  if (membershipError) {
    return res.status(500).json({ error: membershipError.message });
  }
  if (!membership) {
    return res
      .status(403)
      .json({ error: "Only an Admin or Committee member of this house's society can view its dashboard." });
  }

  // "Current billing period" is this calendar month's own period, whatever
  // its status - same definition GET /me uses for a resident's own
  // dashboard (see routes/me.js). Null if this month's period has not
  // been generated yet.
  const now = new Date();
  const currentMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const { data: currentPeriod, error: currentPeriodError } = await supabase
    .from('billing_periods')
    .select('id, period_month, amount_due, status')
    .eq('house_id', houseId)
    .eq('period_month', currentMonthStart)
    .maybeSingle();

  if (currentPeriodError) {
    return res.status(500).json({ error: currentPeriodError.message });
  }

  // "Current due" sums every still-Open period for this house, arrears
  // included - same definition as GET /me's totalOutstanding, just scoped
  // to one house instead of every house a resident is personally assigned
  // to.
  const { data: openPeriods, error: openPeriodsError } = await supabase
    .from('billing_periods')
    .select('amount_due')
    .eq('house_id', houseId)
    .eq('status', 'Open');

  if (openPeriodsError) {
    return res.status(500).json({ error: openPeriodsError.message });
  }
  const currentDue = (openPeriods || []).reduce((sum, period) => sum + Number(period.amount_due), 0);

  // "Last payment" - the most recently Verified transaction against this
  // house. Same txn_date-preferred-for-display/verified_at-for-ordering
  // logic as GET /me (see that file's own note: txn_date is resident-
  // supplied and optional, so it is not safe to sort/pick by, only to
  // display).
  const { data: lastVerified, error: lastVerifiedError } = await supabase
    .from('transactions')
    .select('amount, txn_date, verified_at')
    .eq('house_id', houseId)
    .eq('processing_status', 'Verified')
    .order('verified_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastVerifiedError) {
    return res.status(500).json({ error: lastVerifiedError.message });
  }
  const lastPayment = lastVerified
    ? { amount: lastVerified.amount, date: lastVerified.txn_date || lastVerified.verified_at }
    : null;

  // Every currently Active assignment for this house - a co-owner/tenant
  // pair both show up here, not just one (see the co-assignee visibility
  // work elsewhere in this codebase); an unassigned house simply returns
  // an empty array rather than an error. auth.users is not part of the
  // RLS-visible 'public' schema, so each resident's email needs a separate
  // Admin API lookup - getUserById rather than the paginated listUsers()
  // GET /assignments and GET /members use, since this is always at most a
  // couple of residents per house rather than every member in the society.
  const { data: assignments, error: assignmentsError } = await supabase
    .from('resident_house_assignments')
    .select('id, relationship_type, society_members(id, name, auth_user_id, phone_number)')
    .eq('house_id', houseId)
    .eq('status', 'Active');

  if (assignmentsError) {
    return res.status(500).json({ error: assignmentsError.message });
  }

  // memberId included so the mobile Residents cards (normal mode: name +
  // role only, tapping opens MemberDetailScreen; Edit mode: revoke a card
  // via the existing /assignments/:id/revoke) can identify each resident
  // without a second round trip.
  const residents = await Promise.all(
    (assignments || []).map(async (assignment) => {
      const authUserId = assignment.society_members?.auth_user_id;
      let email = null;
      if (authUserId) {
        const { data: userData } = await supabaseAdmin.auth.admin.getUserById(authUserId);
        email = userData?.user?.email || null;
      }
      return {
        assignmentId: assignment.id,
        relationshipType: assignment.relationship_type,
        memberId: assignment.society_members?.id || null,
        memberName: assignment.society_members?.name || null,
        memberEmail: email,
        memberPhoneNumber: assignment.society_members?.phone_number || null,
      };
    })
  );

  res.json({
    house: {
      id: house.id,
      society_id: house.society_id,
      house_number: house.house_number,
      type: house.type,
      owner_name: house.owner_name,
      status: house.status,
      default_monthly_amount: house.default_monthly_amount,
    },
    currentPeriod: currentPeriod || null,
    currentDue,
    lastPayment,
    residents,
  });
});

// Same "walk forward one month from the house's own last row, or from the
// current month if it has none yet" logic as the auto-generation path in
// routes/transactions.js (there is no shared utils module in this codebase
// yet, so these three helpers are deliberately duplicated rather than
// importing from a sibling route file). Kept identical on purpose: whichever
// path creates a period next continues the same unbroken monthly sequence,
// so the FIFO cursor logic over there is never left with an unexplained gap.
function addMonths(dateString, count) {
  const date = new Date(dateString);
  date.setUTCMonth(date.getUTCMonth() + count);
  return date;
}

function startOfCurrentMonthUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

// Lists a house's transactions for anyone with visibility into that house -
// not just the person who submitted each one. This is the consumer of the
// "widen transaction visibility to co-assignees" RLS policy: an owner whose
// tenant pays the bill (or vice versa) can now see the shared house's
// payment status through req.supabase, without a manual authorization
// check here - RLS decides what comes back.
router.get('/:houseId/transactions', authenticate, async (req, res) => {
  const { houseId } = req.params;
  const supabase = req.supabase;

  // houses RLS lets any member of the same society see the house row, so
  // this only distinguishes "does not exist / not in your society" from a
  // real house - it does not by itself confirm the caller is assigned to it.
  const { data: house, error: houseError } = await supabase
    .from('houses')
    .select('id')
    .eq('id', houseId)
    .maybeSingle();

  if (houseError) {
    return res.status(500).json({ error: houseError.message });
  }
  if (!house) {
    return res.status(404).json({ error: 'House not found or not accessible.' });
  }

  // transaction_allocations is embedded via its FK to transactions, so each
  // transaction shows exactly which billing period(s) it covers - a single
  // payment can span more than one (arrears catch-up, advance payments).
  // Each allocation's own period_month is embedded too, same as GET
  // /transactions/mine and GET /transactions/pending - a screen showing
  // this list needs to name the actual month(s) covered, not just a count.
  const { data: transactions, error: transactionsError } = await supabase
    .from('transactions')
    .select(
      'id, house_id, submitted_by, amount, transaction_type, utr_number, payment_mode, txn_date, payment_status, processing_status, verified_at, created_at, transaction_allocations(billing_period_id, amount_allocated, billing_periods(period_month))'
    )
    .eq('house_id', houseId)
    .order('created_at', { ascending: false });

  if (transactionsError) {
    return res.status(500).json({ error: transactionsError.message });
  }

  // An empty array here is the expected, non-error outcome for a resident
  // with no active assignment to this house - the transactions RLS policy
  // filters silently rather than raising an error.
  res.json(transactions);
});

// Full billing history for a house - every period regardless of status
// (Open, Closed, Waived), not just the still-owing ones GET /me returns.
// This is the "all periods" screen from the workflow doc: GET /me
// deliberately only surfaces Open periods (it feeds the pay-dues flow), so
// a resident has had no way to see a month they already paid off, or one
// waived by the society, without this separate endpoint. Same visibility
// model as GET /:houseId/transactions above - RLS (the existing
// "Residents can view billing periods for their assigned flats" /
// "Admins and Committee can view billing periods" policies) decides what
// comes back, this route only distinguishes "house not visible at all"
// from a real result.
router.get('/:houseId/billing-periods', authenticate, async (req, res) => {
  const { houseId } = req.params;
  const supabase = req.supabase;

  const { data: house, error: houseError } = await supabase
    .from('houses')
    .select('id')
    .eq('id', houseId)
    .maybeSingle();

  if (houseError) {
    return res.status(500).json({ error: houseError.message });
  }
  if (!house) {
    return res.status(404).json({ error: 'House not found or not accessible.' });
  }

  // Newest month first, matching the transactions history endpoint's
  // newest-first ordering - a history view reads top-down as "here's the
  // most recent, and here's how it built up".
  const { data: billingPeriods, error: periodsError } = await supabase
    .from('billing_periods')
    .select('id, period_month, base_amount, amount_due, status')
    .eq('house_id', houseId)
    .order('period_month', { ascending: false });

  if (periodsError) {
    return res.status(500).json({ error: periodsError.message });
  }

  // Same hasPendingSubmission flag as GET /me (see routes/me.js for the
  // full reasoning): a period stays 'Open' right up until a payment against
  // it is actually Verified, so "Open" alone reads misleadingly here too -
  // a resident/admin looking at this history should be able to tell "still
  // genuinely unpaid" apart from "already has a Submitted payment sitting
  // in the review queue" without that meaning a new billing_periods.status
  // value (deliberately not done - see Society_App_Progress_Log.md: it
  // would ripple into the FIFO allocation filter, the pendency report's
  // "still owed" filter, and the verify handler's own status check, none of
  // which should change just to relabel this one badge).
  const periodIds = billingPeriods.map((period) => period.id);
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

  // Same as above: an empty array is the normal outcome for a resident with
  // no visible assignment to this house, not an error condition.
  res.json(
    billingPeriods.map((period) => ({
      ...period,
      hasPendingSubmission: pendingPeriodIds.has(period.id),
    }))
  );
});

// Admin-only: directly creates the next `months` sequential billing
// period(s) for a house, ahead of any payment - the "create billing record
// for a house (next month or future months for advance payment)" gap from
// the workflow doc. Before this, the *only* way a billing_periods row ever
// came into existence was as a side effect inside POST /transactions, when
// a payment covered more months than were currently Open - which meant a
// brand-new house had no visible dues at all until its first payment, and
// there was no way to get a period onto a resident's dues screen ahead of
// time (e.g. so they can see and pre-pay next month before it starts).
//
// Deliberately does not accept an arbitrary target period_month from the
// request - only "how many months forward" - because the FIFO allocation
// cursor in POST /transactions always resumes from the house's own latest
// existing period + 1 month; letting an admin jump straight to an arbitrary
// future month would leave a permanent, silently-never-filled gap behind it
// that nothing else in this codebase expects or fills in later. One month
// at a time, walking forward from whatever already exists, is the only
// shape that stays consistent with that cursor.
router.post('/:houseId/billing-periods', authenticate, async (req, res) => {
  const { houseId } = req.params;
  const { months } = req.body || {};
  const supabase = req.supabase;

  const monthsToCreate = months === undefined ? 1 : months;
  if (
    typeof monthsToCreate !== 'number' ||
    !Number.isInteger(monthsToCreate) ||
    monthsToCreate < 1 ||
    monthsToCreate > MAX_MONTHS_PER_REQUEST
  ) {
    return res.status(400).json({
      error: `months must be a whole number between 1 and ${MAX_MONTHS_PER_REQUEST}.`,
    });
  }

  const { data: house, error: houseError } = await supabase
    .from('houses')
    .select('id, society_id, default_monthly_amount')
    .eq('id', houseId)
    .maybeSingle();

  if (houseError) {
    return res.status(500).json({ error: houseError.message });
  }
  if (!house) {
    return res.status(404).json({ error: 'House not found or not accessible.' });
  }

  // Reads the caller's own row, always visible regardless of status via the
  // deliberately-ungated "own record" policy - same reasoning as every other
  // raw is_admin check elsewhere in this codebase, status='Active' must be
  // checked here explicitly rather than relying on RLS to have filtered it.
  const { data: adminMembership, error: adminError } = await supabase
    .from('society_members')
    .select('id')
    .eq('society_id', house.society_id)
    .eq('auth_user_id', req.user.id)
    .eq('is_admin', true)
    .eq('status', 'Active')
    .maybeSingle();

  if (adminError) {
    return res.status(500).json({ error: adminError.message });
  }
  if (!adminMembership) {
    return res.status(403).json({ error: 'Only an Admin of this house\'s society can create a billing period.' });
  }

  if (!house.default_monthly_amount) {
    return res.status(409).json({
      error: 'This house has no default monthly amount configured, so a billing period cannot be created. Set one first.',
    });
  }

  const { data: existingPeriods, error: existingError } = await supabase
    .from('billing_periods')
    .select('period_month')
    .eq('house_id', houseId)
    .order('period_month', { ascending: false })
    .limit(1);

  if (existingError) {
    return res.status(500).json({ error: existingError.message });
  }

  let cursorMonth = existingPeriods && existingPeriods.length > 0 ? existingPeriods[0].period_month : null;
  const created = [];

  for (let i = 0; i < monthsToCreate; i += 1) {
    const nextMonth = cursorMonth ? addMonths(cursorMonth, 1) : startOfCurrentMonthUtc();
    const nextMonthDate = toDateOnly(nextMonth);

    const { data: inserted, error: insertError } = await supabase
      .from('billing_periods')
      .insert({
        society_id: house.society_id,
        house_id: houseId,
        period_month: nextMonthDate,
        base_amount: house.default_monthly_amount,
        amount_due: house.default_monthly_amount,
        status: 'Open',
      })
      .select('id, period_month, base_amount, amount_due, status')
      .single();

    if (insertError) {
      // A concurrent request (or a leftover row from an earlier partial
      // call) already created this exact month - stop here rather than
      // erroring out on an otherwise-successful batch; whatever was created
      // before this point in the loop is still returned.
      if (insertError.code === PG_UNIQUE_VIOLATION) {
        break;
      }
      return res.status(500).json({
        error: `Created ${created.length} of ${monthsToCreate} requested period(s) before failing: ${insertError.message}`,
        created,
      });
    }

    created.push(inserted);
    cursorMonth = inserted.period_month;
  }

  if (created.length === 0) {
    return res.status(409).json({
      error: 'Every requested month already has a billing period for this house - nothing new to create.',
    });
  }

  const { error: auditError } = await supabase.from('audit_events').insert({
    society_id: house.society_id,
    actor_user_id: req.user.id,
    entity_type: 'billing_period',
    entity_id: created[0].id,
    action: 'Created',
    metadata: {
      house_id: houseId,
      periods_created: created.map((p) => ({ id: p.id, period_month: p.period_month })),
      requested_months: monthsToCreate,
    },
  });

  if (auditError) {
    return res.status(500).json({
      error: `Billing period(s) created but the audit log entry failed: ${auditError.message}`,
      created,
    });
  }

  res.status(201).json(created);
});

// Admin-only: forgives an Open billing period's dues - the "update
// billing -- for waived" gap from the workflow doc (the doc's own note
// that "close is done when transaction is approved" already covers the
// Open -> Closed transition via the existing verify flow in
// routes/transactions.js; this is the other transition, Open -> Waived,
// that nothing in this codebase has ever performed).
//
// Deliberately one-way and Open-only, matching every other status
// transition in this codebase (verify/reject, suspend/reactivate): a
// Closed period cannot be waived after the fact (that money was already
// collected and verified - waiving it now would misrepresent what
// actually happened), and there is no un-waive action, since nothing has
// asked for one yet. Also refuses to waive a period that already has ANY
// transaction_allocations row against it, Verified or still-Submitted -
// a period with payment activity already underway is not the "nobody has
// paid this, and nobody should have to" case this action exists for.
router.post('/:houseId/billing-periods/:periodId/waive', authenticate, async (req, res) => {
  const { houseId, periodId } = req.params;
  const { reason } = req.body || {};
  const supabase = req.supabase;

  if (typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'A non-empty reason is required to waive a billing period.' });
  }

  const { data: house, error: houseError } = await supabase
    .from('houses')
    .select('id, society_id')
    .eq('id', houseId)
    .maybeSingle();

  if (houseError) {
    return res.status(500).json({ error: houseError.message });
  }
  if (!house) {
    return res.status(404).json({ error: 'House not found or not accessible.' });
  }

  // Same raw own-row is_admin/status='Active' check as the sibling create
  // route above - RLS's ungated "own record" policy would otherwise let a
  // Suspended admin's already-issued token slip through.
  const { data: adminMembership, error: adminError } = await supabase
    .from('society_members')
    .select('id')
    .eq('society_id', house.society_id)
    .eq('auth_user_id', req.user.id)
    .eq('is_admin', true)
    .eq('status', 'Active')
    .maybeSingle();

  if (adminError) {
    return res.status(500).json({ error: adminError.message });
  }
  if (!adminMembership) {
    return res.status(403).json({ error: 'Only an Admin of this house\'s society can waive a billing period.' });
  }

  const { data: period, error: periodError } = await supabase
    .from('billing_periods')
    .select('id, period_month, status')
    .eq('id', periodId)
    .eq('house_id', houseId)
    .maybeSingle();

  if (periodError) {
    return res.status(500).json({ error: periodError.message });
  }
  if (!period) {
    return res.status(404).json({ error: 'Billing period not found for this house.' });
  }
  if (period.status !== 'Open') {
    return res.status(409).json({ error: `This billing period is already "${period.status}" and cannot be waived.` });
  }

  const { data: allocations, error: allocationsError } = await supabase
    .from('transaction_allocations')
    .select('id')
    .eq('billing_period_id', periodId)
    .limit(1);

  if (allocationsError) {
    return res.status(500).json({ error: allocationsError.message });
  }
  if (allocations && allocations.length > 0) {
    return res.status(409).json({
      error: 'This billing period already has a payment allocated against it and cannot be waived.',
    });
  }

  const waivedAt = new Date().toISOString();

  const { data: updated, error: updateError } = await supabase
    .from('billing_periods')
    .update({
      status: 'Waived',
      amount_due: 0,
      waived_reason: reason.trim(),
      waived_by: req.user.id,
      waived_at: waivedAt,
      updated_at: waivedAt,
    })
    .eq('id', periodId)
    .select('id, house_id, period_month, base_amount, amount_due, status, waived_reason, waived_by, waived_at')
    .single();

  if (updateError) {
    return res.status(500).json({ error: updateError.message });
  }

  const { error: auditError } = await supabase.from('audit_events').insert({
    society_id: house.society_id,
    actor_user_id: req.user.id,
    entity_type: 'billing_period',
    entity_id: periodId,
    action: 'Waived',
    metadata: { house_id: houseId, period_month: period.period_month, reason: reason.trim() },
  });

  if (auditError) {
    return res.status(500).json({
      error: `Billing period waived but the audit log entry failed: ${auditError.message}`,
      billingPeriod: updated,
    });
  }

  res.json(updated);
});

module.exports = router;
