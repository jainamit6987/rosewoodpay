const express = require('express');
const authenticate = require('../middleware/authenticate');
const supabaseAdmin = require('../config/supabaseAdmin');

const router = express.Router();

const PG_UNIQUE_VIOLATION = '23505';
const MAX_MONTHS_PER_REQUEST = 24; // guardrail against a fat-fingered "months" value, not a real business rule
const MAX_SEARCH_RESULTS = 5;

// The CALLER's OWN Active relationship_type on this specific house, or
// null if they do not have one - not just "someone" visible under RLS.
// This distinction matters because resident_house_assignments' own
// SELECT policies are role-dependent: a plain resident only ever sees
// their OWN rows there, so for them a non-empty result already implies
// it is theirs - but an Admin/Committee caller's broader "view every
// assignment in the society" policy would also return e.g. the REAL
// owner's row for a house they do not themselves own, which a bare
// "does any Owner row exist" check would wrongly treat as
// authorization. Joining through society_members.auth_user_id and
// filtering in JS here is what actually closes that gap, regardless of
// which RLS policy happened to let the row through. Shared by both the
// available-to-rent toggle (Owner-only) and the house profile route
// (any resident) below.
async function getOwnActiveRelationshipOnHouse(supabase, userId, houseId) {
  const { data, error } = await supabase
    .from('resident_house_assignments')
    .select('relationship_type, society_members!inner(auth_user_id)')
    .eq('house_id', houseId)
    .eq('status', 'Active');
  if (error) throw new Error(error.message);
  const own = (data || []).find((row) => row.society_members?.auth_user_id === userId);
  return own ? own.relationship_type : null;
}

async function requireActiveOwnerOfHouse(supabase, userId, houseId) {
  return (await getOwnActiveRelationshipOnHouse(supabase, userId, houseId)) === 'Owner';
}

// Priority for "what should this ONE billing period's receipt currently
// show" when it has more than one payment attempt against it (a rejected
// submission followed by a successful resubmission, or a still-pending one
// sitting alongside an older rejected attempt) - a Verified payment (money
// actually collected) always wins, then a still-in-review Submitted one,
// then a Rejected attempt, so there is always exactly one truth per period.
// Shared by GET /:houseId/billing-periods' latestPaymentStatus flag and
// GET /:houseId/billing-periods/:periodId/receipt below - both need the
// exact same "which attempt matters" answer, just at different levels of
// detail.
const PAYMENT_STATUS_PRIORITY = { Verified: 3, Submitted: 2, Rejected: 1 };

function pickPrimaryAllocation(allocationRows) {
  const ranked = (allocationRows || [])
    .filter((row) => PAYMENT_STATUS_PRIORITY[row.transactions?.processing_status])
    .sort((a, b) => PAYMENT_STATUS_PRIORITY[b.transactions.processing_status] - PAYMENT_STATUS_PRIORITY[a.transactions.processing_status]);
  if (ranked.length === 0) return null;

  const topStatus = ranked[0].transactions.processing_status;
  // Submitted transactions have no verified_at yet, so ordering by
  // created_at is the only option there; Verified/Rejected both always have
  // verified_at set by the time they reach either of those states.
  const dateField = topStatus === 'Submitted' ? 'created_at' : 'verified_at';
  return ranked
    .filter((row) => row.transactions.processing_status === topStatus)
    .sort((a, b) => new Date(b.transactions[dateField] || b.transactions.created_at) - new Date(a.transactions[dateField] || a.transactions.created_at))[0];
}

