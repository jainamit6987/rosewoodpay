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
      'id, society_id, auth_user_id, is_admin, is_committee_member, status, phone_number, created_at, resident_house_assignments(status, relationship_type, houses(house_number))'
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
  const { society_id, email, password, phone_number, is_admin, is_committee_member } = req.body || {};

  if (!society_id) {
    return res.status(400).json({ error: 'society_id is required.' });
  }
  if (!email || typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
    return res.status(400).json({ error: 'A valid email is required.' });
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
    metadata: { email: normalizedEmail, is_admin: member.is_admin, is_committee_member: member.is_committee_member },
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

// PATCH /members/:id - Admin-only. Edits is_admin/is_committee_member/
// phone_number - never society_id (fixed at creation, moving societies is
// not a real operation) or status (use /suspend and /reactivate instead,
// for the same clear-audit-trail-via-dedicated-action reasoning as
// /transactions/:id/verify and /reject elsewhere in this codebase).
router.patch('/:id', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id } = req.params;
  const { is_admin, is_committee_member, phone_number } = req.body || {};

  if (is_admin === undefined && is_committee_member === undefined && phone_number === undefined) {
    return res.status(400).json({
      error: 'Provide at least one of is_admin, is_committee_member, or phone_number to update.',
    });
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

// POST /members/:id/suspend - Admin-only. Sets status='Suspended', which -
// since 20260727000000_enforce_suspended_status_in_rls.sql - genuinely
// revokes everything: admin/committee powers via the two helper
// functions, and the member's own resident actions (submit payments, view
// dues/houses/assignments) via the direct policies that migration also
// updated. An Admin can never suspend themselves (checked below, before
// the update happens - requireActiveAdmin above still sees them as
// Active at that point) - the only way out of a self-suspend attempt is
// asking a different Admin, which is exactly the point.
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

  const { data: updated, error: updateError } = await supabase
    .from('society_members')
    .update({ status: 'Suspended' })
    .eq('id', id)
    .select()
    .single();

  if (updateError) {
    return res.status(500).json({ error: updateError.message });
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

// POST /members/:id/reactivate - Admin-only. Sets status='Active',
// restoring everything /suspend above revoked. No self-check needed here
// symmetrically to /suspend: a Suspended Admin has already lost is_admin
// visibility via requireActiveAdmin (their own status is no longer
// 'Active'), so they can never reach isAdmin=true to reactivate
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
