const express = require('express');
const crypto = require('crypto');
const authenticate = require('../middleware/authenticate');
const supabaseAdmin = require('../config/supabaseAdmin');

const router = express.Router();

const PG_UNIQUE_VIOLATION = '23505';
// Mirrors chk_phone_number_format from
// 20260725010000_add_phone_number_to_society_members.sql exactly.
const PHONE_NUMBER_PATTERN = /^[0-9+\-\s()]{7,20}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SEARCH_RESULTS = 5;
// ~100 years - Supabase's ban API takes a duration, not a true "forever";
// this is the same "may as well be permanent, but stays reversible via
// /reactivate's own updateUserById(..., { ban_duration: 'none' }) call"
// convention several other projects using this same API use, since there
// is no dedicated "disable this login" flag distinct from a timed ban.
const PERMANENT_BAN_DURATION = '876000h';

// Not a real invite email - there is no SMTP configured anywhere in this
// app - just a password the Admin creating the account can hand to the
// new member directly (in person/over a call), returned once in the
// create response and never stored or logged anywhere else.
function generateTemporaryPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
}

// Confirms the caller is an Active Admin of target_society_id, via the
// caller's own req-scoped client - same explicit-check-on-top-of-RLS
// pattern used throughout transactions.js. status='Active' must be
// checked explicitly here, not left to RLS alone: this query reads the
// caller's OWN row, which the deliberately ungated "Users can view their
// own society_member record" policy always lets them see regardless of
// status, so a Suspended admin could otherwise still pass this check -
// see 20260727000000_enforce_suspended_status_in_rls.sql's closing note.
async function requireActiveAdmin(supabase, userId, societyId) {
  const { data, error } = await supabase
    .from('society_members')
    .select('id')
    .eq('society_id', societyId)
    .eq('auth_user_id', userId)
    .eq('is_admin', true)
    .eq('status', 'Active')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}

// Same reasoning as requireActiveAdmin above, widened to either capability -
// same shape as society.js's own requireActiveAdminOrCommittee, for the one
// read-only route below (GET /:id) that Committee members may also view,
// matching the "Committee can view, only Admin can act" split already
// established there and on GET /'s own listing above.
async function requireActiveAdminOrCommittee(supabase, userId, societyId) {
  const { data, error } = await supabase
    .from('society_members')
    .select('id')
    .eq('society_id', societyId)
    .eq('auth_user_id', userId)
    .eq('status', 'Active')
    .or('is_admin.eq.true,is_committee_member.eq.true')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}

// GET /members - Admin or Committee (of at least one Active membership)
// lists every member across every society the caller administers or sits
// on the committee of - including Suspended/Invited ones, since an Admin
// needs to see a Suspended member in order to reactivate them. Each row
// includes its email (auth.users is not part of the RLS-visible 'public'
// schema at all, so this needs the Admin API - one listUsers call covers
// every member below, not one round trip per row) and its currently
// Active house assignment(s), if any, purely for display context.
router.get('/', authenticate, async (req, res) => {
  const supabase = req.supabase;

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
    return res.status(403).json({ error: 'Only an Admin or Committee member can list society members.' });
  }

  const { data: members, error: membersError } = await supabase
    .from('society_members')
    .select(
      'id, society_id, auth_user_id, name, is_admin, is_committee_member, status, phone_number, created_at, resident_house_assignments(status, relationship_type, houses(house_number))'
    )
    .in('society_id', societyIds)
    .order('created_at', { ascending: true });

  if (membersError) {
    return res.status(500).json({ error: membersError.message });
  }

  const { data: usersPage, error: usersError } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (usersError) {
    return res.status(500).json({ error: usersError.message });
  }
  const emailById = new Map((usersPage?.users || []).map((u) => [u.id, u.email]));

  const result = (members || []).map((member) => ({
    id: member.id,
    societyId: member.society_id,
    name: member.name,
    email: emailById.get(member.auth_user_id) || null,
    isAdmin: member.is_admin,
    isCommitteeMember: member.is_committee_member,
    status: member.status,
    phoneNumber: member.phone_number,
    createdAt: member.created_at,
    houses: (member.resident_house_assignments || [])
      .filter((a) => a.status === 'Active')
      .map((a) => ({ houseNumber: a.houses?.house_number, relationshipType: a.relationship_type })),
  }));

  res.json(result);
});