// GET /listings?society_id= - any Active member of that society (no
// Admin/Committee/resident-of-that-house restriction - this is a
// same-society-wide noticeboard, a deliberately wider trust boundary than
// GET /:houseId/profile's "just the two housemates sharing one house"
// scope, discussed directly with the user). Returns every house currently
// marked available_to_rent in that society, each with its own Owner's
// name/mobile/email attached directly - the whole point of a listing is
// to be contactable, and the owner already opted into exactly that by
// flipping the flag on (see PATCH /:houseId/available-to-rent).
//
// No separate 403 check here on purpose: the houses query below already
// goes through the caller's own req.supabase, so the existing "Residents
// can view houses in their society" RLS policy silently returns nothing
// for a society_id the caller does not actually belong to - same
// "let RLS do the gating, this route only distinguishes shapes" pattern
// GET /:houseId/transactions and GET /:houseId/billing-periods already
// use below, rather than a fresh explicit membership lookup for a route
// that has no house-specific id to check against anyway.
router.get('/listings', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const societyId = typeof req.query.society_id === 'string' ? req.query.society_id.trim() : '';

  if (!societyId) {
    return res.status(400).json({ error: 'society_id is required.' });
  }

  const { data: houses, error: housesError } = await supabase
    .from('houses')
    .select('id, house_number, type')
    .eq('society_id', societyId)
    .eq('available_to_rent', true)
    .order('house_number', { ascending: true });

  if (housesError) {
    return res.status(500).json({ error: housesError.message });
  }
  if (!houses || houses.length === 0) {
    return res.json([]);
  }

  const houseIds = houses.map((h) => h.id);

  // supabaseAdmin from here on - same reasoning as GET /:houseId/profile's
  // own note: a plain member's req.supabase token only ever sees their OWN
  // resident_house_assignments row under RLS, never another resident's
  // (here, likely a total stranger's, not even a housemate's). The houses
  // query above is what already proved same-society membership; this only
  // widens WHAT the already-authorized caller gets back for each listed
  // house, not WHO may ask.
  const { data: ownerAssignments, error: assignmentsError } = await supabaseAdmin
    .from('resident_house_assignments')
    .select('house_id, society_members(name, auth_user_id, phone_number)')
    .in('house_id', houseIds)
    .eq('relationship_type', 'Owner')
    .eq('status', 'Active');

  if (assignmentsError) {
    return res.status(500).json({ error: assignmentsError.message });
  }

  const ownerByHouseId = new Map();
  for (const assignment of ownerAssignments || []) {
    if (!ownerByHouseId.has(assignment.house_id)) {
      ownerByHouseId.set(assignment.house_id, assignment);
    }
  }

  const listings = await Promise.all(
    houses.map(async (house) => {
      const match = ownerByHouseId.get(house.id);
      let email = null;
      const authUserId = match?.society_members?.auth_user_id;
      if (authUserId) {
        const { data: userData } = await supabaseAdmin.auth.admin.getUserById(authUserId);
        email = userData?.user?.email || null;
      }
      return {
        id: house.id,
        house_number: house.house_number,
        type: house.type,
        owner: {
          name: match?.society_members?.name || null,
          phoneNumber: match?.society_members?.phone_number || null,
          email,
        },
      };
    })
  );

  res.json(listings);
});

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

