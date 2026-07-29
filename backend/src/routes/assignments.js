const express = require('express');
const authenticate = require('../middleware/authenticate');
const supabaseAdmin = require('../config/supabaseAdmin');

const router = express.Router();

const PG_UNIQUE_VIOLATION = '23505';
const RELATIONSHIP_TYPES = ['Owner', 'Tenant', 'Occupant'];

// Same explicit-check-on-top-of-RLS pattern as members.js/society.js/
// transactions.js.
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

async function getHouse(supabase, houseId) {
  const { data, error } = await supabase.from('houses').select('id, society_id').eq('id', houseId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function getActiveMemberCheck(supabase, memberId) {
  const { data, error } = await supabase.from('society_members').select('id, society_id, status').eq('id', memberId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// A Pending or Active row already claims this exact (member, house) pair -
// the partial unique index only blocks a second *Active* one, so a
// duplicate Pending request needs its own app-layer check.
async function hasExistingAssignment(supabase, societyMemberId, houseId, excludeId) {
  let query = supabase
    .from('resident_house_assignments')
    .select('id')
    .eq('society_member_id', societyMemberId)
    .eq('house_id', houseId)
    .in('status', ['Pending', 'Active']);
  if (excludeId) query = query.neq('id', excludeId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data || []).length > 0;
}

// Shared by approve/revoke/reassign, mirroring loadTransactionAndCheckAdmin
// in transactions.js and loadMemberAndCheckAdmin in members.js.
// resident_house_assignments has no society_id column of its own - it's
// derived through house_id -> houses.society_id, so the admin check needs
// that embed first.
async function loadAssignmentAndCheckAdmin(supabase, userId, assignmentId) {
  const { data: assignment, error } = await supabase
    .from('resident_house_assignments')
    .select('id, society_member_id, house_id, status, relationship_type, approved_by, approved_at, houses(society_id)')
    .eq('id', assignmentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!assignment) {
    return { assignment: null, isAdmin: false, societyId: null };
  }
  const societyId = assignment.houses?.society_id;
  const isAdmin = await requireActiveAdmin(supabase, userId, societyId);
  return { assignment, isAdmin, societyId };
}

// GET /assignments - Admin or Committee (of at least one Active
// membership) lists every house assignment across every society they
// administer/sit on committee of - including Pending and Revoked ones, not
// just Active (an Admin needs to see Pending rows to approve them, and
// Revoked ones for history). Optional ?status= filter for a review-queue-
// style view (e.g. ?status=Pending). Each row includes the member's email
// (same one-listUsers-call pattern as GET /members - auth.users isn't
// part of the RLS-visible 'public' schema at all) and house number for
// display.
router.get('/', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { status } = req.query;

  if (status !== undefined && !['Pending', 'Active', 'Revoked'].includes(status)) {
    return res.status(400).json({ error: 'status filter must be one of Pending, Active, Revoked.' });
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
    return res.status(403).json({ error: 'Only an Admin or Committee member can list house assignments.' });
  }

  const { data: houses, error: housesError } = await supabase.from('houses').select('id').in('society_id', societyIds);
  if (housesError) {
    return res.status(500).json({ error: housesError.message });
  }
  const houseIds = (houses || []).map((h) => h.id);
  if (houseIds.length === 0) {
    return res.json([]);
  }

  let query = supabase
    .from('resident_house_assignments')
    .select(
      'id, society_member_id, house_id, status, relationship_type, approved_by, approved_at, created_at, houses(house_number), society_members(auth_user_id, phone_number)'
    )
    .in('house_id', houseIds)
    .order('created_at', { ascending: false });
  if (status) {
    query = query.eq('status', status);
  }

  const { data: assignments, error: assignmentsError } = await query;
  if (assignmentsError) {
    return res.status(500).json({ error: assignmentsError.message });
  }

  const { data: usersPage, error: usersError } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (usersError) {
    return res.status(500).json({ error: usersError.message });
  }
  const emailById = new Map((usersPage?.users || []).map((u) => [u.id, u.email]));

  const result = (assignments || []).map((a) => ({
    id: a.id,
    societyMemberId: a.society_member_id,
    houseId: a.house_id,
    houseNumber: a.houses?.house_number,
    memberEmail: emailById.get(a.society_members?.auth_user_id) || null,
    memberPhoneNumber: a.society_members?.phone_number,
    status: a.status,
    relationshipType: a.relationship_type,
    approvedBy: a.approved_by,
    approvedAt: a.approved_at,
    createdAt: a.created_at,
  }));

  res.json(result);
});

// POST /assignments - Admin-only. Creates a new assignment as `Pending` -
// never directly `Active` (matches the schema's own default and the
// separate approved_by/approved_at fields, distinct from created_at,
// confirmed with the user before building this: a tentative record now,
// a deliberate /approve action later, e.g. while rental-agreement
// paperwork is still being verified).
router.post('/', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { society_id, society_member_id, house_id, relationship_type } = req.body || {};

  if (!society_id) {
    return res.status(400).json({ error: 'society_id is required.' });
  }
  if (!society_member_id) {
    return res.status(400).json({ error: 'society_member_id is required.' });
  }
  if (!house_id) {
    return res.status(400).json({ error: 'house_id is required.' });
  }
  if (relationship_type !== undefined && !RELATIONSHIP_TYPES.includes(relationship_type)) {
    return res.status(400).json({ error: `relationship_type must be one of ${RELATIONSHIP_TYPES.join(', ')}.` });
  }

  let callerIsAdmin;
  try {
    callerIsAdmin = await requireActiveAdmin(supabase, req.user.id, society_id);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!callerIsAdmin) {
    return res.status(403).json({ error: 'Only an Admin of this society can create a house assignment.' });
  }

  let house, member, duplicate;
  try {
    house = await getHouse(supabase, house_id);
    member = await getActiveMemberCheck(supabase, society_member_id);
    duplicate = house && member ? await hasExistingAssignment(supabase, society_member_id, house_id) : false;
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (!house) {
    return res.status(404).json({ error: 'House not found or not accessible.' });
  }
  if (house.society_id !== society_id) {
    return res.status(400).json({ error: 'house_id does not belong to society_id.' });
  }
  if (!member) {
    return res.status(404).json({ error: 'Society member not found or not accessible.' });
  }
  if (member.society_id !== society_id) {
    return res.status(400).json({ error: 'society_member_id does not belong to society_id.' });
  }
  if (member.status !== 'Active') {
    return res.status(400).json({ error: 'Cannot assign a house to a member who is not Active.' });
  }
  if (duplicate) {
    return res.status(409).json({ error: 'This member already has a Pending or Active assignment to this house.' });
  }

  const { data: created, error: createError } = await supabase
    .from('resident_house_assignments')
    .insert({
      society_member_id,
      house_id,
      relationship_type: relationship_type || 'Owner',
      status: 'Pending',
    })
    .select()
    .single();

  if (createError) {
    return res.status(500).json({ error: createError.message });
  }

  const { error: auditError } = await supabase.from('audit_events').insert({
    society_id,
    actor_user_id: req.user.id,
    entity_type: 'resident_house_assignment',
    entity_id: created.id,
    action: 'Created',
    metadata: { society_member_id, house_id, relationship_type: created.relationship_type },
  });

  if (auditError) {
    return res.status(500).json({
      error: `Assignment created but the audit log entry failed: ${auditError.message}`,
      assignment: created,
    });
  }

  res.status(201).json(created);
});

// POST /assignments/:id/approve - Admin-only. Pending -> Active only
// (409 otherwise - one-way transition, same shape as verify/reject and
// suspend/reactivate elsewhere in this codebase). Sets approved_by/
// approved_at to the caller/now.
router.post('/:id/approve', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id } = req.params;

  let assignment, isAdmin, societyId;
  try {
    ({ assignment, isAdmin, societyId } = await loadAssignmentAndCheckAdmin(supabase, req.user.id, id));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (!assignment) {
    return res.status(404).json({ error: 'Assignment not found or not accessible.' });
  }
  if (!isAdmin) {
    return res.status(403).json({ error: 'Only an Admin of this assignment\'s society can approve it.' });
  }
  if (assignment.status !== 'Pending') {
    return res.status(409).json({ error: `This assignment is "${assignment.status}", not Pending - nothing to approve.` });
  }

  const { data: updated, error: updateError } = await supabase
    .from('resident_house_assignments')
    .update({ status: 'Active', approved_by: req.user.id, approved_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .maybeSingle();

  if (updateError) {
    if (updateError.code === PG_UNIQUE_VIOLATION) {
      return res.status(409).json({ error: 'This member already has another active assignment to this house.' });
    }
    return res.status(500).json({ error: updateError.message });
  }

  const { error: auditError } = await supabase.from('audit_events').insert({
    society_id: societyId,
    actor_user_id: req.user.id,
    entity_type: 'resident_house_assignment',
    entity_id: id,
    action: 'Approved',
    metadata: {},
  });

  if (auditError) {
    return res.status(500).json({
      error: `Assignment approved but the audit log entry failed: ${auditError.message}`,
      assignment: updated,
    });
  }

  res.json(updated);
});

// POST /assignments/:id/revoke - Admin-only. Allowed from either Pending
// (cancelling a request that's no longer needed) or Active (the resident
// moved out, sold the house, tenancy ended, etc.) - 409 if already
// Revoked. Never touches approved_by/approved_at (kept as the historical
// record of who/when it *was* approved, if it was) - who revoked it and
// when lives in audit_events, same as every other status-transition
// action in this codebase.
router.post('/:id/revoke', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id } = req.params;

  let assignment, isAdmin, societyId;
  try {
    ({ assignment, isAdmin, societyId } = await loadAssignmentAndCheckAdmin(supabase, req.user.id, id));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (!assignment) {
    return res.status(404).json({ error: 'Assignment not found or not accessible.' });
  }
  if (!isAdmin) {
    return res.status(403).json({ error: 'Only an Admin of this assignment\'s society can revoke it.' });
  }
  if (assignment.status === 'Revoked') {
    return res.status(409).json({ error: 'This assignment is already Revoked.' });
  }

  const { data: updated, error: updateError } = await supabase
    .from('resident_house_assignments')
    .update({ status: 'Revoked' })
    .eq('id', id)
    .select()
    .maybeSingle();

  if (updateError) {
    return res.status(500).json({ error: updateError.message });
  }

  const { error: auditError } = await supabase.from('audit_events').insert({
    society_id: societyId,
    actor_user_id: req.user.id,
    entity_type: 'resident_house_assignment',
    entity_id: id,
    action: 'Revoked',
    metadata: { previousStatus: assignment.status },
  });

  if (auditError) {
    return res.status(500).json({
      error: `Assignment revoked but the audit log entry failed: ${auditError.message}`,
      assignment: updated,
    });
  }

  res.json(updated);
});

// POST /assignments/:id/reassign - Admin-only. Only from an Active
// assignment (409 otherwise) - conceptually "this specific link between a
// person and a house ends, a new one begins", which is what
// resident_house_assignments' own table comment says it exists to
// preserve ("preserves assignment history") - reassign therefore revokes
// the old row and inserts a brand-new one, rather than mutating house_id/
// society_member_id in place and losing that history. Unlike POST
// / above, the new row goes straight to Active (approved_by/approved_at
// set immediately) - reassign is itself the deliberate admin decision,
// there is no further tentative-review step implied the way a brand-new
// assignment request has.
router.post('/:id/reassign', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id } = req.params;
  const { house_id, society_member_id, relationship_type } = req.body || {};

  if (house_id === undefined && society_member_id === undefined && relationship_type === undefined) {
    return res.status(400).json({
      error: 'Provide at least one of house_id, society_member_id, or relationship_type - the new target for this assignment.',
    });
  }
  if (relationship_type !== undefined && !RELATIONSHIP_TYPES.includes(relationship_type)) {
    return res.status(400).json({ error: `relationship_type must be one of ${RELATIONSHIP_TYPES.join(', ')}.` });
  }

  let assignment, isAdmin, societyId;
  try {
    ({ assignment, isAdmin, societyId } = await loadAssignmentAndCheckAdmin(supabase, req.user.id, id));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (!assignment) {
    return res.status(404).json({ error: 'Assignment not found or not accessible.' });
  }
  if (!isAdmin) {
    return res.status(403).json({ error: 'Only an Admin of this assignment\'s society can reassign it.' });
  }
  if (assignment.status !== 'Active') {
    return res.status(409).json({ error: `This assignment is "${assignment.status}", not Active - only an Active assignment can be reassigned.` });
  }

  const targetHouseId = house_id !== undefined ? house_id : assignment.house_id;
  const targetMemberId = society_member_id !== undefined ? society_member_id : assignment.society_member_id;
  const targetRelationship = relationship_type !== undefined ? relationship_type : assignment.relationship_type;

  if (targetHouseId === assignment.house_id && targetMemberId === assignment.society_member_id && targetRelationship === assignment.relationship_type) {
    return res.status(400).json({ error: 'Nothing to reassign - the new values are identical to the current assignment.' });
  }

  let house, member, duplicate;
  try {
    house = house_id !== undefined ? await getHouse(supabase, targetHouseId) : { id: targetHouseId, society_id: societyId };
    member = society_member_id !== undefined ? await getActiveMemberCheck(supabase, targetMemberId) : { id: targetMemberId, society_id: societyId, status: 'Active' };
    duplicate = house && member ? await hasExistingAssignment(supabase, targetMemberId, targetHouseId, id) : false;
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (!house) {
    return res.status(404).json({ error: 'House not found or not accessible.' });
  }
  if (house.society_id !== societyId) {
    return res.status(400).json({ error: 'house_id does not belong to this assignment\'s society.' });
  }
  if (!member) {
    return res.status(404).json({ error: 'Society member not found or not accessible.' });
  }
  if (member.society_id !== societyId) {
    return res.status(400).json({ error: 'society_member_id does not belong to this assignment\'s society.' });
  }
  if (member.status !== 'Active') {
    return res.status(400).json({ error: 'Cannot reassign a house to a member who is not Active.' });
  }
  if (duplicate) {
    return res.status(409).json({ error: 'That member already has a Pending or Active assignment to that house.' });
  }

  const { error: revokeError } = await supabase.from('resident_house_assignments').update({ status: 'Revoked' }).eq('id', id);
  if (revokeError) {
    return res.status(500).json({ error: revokeError.message });
  }

  const { data: created, error: createError } = await supabase
    .from('resident_house_assignments')
    .insert({
      society_member_id: targetMemberId,
      house_id: targetHouseId,
      relationship_type: targetRelationship,
      status: 'Active',
      approved_by: req.user.id,
      approved_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (createError) {
    // Best-effort rollback - do not leave the old assignment stranded as
    // Revoked with nothing to replace it, the same accepted-gap category
    // (not a real DB transaction) as POST /transactions' insert+allocation
    // and POST /members' auth-user-created-but-membership-insert-failed
    // case.
    await supabase.from('resident_house_assignments').update({ status: 'Active' }).eq('id', id).catch(() => {});
    if (createError.code === PG_UNIQUE_VIOLATION) {
      return res.status(409).json({ error: 'That member already has another active assignment to that house.' });
    }
    return res.status(500).json({ error: createError.message });
  }

  const { error: auditError } = await supabase.from('audit_events').insert({
    society_id: societyId,
    actor_user_id: req.user.id,
    entity_type: 'resident_house_assignment',
    entity_id: created.id,
    action: 'Reassigned',
    metadata: {
      old_assignment_id: id,
      old_house_id: assignment.house_id,
      old_society_member_id: assignment.society_member_id,
      new_house_id: targetHouseId,
      new_society_member_id: targetMemberId,
      relationship_type: targetRelationship,
    },
  });

  if (auditError) {
    return res.status(500).json({
      error: `Assignment reassigned but the audit log entry failed: ${auditError.message}`,
      revokedAssignmentId: id,
      assignment: created,
    });
  }

  res.json({ revokedAssignmentId: id, assignment: created });
});

module.exports = router;