// GET /members/search?q= - Admin or Committee, across every society they
// administer/sit on committee of. Matches name OR phone_number (not
// email - deliberately not part of this search per the user's own call;
// email is still returned on each result for display, just not something
// this can be searched by) - same "two independent ilike queries merged
// and deduped in JS, not one combined .or() string" shape as
// GET /houses/search, for the exact same reason: splicing an arbitrary
// admin-typed term into PostgREST's .or() risks breaking on a comma or
// parenthesis in that term. Capped at MAX_SEARCH_RESULTS regardless of
// match count; an empty/missing q returns [], never "everyone" - the same
// scale reasoning as houses/search (a real society can have well over a
// hundred members).
//
// Registered before GET /:id below - Express matches routes in
// registration order and /:id would otherwise swallow a literal
// "/members/search" request as id="search".
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
    return res.status(403).json({ error: 'Only an Admin or Committee member can search members.' });
  }

  const memberFields = 'id, society_id, auth_user_id, name, is_admin, is_committee_member, status, phone_number, created_at';
  const [byName, byPhone] = await Promise.all([
    supabase
      .from('society_members')
      .select(memberFields)
      .in('society_id', societyIds)
      .ilike('name', `%${q}%`)
      .limit(MAX_SEARCH_RESULTS),
    supabase
      .from('society_members')
      .select(memberFields)
      .in('society_id', societyIds)
      .ilike('phone_number', `%${q}%`)
      .limit(MAX_SEARCH_RESULTS),
  ]);

  if (byName.error) {
    return res.status(500).json({ error: byName.error.message });
  }
  if (byPhone.error) {
    return res.status(500).json({ error: byPhone.error.message });
  }

  const memberById = new Map();
  for (const member of [...(byName.data || []), ...(byPhone.data || [])]) {
    memberById.set(member.id, member);
  }

  const matched = [...memberById.values()]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, MAX_SEARCH_RESULTS);

  const { data: usersPage, error: usersError } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (usersError) {
    return res.status(500).json({ error: usersError.message });
  }
  const emailById = new Map((usersPage?.users || []).map((u) => [u.id, u.email]));

  res.json(
    matched.map((member) => ({
      id: member.id,
      societyId: member.society_id,
      name: member.name,
      email: emailById.get(member.auth_user_id) || null,
      isAdmin: member.is_admin,
      isCommitteeMember: member.is_committee_member,
      status: member.status,
      phoneNumber: member.phone_number,
      createdAt: member.created_at,
    }))
  );
});

// GET /members/:id - Admin or Committee of that member's own society. The
// single-member counterpart to the list above, for the new Member Detail
// screen (reached either from the Members directory's search results or
// from a House Dashboard resident card) - that screen does its own live
// fetch rather than trusting a possibly-stale object handed to it by
// whichever screen navigated here, same "the detail screen is the source
// of truth, not its caller" precedent as HouseDashboardScreen's own
// GET /houses/:houseId/dashboard. Returns every house assignment
// (Active/Pending/Revoked), not just Active - useful history context on a
// detail view, unlike the list endpoint above which only ever needed the
// current Active one(s) for a compact row.
router.get('/:id', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id } = req.params;

  const { data: member, error: memberError } = await supabase
    .from('society_members')
    .select(
      'id, society_id, auth_user_id, name, is_admin, is_committee_member, status, phone_number, created_at, resident_house_assignments(id, status, relationship_type, created_at, houses(id, house_number))'
    )
    .eq('id', id)
    .maybeSingle();

  if (memberError) {
    return res.status(500).json({ error: memberError.message });
  }
  if (!member) {
    return res.status(404).json({ error: 'Member not found or not accessible.' });
  }

  let callerAllowed;
  try {
    callerAllowed = await requireActiveAdminOrCommittee(supabase, req.user.id, member.society_id);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!callerAllowed) {
    return res.status(403).json({ error: "Only an Admin or Committee member of this member's society can view them." });
  }

  const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(member.auth_user_id);
  if (userError) {
    return res.status(500).json({ error: userError.message });
  }

  res.json({
    id: member.id,
    societyId: member.society_id,
    name: member.name,
    email: userData?.user?.email || null,
    isAdmin: member.is_admin,
    isCommitteeMember: member.is_committee_member,
    status: member.status,
    phoneNumber: member.phone_number,
    createdAt: member.created_at,
    assignments: (member.resident_house_assignments || [])
      .map((a) => ({
        id: a.id,
        houseId: a.houses?.id,
        houseNumber: a.houses?.house_number,
        relationshipType: a.relationship_type,
        status: a.status,
        createdAt: a.created_at,
      }))
      .sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt)),
  });
});