// GET /:houseId/profile - any Active resident (Owner/Tenant/Occupant) of
// THIS specific house, verified via getOwnActiveRelationshipOnHouse
// above (not just "any assignment visible under RLS" - see that
// function's own note on why an Admin/Committee caller's broader
// visibility would otherwise slip through). Deliberately shows every
// housemate their OTHER housemate's own contact info (Owner sees the
// Tenant's phone/email and vice versa) - discussed directly with the
// user: a new, intentional trust boundary that did not exist before
// (GET /me only ever showed a resident their OWN contact info), scoped
// to exactly the residents sharing one house, nothing wider. "Owner
// Name" deliberately still comes from the house's own free-text
// owner_name field (same source ResidentHomeScreen's table already
// used), NOT from whichever member happens to hold the Owner
// assignment - the user chose to keep that field exactly as-is; only
// the Owner's phone/email (which owner_name alone can never carry) come
// from the actual Owner assignment's member record. If a house ever
// somehow has more than one Active Owner or Tenant (schema allows co-
// owners), this deliberately only ever surfaces the first one found of
// each - the user confirmed a single Owner + single Tenant slot is
// enough for this page.
router.get('/:houseId/profile', authenticate, async (req, res) => {
  const { houseId } = req.params;
  const supabase = req.supabase;

  const { data: house, error: houseError } = await supabase
    .from('houses')
    .select('id, house_number, owner_name, available_to_rent')
    .eq('id', houseId)
    .maybeSingle();

  if (houseError) {
    return res.status(500).json({ error: houseError.message });
  }
  if (!house) {
    return res.status(404).json({ error: 'House not found or not accessible.' });
  }

  let viewerRelationshipType;
  try {
    viewerRelationshipType = await getOwnActiveRelationshipOnHouse(supabase, req.user.id, houseId);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!viewerRelationshipType) {
    return res.status(403).json({ error: 'Only a resident of this house can view its profile.' });
  }

  // supabaseAdmin from here on - RLS's own "Residents can view their own
  // active assignments" policy would otherwise hide every OTHER
  // resident's row from a plain resident's own req.supabase token (e.g.
  // a Tenant querying this would never see the Owner's own assignment
  // row); the residency check above is what actually authorizes reading
  // past that, same reasoning as GET /:houseId/dashboard's own Admin-only
  // use of supabaseAdmin for the same underlying reason.
  const { data: allAssignments, error: allError } = await supabaseAdmin
    .from('resident_house_assignments')
    .select('relationship_type, society_members(name, auth_user_id, phone_number)')
    .eq('house_id', houseId)
    .eq('status', 'Active');

  if (allError) {
    return res.status(500).json({ error: allError.message });
  }

  const buildContact = async (relationshipType) => {
    const match = (allAssignments || []).find((a) => a.relationship_type === relationshipType);
    if (!match) return null;
    let email = null;
    const authUserId = match.society_members?.auth_user_id;
    if (authUserId) {
      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(authUserId);
      email = userData?.user?.email || null;
    }
    return {
      name: match.society_members?.name || null,
      phoneNumber: match.society_members?.phone_number || null,
      email,
    };
  };

  const [owner, tenant] = await Promise.all([buildContact('Owner'), buildContact('Tenant')]);

  res.json({
    house: {
      id: house.id,
      house_number: house.house_number,
      owner_name: house.owner_name,
      available_to_rent: house.available_to_rent,
    },
    viewerRelationshipType,
    owner,
    tenant,
  });
});

