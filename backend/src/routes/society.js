const express = require('express');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

// Permissive but real UPI VPA shape: <handle>@<psp>, e.g. society@okhdfcbank.
const UPI_VPA_PATTERN = /^[a-zA-Z0-9.\-_]{2,100}@[a-zA-Z0-9.\-]{2,100}$/;

// Intl.supportedValuesOf('timeZone') looked like the obvious way to
// validate this, but this Node build's bundled ICU data enumerates only
// the legacy alias 'Asia/Calcutta', not the modern canonical
// 'Asia/Kolkata' this schema actually defaults to - it would have rejected
// the column's own DEFAULT value. Constructing a real Intl.DateTimeFormat
// resolves IANA aliases properly instead of relying on that incomplete
// enumeration, and throws RangeError for anything not a real zone.
function isValidTimeZone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// Same explicit-check-on-top-of-RLS pattern as members.js/transactions.js -
// status='Active' is checked explicitly because this reads the caller's OWN
// society_members row, which the deliberately ungated "Users can view their
// own society_member record" policy always lets them see regardless of
// status (see 20260727000000_enforce_suspended_status_in_rls.sql).
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

// GET /society - Admin or Committee (of at least one Active membership)
// lists every society they administer/sit on committee of - in practice
// almost always exactly one, but this mirrors the same
// "aggregate across every society the caller has a role in" shape as
// GET /members and GET /transactions/pending rather than assuming a
// single-society world. Deliberately excludes `status` ('Active'/
// 'Inactive') from being treated as meaningful here beyond display - it is
// not referenced by any RLS policy or backend route anywhere in this
// codebase today (checked before building this route), so surfacing it as
// editable would imply a real "deactivate this society" capability that
// does not actually exist yet. Building that for real would mean adding a
// societies.status check to every single admin/committee/resident policy
// in the schema - the same shape of change as
// 20260727000000_enforce_suspended_status_in_rls.sql, just with a much
// larger blast radius, and for a capability nobody has asked for yet -
// left for a future decision, not solved here.
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
    return res.status(403).json({ error: 'Only an Admin or Committee member can view society settings.' });
  }

  const { data: societies, error: societiesError } = await supabase
    .from('societies')
    .select('id, name, upi_vpa, upi_payee_name, timezone, status, created_at, updated_at')
    .in('id', societyIds)
    .order('name', { ascending: true });

  if (societiesError) {
    return res.status(500).json({ error: societiesError.message });
  }

  res.json(societies);
});

// PATCH /society/:id - Admin-only. Edits name/upi_vpa/upi_payee_name/
// timezone - never `status` (see the note above). upi_vpa in particular is
// the actual UPI ID every resident's payment gets sent to - validated for
// UPI's real <handle>@<psp> shape, not just "is a non-empty string", since
// a typo here silently misdirects real money for every resident until
// caught.
router.patch('/:id', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id } = req.params;
  const { name, upi_vpa, upi_payee_name, timezone } = req.body || {};

  if (name === undefined && upi_vpa === undefined && upi_payee_name === undefined && timezone === undefined) {
    return res.status(400).json({
      error: 'Provide at least one of name, upi_vpa, upi_payee_name, or timezone to update.',
    });
  }
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 150)) {
    return res.status(400).json({ error: 'name must be a non-empty string of at most 150 characters.' });
  }
  if (upi_vpa !== undefined && (typeof upi_vpa !== 'string' || !UPI_VPA_PATTERN.test(upi_vpa.trim()))) {
    return res.status(400).json({ error: 'upi_vpa must look like a real UPI ID, e.g. society@okhdfcbank.' });
  }
  if (upi_payee_name !== undefined && (typeof upi_payee_name !== 'string' || !upi_payee_name.trim() || upi_payee_name.length > 150)) {
    return res.status(400).json({ error: 'upi_payee_name must be a non-empty string of at most 150 characters.' });
  }
  if (timezone !== undefined && (typeof timezone !== 'string' || !isValidTimeZone(timezone))) {
    return res.status(400).json({ error: 'timezone must be a valid IANA time zone name, e.g. Asia/Kolkata.' });
  }

  let callerIsAdmin;
  try {
    callerIsAdmin = await requireActiveAdmin(supabase, req.user.id, id);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!callerIsAdmin) {
    return res.status(403).json({ error: 'Only an Admin of this society can edit its settings.' });
  }

  const updates = { updated_at: new Date().toISOString() };
  if (name !== undefined) updates.name = name.trim();
  if (upi_vpa !== undefined) updates.upi_vpa = upi_vpa.trim();
  if (upi_payee_name !== undefined) updates.upi_payee_name = upi_payee_name.trim();
  if (timezone !== undefined) updates.timezone = timezone;

  const { data: updated, error: updateError } = await supabase
    .from('societies')
    .update(updates)
    .eq('id', id)
    .select('id, name, upi_vpa, upi_payee_name, timezone, status, created_at, updated_at')
    .maybeSingle();

  if (updateError) {
    return res.status(500).json({ error: updateError.message });
  }
  if (!updated) {
    return res.status(404).json({ error: 'Society not found or not accessible.' });
  }

  const { error: auditError } = await supabase.from('audit_events').insert({
    society_id: id,
    actor_user_id: req.user.id,
    entity_type: 'society',
    entity_id: id,
    action: 'Updated',
    metadata: { changes: updates },
  });

  if (auditError) {
    return res.status(500).json({
      error: `Society settings updated but the audit log entry failed: ${auditError.message}`,
      society: updated,
    });
  }

  res.json(updated);
});

module.exports = router;