// POST /members - Admin-only. Creates a brand-new auth.users account (the
// Admin API is the only way to do this - it is not a 'public' schema
// table RLS has any say over) plus the society_members row linking it to
// society_id. Deliberately does NOT also create a
// resident_house_assignments row - discussed with the user before
// building this: house-linking (e.g. for a new tenant) stays a separate,
// not-yet-built action for now (manual SQL, or the Assignments-management
// feature whenever that gets built), so this stays "get them into the
// system with login credentials", nothing more.
router.post('/', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { society_id, email, password, name, phone_number, is_admin, is_committee_member } = req.body || {};

  if (!society_id) {
    return res.status(400).json({ error: 'society_id is required.' });
  }
  if (!email || typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'A non-empty name is required.' });
  }
  if (password !== undefined && (typeof password !== 'string' || password.length < 6)) {
    return res.status(400).json({ error: 'password, if provided, must be at least 6 characters.' });
  }
  if (phone_number !== undefined && phone_number !== null && !PHONE_NUMBER_PATTERN.test(phone_number)) {
    return res.status(400).json({
      error: 'phone_number must be 7-20 characters of digits, spaces, +, -, or parentheses.',
    });
  }
  if (is_admin !== undefined && typeof is_admin !== 'boolean') {
    return res.status(400).json({ error: 'is_admin must be a boolean.' });
  }
  if (is_committee_member !== undefined && typeof is_committee_member !== 'boolean') {
    return res.status(400).json({ error: 'is_committee_member must be a boolean.' });
  }

  let callerIsAdmin;
  try {
    callerIsAdmin = await requireActiveAdmin(supabase, req.user.id, society_id);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!callerIsAdmin) {
    return res.status(403).json({ error: 'Only an Admin of this society can create a member.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const isGeneratedPassword = password === undefined;
  const finalPassword = password || generateTemporaryPassword();

  const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email: normalizedEmail,
    password: finalPassword,
    email_confirm: true,
  });

  if (createError) {
    if (/already.*(registered|exists)/i.test(createError.message || '')) {
      return res.status(409).json({
        error:
          'A user with this email already exists. Linking an existing account into a new society is not supported yet - use a different email, or handle this one manually for now.',
      });
    }
    return res.status(500).json({ error: createError.message });
  }

  const newAuthUserId = created.user.id;

  const { data: member, error: memberError } = await supabase
    .from('society_members')
    .insert({
      society_id,
      auth_user_id: newAuthUserId,
      name: name.trim(),
      is_admin: is_admin === true,
      is_committee_member: is_committee_member === true,
      status: 'Active',
      phone_number: phone_number || null,
    })
    .select()
    .single();

  if (memberError) {
    // Best-effort cleanup - do not leave an orphaned login with a real
    // password and no society_members row to do anything with. Not one
    // atomic DB transaction (same accepted-gap category as
    // POST /transactions' insert+allocation) - the Admin Auth API and
    // PostgREST are two separate systems with no shared transaction
    // boundary to begin with.
    await supabaseAdmin.auth.admin.deleteUser(newAuthUserId).catch(() => {});
    if (memberError.code === PG_UNIQUE_VIOLATION) {
      return res.status(409).json({ error: 'This account is already a member of this society.' });
    }
    return res.status(500).json({ error: memberError.message });
  }

  const { error: auditError } = await supabase.from('audit_events').insert({
    society_id,
    actor_user_id: req.user.id,
    entity_type: 'society_member',
    entity_id: member.id,
    action: 'Created',
    metadata: {
      email: normalizedEmail,
      name: member.name,
      is_admin: member.is_admin,
      is_committee_member: member.is_committee_member,
    },
  });

  if (auditError) {
    return res.status(500).json({
      error: `Member created but the audit log entry failed: ${auditError.message}`,
      member: { ...member, email: normalizedEmail },
    });
  }

  const response = { ...member, email: normalizedEmail };
  if (isGeneratedPassword) {
    // Only ever returned here, once - not persisted or logged anywhere.
    response.temporaryPassword = finalPassword;
  }

  res.status(201).json(response);
});