// PATCH /:houseId/available-to-rent - Owner-only (an Active Owner
// assignment on THIS specific house, not just any Admin/Committee member
// of its society - see requireActiveOwnerOfHouse above). Toggles the
// simple boolean flag an owner uses to signal "I want to rent this house
// out"; see 20260805000000_add_available_to_rent_to_houses.sql for why
// this is a single column rather than a separate listings table
// (discussed directly with the user: no rent amount/contact/notes/history
// was ever asked for - just this flag plus the house's own already-
// existing house_number/owner_name for display). The resident-facing
// "browse all available houses" screen is a deliberately separate, later
// follow-up; this endpoint only covers an owner managing their own
// house's flag from their own dashboard.
router.patch('/:houseId/available-to-rent', authenticate, async (req, res) => {
  const { houseId } = req.params;
  const { available_to_rent } = req.body || {};
  const supabase = req.supabase;

  if (typeof available_to_rent !== 'boolean') {
    return res.status(400).json({ error: 'available_to_rent must be a boolean.' });
  }

  const { data: house, error: houseError } = await supabase
    .from('houses')
    .select('id, society_id, available_to_rent')
    .eq('id', houseId)
    .maybeSingle();

  if (houseError) {
    return res.status(500).json({ error: houseError.message });
  }
  if (!house) {
    return res.status(404).json({ error: 'House not found or not accessible.' });
  }

  let isOwner;
  try {
    isOwner = await requireActiveOwnerOfHouse(supabase, req.user.id, houseId);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!isOwner) {
    return res.status(403).json({ error: 'Only an Active Owner of this house can change its available-to-rent flag.' });
  }

  if (house.available_to_rent === available_to_rent) {
    return res.status(409).json({
      error: `This house is already marked as ${available_to_rent ? 'available' : 'not available'} to rent.`,
    });
  }

  const { data: updated, error: updateError } = await supabase
    .from('houses')
    .update({ available_to_rent, updated_at: new Date().toISOString() })
    .eq('id', houseId)
    .select('id, house_number, available_to_rent')
    .single();

  if (updateError) {
    return res.status(500).json({ error: updateError.message });
  }

  // audit_events' own INSERT policy is Admin-only ("Admins can insert
  // audit events for their society") - an Owner's own req.supabase token
  // has no write access to it at all, so this uses supabaseAdmin (service
  // role) instead, same as every other resident-triggered audit write in
  // this codebase already has to (see autoClearAvailableToRent in
  // routes/assignments.js for the identical reasoning).
  const { error: auditError } = await supabaseAdmin.from('audit_events').insert({
    society_id: house.society_id,
    actor_user_id: req.user.id,
    entity_type: 'house',
    entity_id: houseId,
    action: available_to_rent ? 'MarkedAvailableToRent' : 'MarkedNotAvailableToRent',
    metadata: {},
  });

  if (auditError) {
    return res.status(500).json({
      error: `Flag updated but the audit log entry failed: ${auditError.message}`,
      house: updated,
    });
  }

  res.json(updated);
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
      'id, house_id, submitted_by, amount, transaction_type, utr_number, payment_mode, description, txn_date, payment_status, processing_status, verified_at, created_at, transaction_allocations(billing_period_id, amount_allocated, billing_periods(period_month))'
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

  // latestPaymentStatus - purely additive, for the new "View Receipt" link
  // on this same screen (see MaintenanceReceiptScreen): 'Verified' /
  // 'Submitted' / 'Rejected' per PAYMENT_STATUS_PRIORITY above, or null if
  // this period has never had a payment attempt against it at all. A
  // separate query from pendingPeriodIds above (not derived from it)
  // deliberately, so hasPendingSubmission's own already-tested behavior is
  // never touched by this addition.
  let latestPaymentStatusByPeriodId = new Map();
  if (periodIds.length > 0) {
    const { data: allAllocations, error: allAllocationsError } = await supabase
      .from('transaction_allocations')
      .select('billing_period_id, transactions!inner(processing_status, verified_at, created_at)')
      .in('billing_period_id', periodIds);

    if (allAllocationsError) {
      return res.status(500).json({ error: allAllocationsError.message });
    }

    const rowsByPeriodId = new Map();
    for (const row of allAllocations || []) {
      const list = rowsByPeriodId.get(row.billing_period_id) || [];
      list.push(row);
      rowsByPeriodId.set(row.billing_period_id, list);
    }
    for (const [billingPeriodId, rows] of rowsByPeriodId.entries()) {
      const primary = pickPrimaryAllocation(rows);
      if (primary) {
        latestPaymentStatusByPeriodId.set(billingPeriodId, primary.transactions.processing_status);
      }
    }
  }

  // Same as above: an empty array is the normal outcome for a resident with
  // no visible assignment to this house, not an error condition.
  res.json(
    billingPeriods.map((period) => ({
      ...period,
      hasPendingSubmission: pendingPeriodIds.has(period.id),
      latestPaymentStatus: latestPaymentStatusByPeriodId.get(period.id) || null,
    }))
  );
});

