const express = require('express');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

const PG_UNIQUE_VIOLATION = '23505';

// Permissive but real UPI VPA shape: <handle>@<psp>, e.g. society@okhdfcbank.
const UPI_VPA_PATTERN = /^[a-zA-Z0-9.\-_]{2,100}@[a-zA-Z0-9.\-]{2,100}$/;

// Same walk-forward-one-month helpers as routes/houses.js's own
// POST /:houseId/billing-periods and the auto-generation path in
// routes/transactions.js - duplicated locally rather than imported, since
// this codebase has no shared utils module yet. Kept behaviorally
// identical on purpose: whichever of the three call sites creates a period
// next continues the exact same unbroken monthly sequence for that house.
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

// Same reasoning as requireActiveAdmin above, widened to either capability -
// used by read-only routes that Committee members may also view (matching
// the "Committee can view, only Admin can act" split already established by
// GET /society itself).
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

// YYYY-MM, not a full date - the caller picks a month, not a day.
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

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

// GET /society/:id/billing-periods?month=YYYY-MM - Admin or Committee. The
// "view billing records for all houses for a month (select month)" gap
// from the workflow doc: GET /me's billingPeriods array already gives an
// Admin/Committee member every period for every house in their society,
// but with no way to narrow it down to one specific month - a real
// dashboard view ("show me July's billing across the whole society") had
// to filter that whole-history array client-side instead of asking the
// server for exactly what it wants. `month` is optional and defaults to
// the current calendar month, since that's the far more common case than
// an admin remembering to always pass one.
//
// A house with no billing period generated yet for the requested month
// simply does not appear in the results - this is a display of what
// exists, not a full house roster with gaps marked; the bulk
// POST /society/:id/billing-periods/generate-next-month above is the tool
// for actually creating what is missing.
router.get('/:id/billing-periods', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id: societyId } = req.params;
  const { month } = req.query;

  let callerAllowed;
  try {
    callerAllowed = await requireActiveAdminOrCommittee(supabase, req.user.id, societyId);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!callerAllowed) {
    return res.status(403).json({ error: 'Only an Admin or Committee member can view billing records for a society.' });
  }

  let targetMonth;
  if (month !== undefined) {
    if (typeof month !== 'string' || !MONTH_PATTERN.test(month)) {
      return res.status(400).json({ error: 'month must be in YYYY-MM format, e.g. 2026-07.' });
    }
    targetMonth = `${month}-01`;
  } else {
    targetMonth = toDateOnly(startOfCurrentMonthUtc());
  }

  const { data: periods, error: periodsError } = await supabase
    .from('billing_periods')
    .select('id, house_id, period_month, base_amount, amount_due, status, houses(house_number)')
    .eq('society_id', societyId)
    .eq('period_month', targetMonth)
    .order('house_id', { ascending: true });

  if (periodsError) {
    return res.status(500).json({ error: periodsError.message });
  }

  res.json({ month: targetMonth, periods });
});

// POST /society/:id/billing-periods/generate-next-month - Admin-only. The
// "create billing record for all houses (next month only)" bulk action from
// the workflow doc: runs the same one-month-forward logic as
// POST /houses/:houseId/billing-periods, individually, across every Active
// house in the society in one call, instead of an admin having to trigger
// it house-by-house every month.
//
// Deliberately reuses each house's own existing cursor (its own latest
// period + 1 month) rather than a single fixed calendar month applied to
// every house alike - a house that is already ahead (paid several months
// in advance) or behind (missed a run, or was created later than the
// others) always gets exactly its own next month, never a duplicate of
// what it already has and never a gap-creating jump past what it's missing.
// In the common case where every house is in sync, that still resolves to
// the same calendar month for all of them; it just does not assume that.
//
// A single bad/unconfigured house (no default_monthly_amount, or an
// unexpected insert failure) is recorded in `skipped` and does not abort
// the rest of the run - a batch of 50 houses should not fail entirely
// because one of them was never given a rate.
router.post('/:id/billing-periods/generate-next-month', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id: societyId } = req.params;

  let callerIsAdmin;
  try {
    callerIsAdmin = await requireActiveAdmin(supabase, req.user.id, societyId);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!callerIsAdmin) {
    return res.status(403).json({ error: 'Only an Admin of this society can generate billing periods.' });
  }

  const { data: houses, error: housesError } = await supabase
    .from('houses')
    .select('id, house_number, default_monthly_amount')
    .eq('society_id', societyId)
    .eq('status', 'Active');

  if (housesError) {
    return res.status(500).json({ error: housesError.message });
  }

  const created = [];
  const skipped = [];

  for (const house of houses || []) {
    if (!house.default_monthly_amount) {
      skipped.push({
        house_id: house.id,
        house_number: house.house_number,
        reason: 'No default_monthly_amount configured.',
      });
      continue;
    }

    const { data: existingPeriods, error: existingError } = await supabase
      .from('billing_periods')
      .select('period_month')
      .eq('house_id', house.id)
      .order('period_month', { ascending: false })
      .limit(1);

    if (existingError) {
      skipped.push({ house_id: house.id, house_number: house.house_number, reason: existingError.message });
      continue;
    }

    const cursorMonth = existingPeriods && existingPeriods.length > 0 ? existingPeriods[0].period_month : null;
    const nextMonthDate = toDateOnly(cursorMonth ? addMonths(cursorMonth, 1) : startOfCurrentMonthUtc());

    const { data: inserted, error: insertError } = await supabase
      .from('billing_periods')
      .insert({
        society_id: societyId,
        house_id: house.id,
        period_month: nextMonthDate,
        base_amount: house.default_monthly_amount,
        amount_due: house.default_monthly_amount,
        status: 'Open',
      })
      .select('id, period_month, base_amount, amount_due, status')
      .single();

    if (insertError) {
      skipped.push({
        house_id: house.id,
        house_number: house.house_number,
        reason:
          insertError.code === PG_UNIQUE_VIOLATION
            ? `Already has a billing period for ${nextMonthDate}.`
            : insertError.message,
      });
      continue;
    }

    created.push({ house_id: house.id, house_number: house.house_number, billing_period: inserted });
  }

  if (created.length > 0) {
    const { error: auditError } = await supabase.from('audit_events').insert({
      society_id: societyId,
      actor_user_id: req.user.id,
      entity_type: 'billing_period',
      entity_id: created[0].billing_period.id,
      action: 'Created',
      metadata: {
        bulk: true,
        houses_created: created.length,
        houses_skipped: skipped.length,
        created: created.map((c) => ({ house_id: c.house_id, period_month: c.billing_period.period_month })),
        skipped,
      },
    });

    if (auditError) {
      return res.status(500).json({
        error: `Billing periods created but the audit log entry failed: ${auditError.message}`,
        created,
        skipped,
      });
    }
  }

  res.json({ created, skipped });
});

module.exports = router;