// PATCH /members/:id - Admin-only. Edits name/is_admin/is_committee_member/
// phone_number - never society_id (fixed at creation, moving societies is
// not a real operation) or status (use /suspend and /reactivate instead,
// for the same clear-audit-trail-via-dedicated-action reasoning as
// /transactions/:id/verify and /reject elsewhere in this codebase).
router.patch('/:id', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id } = req.params;
  const { name, is_admin, is_committee_member, phone_number } = req.body || {};

  if (name === undefined && is_admin === undefined && is_committee_member === undefined && phone_number === undefined) {
    return res.status(400).json({
      error: 'Provide at least one of name, is_admin, is_committee_member, or phone_number to update.',
    });
  }
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ error: 'name, if provided, must be a non-empty string.' });
  }
  if (is_admin !== undefined && typeof is_admin !== 'boolean') {
    return res.status(400).json({ error: 'is_admin must be a boolean.' });
  }
  if (is_committee_member !== undefined && typeof is_committee_member !== 'boolean') {
    return res.status(400).json({ error: 'is_committee_member must be a boolean.' });
  }
  if (phone_number !== undefined && phone_number !== null && !PHONE_NUMBER_PATTERN.test(phone_number)) {
    return res.status(400).json({
      error: 'phone_number must be 7-20 characters of digits, spaces, +, -, or parentheses.',
    });
  }

  const { data: target, error: targetError } = await supabase
    .from('society_members')
    .select('id, society_id, auth_user_id')
    .eq('id', id)
    .maybeSingle();

  if (targetError) {
    return res.status(500).json({ error: targetError.message });
  }
  if (!target) {
    return res.status(404).json({ error: 'Member not found or not accessible.' });
  }

  let callerIsAdmin;
  try {
    callerIsAdmin = await requireActiveAdmin(supabase, req.user.id, target.society_id);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!callerIsAdmin) {
    return res.status(403).json({ error: "Only an Admin of this member's society can edit them." });
  }

  // Checked before is_admin is still true on the caller's own row above,
  // not after - an Admin removing their own last line of admin access
  // needs a different Admin to do it, not themselves.
  if (target.auth_user_id === req.user.id && is_admin === false) {
    return res.status(400).json({ error: 'You cannot remove your own admin access. Ask another Admin to do this.' });
  }

  const updates = {};
  if (name !== undefined) updates.name = name.trim();
  if (is_admin !== undefined) updates.is_admin = is_admin;
  if (is_committee_member !== undefined) updates.is_committee_member = is_committee_member;
  if (phone_number !== undefined) updates.phone_number = phone_number;

  const { data: updated, error: updateError } = await supabase
    .from('society_members')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (updateError) {
    return res.status(500).json({ error: updateError.message });
  }

  const { error: auditError } = await supabase.from('audit_events').insert({
    society_id: target.society_id,
    actor_user_id: req.user.id,
    entity_type: 'society_member',
    entity_id: id,
    action: 'Updated',
    metadata: { changes: updates },
  });

  if (auditError) {
    return res.status(500).json({
      error: `Member updated but the audit log entry failed: ${auditError.message}`,
      member: updated,
    });
  }

  res.json(updated);
});

// Shared by /suspend and /reactivate below, mirroring
// loadTransactionAndCheckAdmin in transactions.js.
async function loadMemberAndCheckAdmin(supabase, userId, memberId) {
  const { data: member, error: memberError } = await supabase
    .from('society_members')
    .select('id, society_id, auth_user_id, status')
    .eq('id', memberId)
    .maybeSingle();

  if (memberError) throw new Error(memberError.message);
  if (!member) return { member: null, isAdmin: false };

  const isAdmin = await requireActiveAdmin(supabase, userId, member.society_id);
  return { member, isAdmin };
}