// GET /:houseId/billing-periods/:periodId/receipt - the "View Receipt"
// action on a single billing history row. A receipt is always for exactly
// ONE billing period, even when the underlying payment was a bulk
// transaction that also covered other periods (see
// MaintenanceReceiptScreen's own comment on this) - so this resolves to a
// single transaction_allocations row scoped to THIS period via
// pickPrimaryAllocation above, never a list. Same visibility model as the
// sibling routes above: RLS on transaction_allocations/transactions (the
// "visible transactions" / co-assignee policy) decides what a resident can
// see; this route only distinguishes "not found" from a real result. 404
// (not an empty/blank receipt) if nothing has ever been submitted against
// this period - there is nothing to show yet.
router.get('/:houseId/billing-periods/:periodId/receipt', authenticate, async (req, res) => {
  const { houseId, periodId } = req.params;
  const supabase = req.supabase;

  const { data: house, error: houseError } = await supabase
    .from('houses')
    .select('id, house_number, owner_name')
    .eq('id', houseId)
    .maybeSingle();

  if (houseError) {
    return res.status(500).json({ error: houseError.message });
  }
  if (!house) {
    return res.status(404).json({ error: 'House not found or not accessible.' });
  }

  const { data: period, error: periodError } = await supabase
    .from('billing_periods')
    .select('id, society_id, house_id, period_month, amount_due, status')
    .eq('id', periodId)
    .eq('house_id', houseId)
    .maybeSingle();

  if (periodError) {
    return res.status(500).json({ error: periodError.message });
  }
  if (!period) {
    return res.status(404).json({ error: 'Billing period not found for this house.' });
  }

  const { data: allocations, error: allocationsError } = await supabase
    .from('transaction_allocations')
    .select(
      'amount_allocated, transactions!inner(id, payment_mode, utr_number, txn_date, processing_status, submitted_by, verified_by, verified_at, rejection_reason, created_at)'
    )
    .eq('billing_period_id', periodId);

  if (allocationsError) {
    return res.status(500).json({ error: allocationsError.message });
  }

  const primary = pickPrimaryAllocation(allocations || []);
  if (!primary) {
    return res.status(404).json({ error: 'No payment has been submitted for this billing period yet.' });
  }

  const transaction = primary.transactions;
  const statusLabel =
    transaction.processing_status === 'Verified'
      ? 'Approved'
      : transaction.processing_status === 'Submitted'
      ? 'Pending Approval'
      : 'Rejected';

  const { data: society, error: societyError } = await supabase
    .from('societies')
    .select('name')
    .eq('id', period.society_id)
    .maybeSingle();

  if (societyError) {
    return res.status(500).json({ error: societyError.message });
  }

  // supabaseAdmin to resolve display names for whichever auth_user_ids are
  // involved (the submitter, and the verifier once Approved) - same
  // reasoning as GET /:houseId/profile's own use of supabaseAdmin: a plain
  // resident's own req.supabase token only ever sees their OWN
  // society_members row under RLS, never another member's (a housemate who
  // actually submitted the payment, or the Admin who verified/rejected it).
  const memberAuthUserIds = [...new Set([transaction.submitted_by, transaction.verified_by].filter(Boolean))];
  const { data: members, error: membersError } =
    memberAuthUserIds.length > 0
      ? await supabaseAdmin
          .from('society_members')
          .select('auth_user_id, name, phone_number')
          .eq('society_id', period.society_id)
          .in('auth_user_id', memberAuthUserIds)
      : { data: [], error: null };

  if (membersError) {
    return res.status(500).json({ error: membersError.message });
  }

  const memberByAuthUserId = new Map((members || []).map((m) => [m.auth_user_id, m]));
  const submitter = memberByAuthUserId.get(transaction.submitted_by);
  const verifier = transaction.verified_by ? memberByAuthUserId.get(transaction.verified_by) : null;

  res.json({
    status: statusLabel,
    rejectionReason: transaction.processing_status === 'Rejected' ? transaction.rejection_reason || null : null,
    paymentMode: transaction.payment_mode,
    refNo: transaction.utr_number || null,
    residentName: submitter?.name || house.owner_name || 'Resident',
    residentMobile: submitter?.phone_number || null,
    houseNumber: house.house_number,
    societyName: society?.name || '',
    periodMonth: period.period_month,
    amount: primary.amount_allocated,
    date: transaction.txn_date || transaction.verified_at || transaction.created_at,
    receivedBy: transaction.processing_status === 'Verified' ? verifier?.name || null : null,
  });
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