// Suspend's own precondition (see the House Dashboard Edit-mode delete/
// add-linkage work and its "Owner links are structurally permanent,
// Tenant/Occupant come and go" rule, discussed with the user before
// building this): a house's *housing* situation must already be sorted
// out through that dedicated flow before an account gets suspended here -
// this endpoint deliberately does not try to cascade-revoke anything
// itself. Named houses in the 400 below so the Admin knows exactly what
// to go fix first, rather than a bare "can't do this".
async function getActiveAssignmentHouses(supabase, societyMemberId) {
  const { data, error } = await supabase
    .from('resident_house_assignments')
    .select('relationship_type, houses(house_number)')
    .eq('society_member_id', societyMemberId)
    .eq('status', 'Active');
  if (error) throw new Error(error.message);
  return (data || []).map((a) => `${a.houses?.house_number} (${a.relationship_type})`);
}

// POST /members/:id/suspend - Admin-only. Sets status='Suspended', which -
// since 20260727000000_enforce_suspended_status_in_rls.sql - already
// revokes every in-app capability: admin/committee powers via the two
// helper functions, and the member's own resident actions (submit
// payments, view dues/houses/assignments) via the direct policies that
// migration also updated. On top of that, this also now actually bans the
// underlying Supabase auth account (ban_duration below) so the sign-in
// attempt itself fails on LoginScreen, rather than succeeding into an app
// that then denies everything - a real, user-requested strengthening
// over the RLS-only lockout this endpoint used to rely on exclusively.
//
// Blocked (400) if the member still holds any Active house assignment -
// Owner or Tenant/Occupant - forcing that to be dealt with first via the
// House Dashboard's own Edit mode (revoke the tenant, or add a
// replacement owner and remove this one). Deliberately not a cascading
// revoke here: an Owner's link is a legal fact about the house, unaffected
// by whether their login is disabled, so this endpoint has no business
// silently touching it - see the House Dashboard resident-card redesign
// work for where that lives instead.
//
// An Admin can never suspend themselves (checked below, before the update
// happens - requireActiveAdmin above still sees them as Active at that
// point) - the only way out of a self-suspend attempt is asking a
// different Admin, which is exactly the point.
router.post('/:id/suspend', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id } = req.params;

  let member, isAdmin;
  try {
    ({ member, isAdmin } = await loadMemberAndCheckAdmin(supabase, req.user.id, id));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (!member) {
    return res.status(404).json({ error: 'Member not found or not accessible.' });
  }
  if (!isAdmin) {
    return res.status(403).json({ error: "Only an Admin of this member's society can suspend them." });
  }
  if (member.auth_user_id === req.user.id) {
    return res.status(400).json({ error: 'You cannot suspend your own account. Ask another Admin to do this.' });
  }
  if (member.status === 'Suspended') {
    return res.status(409).json({ error: 'This member is already Suspended.' });
  }

  let activeHouses;
  try {
    activeHouses = await getActiveAssignmentHouses(supabase, member.id);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (activeHouses.length > 0) {
    return res.status(400).json({
      error: `This member still has an active house assignment (${activeHouses.join(', ')}) - remove or reassign it from that house's dashboard before suspending.`,
    });
  }

  const { data: updated, error: updateError } = await supabase
    .from('society_members')
    .update({ status: 'Suspended' })
    .eq('id', id)
    .select()
    .single();

  if (updateError) {
    return res.status(500).json({ error: updateError.message });
  }

  const { error: banError } = await supabaseAdmin.auth.admin.updateUserById(member.auth_user_id, {
    ban_duration: PERMANENT_BAN_DURATION,
  });
  if (banError) {
    return res.status(500).json({
      error: `Member suspended but disabling their login failed: ${banError.message}`,
      member: updated,
    });
  }

  const { error: auditError } = await supabase.from('audit_events').insert({
    society_id: member.society_id,
    actor_user_id: req.user.id,
    entity_type: 'society_member',
    entity_id: id,
    action: 'Suspended',
    metadata: { previousStatus: member.status },
  });

  if (auditError) {
    return res.status(500).json({
      error: `Member suspended but the audit log entry failed: ${auditError.message}`,
      member: updated,
    });
  }

  res.json(updated);
});

// POST /members/:id/reset-password - Admin-only. The "someone forgot their
// password and can't log in" recovery path - there is no email/SMTP
// provider configured in this project (see generateTemporaryPassword's own
// comment above), so a true self-service emailed reset link is not
// possible yet; this is the interim path an Admin uses instead, same
// "temp password handed over directly, shown once, never stored/logged"
// shape as POST /members' own account-creation flow. Deliberately allowed
// regardless of the target's status (including Suspended) - an Admin may
// reasonably want to line up a fresh password before reactivating someone,
// and a reset alone cannot itself restore a banned login; that still only
// happens via /reactivate. No self-reset block either, unlike /suspend -
// this can never lock the calling Admin themselves out (they keep their
// existing session either way), so there is nothing to protect against;
// see ChangePasswordScreen.js/AuthContext.changePassword for the separate
// self-service flow an Admin would actually use to change their OWN
// password on purpose.
router.post('/:id/reset-password', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id } = req.params;

  let member, isAdmin;
  try {
    ({ member, isAdmin } = await loadMemberAndCheckAdmin(supabase, req.user.id, id));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (!member) {
    return res.status(404).json({ error: 'Member not found or not accessible.' });
  }
  if (!isAdmin) {
    return res.status(403).json({ error: "Only an Admin of this member's society can reset their password." });
  }

  const newPassword = generateTemporaryPassword();
  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(member.auth_user_id, {
    password: newPassword,
  });
  if (updateError) {
    return res.status(500).json({ error: updateError.message });
  }

  const { error: auditError } = await supabase.from('audit_events').insert({
    society_id: member.society_id,
    actor_user_id: req.user.id,
    entity_type: 'society_member',
    entity_id: id,
    action: 'PasswordReset',
    metadata: {},
  });

  if (auditError) {
    return res.status(500).json({
      error: `Password was reset but the audit log entry failed: ${auditError.message}`,
      id: member.id,
      temporaryPassword: newPassword,
    });
  }

  res.json({ id: member.id, temporaryPassword: newPassword });
});

// POST /members/:id/reactivate - Admin-only. Sets status='Active' and lifts
// the auth ban /suspend above applied, restoring everything. No self-check
// needed here symmetrically to /suspend: a Suspended Admin has already
// lost is_admin visibility via requireActiveAdmin (their own status is no
// longer 'Active'), so they can never reach isAdmin=true to reactivate
// themselves in the first place - a different, still-Active Admin is
// required, exactly like /suspend intends.
router.post('/:id/reactivate', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id } = req.params;

  let member, isAdmin;
  try {
    ({ member, isAdmin } = await loadMemberAndCheckAdmin(supabase, req.user.id, id));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (!member) {
    return res.status(404).json({ error: 'Member not found or not accessible.' });
  }
  if (!isAdmin) {
    return res.status(403).json({ error: "Only an Admin of this member's society can reactivate them." });
  }
  if (member.status !== 'Suspended') {
    return res.status(409).json({
      error: `This member is currently "${member.status}", not Suspended - nothing to reactivate.`,
    });
  }

  const { data: updated, error: updateError } = await supabase
    .from('society_members')
    .update({ status: 'Active' })
    .eq('id', id)
    .select()
    .single();

  if (updateError) {
    return res.status(500).json({ error: updateError.message });
  }

  const { error: unbanError } = await supabaseAdmin.auth.admin.updateUserById(member.auth_user_id, {
    ban_duration: 'none',
  });
  if (unbanError) {
    return res.status(500).json({
      error: `Member reactivated but re-enabling their login failed: ${unbanError.message}`,
      member: updated,
    });
  }

  const { error: auditError } = await supabase.from('audit_events').insert({
    society_id: member.society_id,
    actor_user_id: req.user.id,
    entity_type: 'society_member',
    entity_id: id,
    action: 'Reactivated',
    metadata: {},
  });

  if (auditError) {
    return res.status(500).json({
      error: `Member reactivated but the audit log entry failed: ${auditError.message}`,
      member: updated,
    });
  }

  res.json(updated);
});

module.exports = router;
