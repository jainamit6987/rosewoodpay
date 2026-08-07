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

// Plain date-only string, used by the transaction report's own ?from=/?to=
// filter below - deliberately not a full ISO timestamp, since the caller
// is picking calendar days, not instants.
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Same pattern as routes/transactions.js's own UUID_PATTERN, duplicated
// locally for the same no-shared-utils-module reason as the date helpers
// above.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same PAYMENT_MODES split as routes/transactions.js - "Bank"/"Online" is
// every mode that eventually settles in the society's bank account
// (UPI/NEFT_IMPS/Cheque); Cash is the one mode that never touches it. Used
// by the Month-End Closing report below to split every Income/Expense
// figure into its own Bank vs Cash ledger.
const BANK_PAYMENT_MODES = ['UPI', 'NEFT_IMPS', 'Cheque'];

// Same PAYMENT_MODES list as routes/transactions.js's own validation -
// duplicated locally for the same no-shared-utils-module reason as the
// date helpers above. Used to validate the transaction report's ?mode=
// filter below.
const PAYMENT_MODES = ['UPI', 'Cash', 'NEFT_IMPS', 'Cheque'];

// One row per transaction_type in the Month-End Closing Income/Expense
// grid, in fixed display order. appliesTo controls which side(s) of the
// grid a type can ever have a non-zero figure on - Maintenance/WaterCharge
// are always Cr (income-only), Salary/UtilityBill are always Dr
// (expense-only), matching chk_direction_matches_type exactly. Other is the
// one row that genuinely appears on both sides (see transactions.direction)
// and is the only row with a description-grouped breakdown - discussed and
// confirmed with the user while designing this report: transparency for a
// report shared externally with every resident meant residents should be
// able to see exactly what a miscellaneous "Other" figure is actually made
// of, broken down by each exact-match transaction description.
const MONTH_END_CLOSING_ROW_DEFS = [
  { type: 'Maintenance', label: 'Maintenance', appliesTo: ['income'] },
  { type: 'WaterCharge', label: 'Water Charges', appliesTo: ['income'] },
  { type: 'UtilityBill', label: 'Utility Bills', appliesTo: ['expense'] },
  { type: 'Salary', label: 'Salary', appliesTo: ['expense'] },
  { type: 'Other', label: 'Other', appliesTo: ['income', 'expense'] },
];

// Paise-safe rounding for every derived Month-End Closing figure (sums of
// NUMERIC columns can arrive as JS floats with tiny binary rounding error,
// e.g. 0.1 + 0.2) - same underlying float concern as routes/transactions.js's
// own isWholeMultiple, just applied as a display-rounding step here instead
// of a whole-multiple check.
function round2(amount) {
  return Math.round(amount * 100) / 100;
}

// Builds the full Income/Expense grid (one row per MONTH_END_CLOSING_ROW_DEFS
// entry, each split Online vs Cash and Income vs Expense), the Other row's
// own description-grouped Income/Expense breakdowns ("if their description
// matches exactly then group, else no" - confirmed with the user, so the
// grouping key is the trimmed description string, nothing fuzzier), the
// grid's Totals row, the combined Overall Total (Online + Cash, both
// sides), and the Maintenance Online-vs-Cash collection breakup - from one
// flat array of this month's Verified transactions. Shared identically by
// GET (live preview) and POST (what actually gets saved) below, so the two
// can never silently drift apart.
function computeMonthEndClosingFigures(transactions) {
  const rows = MONTH_END_CLOSING_ROW_DEFS.map((def) => ({
    type: def.type,
    label: def.label,
    appliesTo: def.appliesTo,
    income: { online: 0, cash: 0 },
    expense: { online: 0, cash: 0 },
  }));
  const rowByType = new Map(rows.map((row) => [row.type, row]));

  const otherIncomeGroups = new Map();
  const otherExpenseGroups = new Map();

  for (const txn of transactions) {
    const row = rowByType.get(txn.transaction_type);
    if (!row) continue; // defensive only - chk_transaction_type guarantees this never happens

    const bucket = BANK_PAYMENT_MODES.includes(txn.payment_mode) ? 'online' : 'cash';
    const side = txn.direction === 'Cr' ? 'income' : 'expense';
    const amount = Number(txn.amount);
    row[side][bucket] += amount;

    if (txn.transaction_type === 'Other') {
      const groups = side === 'income' ? otherIncomeGroups : otherExpenseGroups;
      const key = (txn.description || '').trim();
      const group = groups.get(key) || { description: key, count: 0, online: 0, cash: 0 };
      group.count += 1;
      group[bucket] += amount;
      groups.set(key, group);
    }
  }

  for (const row of rows) {
    row.income.online = round2(row.income.online);
    row.income.cash = round2(row.income.cash);
    row.expense.online = round2(row.expense.online);
    row.expense.cash = round2(row.expense.cash);
  }

  const toBreakdownList = (groups) =>
    [...groups.values()]
      .map((group) => ({ ...group, online: round2(group.online), cash: round2(group.cash), total: round2(group.online + group.cash) }))
      .sort((a, b) => a.description.localeCompare(b.description));

  const otherRow = rowByType.get('Other');
  otherRow.incomeBreakdown = toBreakdownList(otherIncomeGroups);
  otherRow.expenseBreakdown = toBreakdownList(otherExpenseGroups);

  const totals = {
    income: {
      online: round2(rows.reduce((sum, row) => sum + row.income.online, 0)),
      cash: round2(rows.reduce((sum, row) => sum + row.income.cash, 0)),
    },
    expense: {
      online: round2(rows.reduce((sum, row) => sum + row.expense.online, 0)),
      cash: round2(rows.reduce((sum, row) => sum + row.expense.cash, 0)),
    },
  };

  const overallTotal = {
    income: round2(totals.income.online + totals.income.cash),
    expense: round2(totals.expense.online + totals.expense.cash),
  };

  const maintenanceRow = rowByType.get('Maintenance');
  const maintenanceBreakup = {
    online: maintenanceRow.income.online,
    cash: maintenanceRow.income.cash,
    total: round2(maintenanceRow.income.online + maintenanceRow.income.cash),
  };

  return { rows, totals, overallTotal, maintenanceBreakup };
}

// The Month-End Closing generation guard: counts every still-Submitted
// (unresolved) transaction in this society whose own date - txn_date if
// given, created_at otherwise, the same "prefer the resident-supplied date
// for display, fall back to a column that's always set" reasoning as every
// other date-sensitive report in this file - falls on or before the last
// day of the target month (`rangeEnd`, exclusive). Confirmed with the user:
// this replaces a simpler lock/no-lock flag entirely - generation itself
// stays freely re-runnable any number of times, but is blocked outright
// while anything that could still turn into a Verified transaction dated
// in-or-before this month remains sitting in the review queue.
async function countBlockingSubmittedTransactions(supabase, societyId, rangeEnd) {
  const { data: submitted, error } = await supabase
    .from('transactions')
    .select('id, txn_date, created_at')
    .eq('society_id', societyId)
    .eq('processing_status', 'Submitted');

  if (error) throw new Error(error.message);

  return (submitted || []).filter((txn) => {
    // txn_date is TIMESTAMPTZ, already a full ISO timestamp from Supabase
    // (e.g. "2026-02-10T00:00:00+00:00") - not a plain "YYYY-MM-DD" string,
    // so it must be parsed as-is rather than having a second time-of-day
    // suffix appended (which previously produced an invalid, always-false-
    // comparing Date).
    const cutoff = txn.txn_date ? new Date(txn.txn_date) : new Date(txn.created_at);
    return cutoff < rangeEnd;
  }).length;
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
//
// `house_id` is an optional second filter, added alongside the
// pendency-report endpoint below - independently useful on its own (e.g. "just
// C-303's June record" without pulling every house), not something invented
// only for that report.
router.get('/:id/billing-periods', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id: societyId } = req.params;
  const { month, house_id } = req.query;

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

  let query = supabase
    .from('billing_periods')
    .select('id, house_id, period_month, base_amount, amount_due, status, houses(house_number)')
    .eq('society_id', societyId)
    .eq('period_month', targetMonth)
    .order('house_id', { ascending: true });

  if (house_id !== undefined) {
    query = query.eq('house_id', house_id);
  }

  const { data: periods, error: periodsError } = await query;

  if (periodsError) {
    return res.status(500).json({ error: periodsError.message });
  }

  res.json({ month: targetMonth, periods });
});

// GET /society/:id/pendency-report?month=YYYY-MM&house_id=... - Admin or
// Committee (same view-only split as GET /society/:id/billing-periods
// above; the workflow doc's own row for this labels it "Admin", but every
// sibling "view ___" report in this codebase is Admin-or-Committee, and
// generating a report is a read, not an action - treated as the same
// pattern here rather than a narrower one-off).
//
// The S.No 25 gap: "generate pendency report for a month" - who still owes
// money, as of a given month. Deliberately NOT the same shape as the plain
// billing-periods-by-month view above: that endpoint is a flat "here are
// this month's rows" list, while a pendency report has to look backward
// too - the user's own framing driving this design: "mostly focus on
// current month but it should also highlight previous open periods as
// well". A house that is current on this month but still has an unpaid
// period from three months ago is exactly the case a flat single-month
// list would hide and this report exists to surface.
//
// For each house (optionally narrowed to one via ?house_id=), returns
// every still-Open billing period with period_month <= the target month,
// oldest-first, plus a totalOutstanding sum and an overdueMonths count
// (periods strictly BEFORE the target month - the arrears, not the current
// month's own due amount). A period *after* the target month (paid ahead
// of schedule) is deliberately excluded - it is not owed as of this
// month, so it is not pendency. A house with zero qualifying periods is
// omitted entirely - this is a "who owes" list, not a full house roster.
router.get('/:id/pendency-report', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id: societyId } = req.params;
  const { month, house_id } = req.query;

  let callerAllowed;
  try {
    callerAllowed = await requireActiveAdminOrCommittee(supabase, req.user.id, societyId);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!callerAllowed) {
    return res.status(403).json({ error: 'Only an Admin or Committee member can view the pendency report.' });
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

  let query = supabase
    .from('billing_periods')
    .select('id, house_id, period_month, base_amount, amount_due, status, houses(house_number)')
    .eq('society_id', societyId)
    .eq('status', 'Open')
    .lte('period_month', targetMonth)
    .order('house_id', { ascending: true })
    .order('period_month', { ascending: true });

  if (house_id !== undefined) {
    query = query.eq('house_id', house_id);
  }

  const { data: openPeriods, error: periodsError } = await query;

  if (periodsError) {
    return res.status(500).json({ error: periodsError.message });
  }

  const houseMap = new Map();
  for (const period of openPeriods || []) {
    if (!houseMap.has(period.house_id)) {
      houseMap.set(period.house_id, {
        house_id: period.house_id,
        house_number: period.houses?.house_number ?? null,
        openPeriods: [],
        totalOutstanding: 0,
        overdueMonths: 0,
      });
    }
    const entry = houseMap.get(period.house_id);
    entry.openPeriods.push({
      id: period.id,
      period_month: period.period_month,
      base_amount: period.base_amount,
      amount_due: period.amount_due,
      status: period.status,
    });
    entry.totalOutstanding += Number(period.amount_due);
    if (period.period_month < targetMonth) {
      entry.overdueMonths += 1;
    }
  }

  const houses = [...houseMap.values()].sort((a, b) => (a.house_number ?? '').localeCompare(b.house_number ?? ''));

  // Per-house "last payment" context for the report/export - added
  // alongside the still-owed columns above rather than a separate
  // endpoint, since the whole point of a shareable pendency report is
  // showing "here's what they owe" next to "here's what they last paid",
  // not just the former. Same txn_date-preferred-for-display/
  // verified_at-for-ordering logic as GET /me and the house dashboard (see
  // routes/houses.js's own note: txn_date is resident-supplied and
  // optional, so it is safe to display but not to sort/pick by). Only
  // fetched for houses actually in this report - a fully-paid house is
  // already omitted above and has no reason to pay for this extra query.
  const houseIds = houses.map((h) => h.house_id);
  if (houseIds.length > 0) {
    const { data: verifiedTxns, error: verifiedTxnsError } = await supabase
      .from('transactions')
      .select('house_id, amount, txn_date, verified_at, transaction_allocations(billing_periods(period_month))')
      .in('house_id', houseIds)
      .eq('processing_status', 'Verified')
      .order('verified_at', { ascending: false });

    if (verifiedTxnsError) {
      return res.status(500).json({ error: verifiedTxnsError.message });
    }

    // Reduce to the single most-recent Verified transaction per house (the
    // query above is already newest-first, so the first one seen per
    // house_id wins) - same "pick one row per group in JS" approach GET
    // /me already uses for the same reason (no clean "latest per group"
    // shortcut via PostgREST).
    const lastTxnByHouse = new Map();
    for (const txn of verifiedTxns || []) {
      if (!lastTxnByHouse.has(txn.house_id)) {
        lastTxnByHouse.set(txn.house_id, txn);
      }
    }

    for (const entry of houses) {
      const lastTxn = lastTxnByHouse.get(entry.house_id);
      if (!lastTxn) {
        entry.lastPayment = null;
        entry.lastPaidBillingPeriod = null;
        continue;
      }
      entry.lastPayment = { amount: lastTxn.amount, date: lastTxn.txn_date || lastTxn.verified_at };
      // "Last paid billing period" is the most recent month that last
      // payment actually covered - a single payment can cover more than
      // one month at once (FIFO allocation), so this takes the latest of
      // its own allocations rather than assuming exactly one.
      const coveredMonths = (lastTxn.transaction_allocations || [])
        .map((allocation) => allocation.billing_periods?.period_month)
        .filter(Boolean);
      entry.lastPaidBillingPeriod = coveredMonths.length > 0 ? coveredMonths.sort().at(-1) : null;
    }
  }

  res.json({ month: targetMonth, houses });
});

// Plain English month name lookup for the description this endpoint
// synthesizes for Maintenance rows (below) - not locale-aware on purpose,
// unlike the mobile client's own Intl.toLocaleDateString formatting, since
// this is a JSON API response, not something rendered for display
// directly; the mobile client is free to reformat the raw period_month
// values it also receives if it ever wants to.
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// period_month is a plain 'YYYY-MM-DD' date-only string - parsed as UTC
// parts directly (no Date object) to sidestep any timezone rollback, same
// reasoning as every other period_month display helper in this codebase.
function formatPeriodMonthLabel(periodMonth) {
  const [year, month] = periodMonth.split('-').map(Number);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

// GET /society/:id/transaction-report?month=YYYY-MM (or ?from=&to=, plus
// an optional &mode=) - Admin or Committee (same view-only split as every
// other report in this file). The "view transaction report at society
// level" ask: a flat, whole-society ledger for a chosen calendar month -
// every Verified transaction (money that actually moved, in either
// direction), not the full-history/any-status GET /transactions/report
// listing (that one is filterable but returns every processing_status,
// which is the wrong shape for a bookkeeping ledger someone reads
// month-by-month).
//
// ?from=/?to= (plain YYYY-MM-DD dates, each independently optional) let
// the caller narrow to an arbitrary custom range instead of a whole
// calendar month, and take precedence over ?month= whenever either is
// given - ?month= is only ever consulted when neither is present, so the
// default "no filter at all" behavior (current month) is unchanged.
// ?mode= (one of PAYMENT_MODES) is a separate, independent filter that
// ANDs with whichever date range is in effect.
//
// Filtered on verified_at, not the resident/Admin-supplied txn_date -
// same reasoning as GET /transactions/report's own from/to filter and
// the pendency-report's "last payment" lookup above: txn_date is
// optional and can be silently NULL, but every Verified row always has a
// verified_at (set the moment it becomes Verified, either via
// POST /:id/verify or immediately on insert for a society expense - see
// routes/transactions.js), so it is the one date guaranteed present for
// every row this report needs to include. txn_date, when present, is
// still what gets *displayed* as the transaction date below - it is only
// unsafe as a filter, not as a display value.
//
// Cr/Dr is read straight from transactions.direction (added in
// 20260807000000_add_direction_and_month_end_closing.sql), not inferred
// from transaction_type - Maintenance/WaterCharge are always Cr and
// Salary/UtilityBill are always Dr (enforced by chk_direction_matches_type
// underneath, the same split already established by the "two entirely
// separate paths" comment on POST / in routes/transactions.js), but Other
// can genuinely be either, which a type-only inference could never
// represent.
//
// description is synthesized rather than read from a column for
// Maintenance rows specifically: those never have transactions.description
// set (only society expenses require it - see the chk_description_required
// constraint), so this fills in "House <no> - <billing period(s)>" from
// the same house/allocation data the pendency report already embeds,
// covering the multiple-months-in-one-payment case as a comma-joined list.
// WaterCharge rows do carry a real (optional) description - since they are
// never allocated against any billing_period (deliberately pay-as-you-go,
// see 20260803000000_add_water_charge_transaction_type.sql) there is no
// period list to synthesize from, so this reads "House <no> - Water Charge"
// plus that description if one was given. Expense rows already carry a
// real, required description, used as-is.
router.get('/:id/transaction-report', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id: societyId } = req.params;
  const { month, from, to, mode } = req.query;

  let callerAllowed;
  try {
    callerAllowed = await requireActiveAdminOrCommittee(supabase, req.user.id, societyId);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!callerAllowed) {
    return res.status(403).json({ error: 'Only an Admin or Committee member can view the transaction report.' });
  }

  if (mode !== undefined && !PAYMENT_MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of: ${PAYMENT_MODES.join(', ')}.` });
  }

  let targetMonth;
  let rangeStart;
  let rangeEnd;
  if (from !== undefined || to !== undefined) {
    if (from !== undefined) {
      if (typeof from !== 'string' || !DATE_PATTERN.test(from) || Number.isNaN(Date.parse(`${from}T00:00:00.000Z`))) {
        return res.status(400).json({ error: 'from must be a valid date in YYYY-MM-DD format.' });
      }
      rangeStart = new Date(`${from}T00:00:00.000Z`);
    }
    if (to !== undefined) {
      if (typeof to !== 'string' || !DATE_PATTERN.test(to) || Number.isNaN(Date.parse(`${to}T00:00:00.000Z`))) {
        return res.status(400).json({ error: 'to must be a valid date in YYYY-MM-DD format.' });
      }
      // The upper bound applied to the query below is exclusive, so this
      // resolves to midnight the day *after* "to" - making "to" itself
      // inclusive, same reasoning as every other date-only range in this
      // codebase (e.g. this route's own month-derived rangeEnd).
      rangeEnd = new Date(Date.parse(`${to}T00:00:00.000Z`) + 24 * 60 * 60 * 1000);
    }
    if (rangeStart !== undefined && rangeEnd !== undefined && rangeStart >= rangeEnd) {
      return res.status(400).json({ error: 'from must be on or before to.' });
    }
  } else {
    if (month !== undefined) {
      if (typeof month !== 'string' || !MONTH_PATTERN.test(month)) {
        return res.status(400).json({ error: 'month must be in YYYY-MM format, e.g. 2026-07.' });
      }
      targetMonth = month;
    } else {
      const now = startOfCurrentMonthUtc();
      targetMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    }
    rangeStart = new Date(`${targetMonth}-01T00:00:00.000Z`);
    rangeEnd = addMonths(rangeStart, 1);
  }

  let query = supabase
    .from('transactions')
    .select(
      'id, house_id, amount, transaction_type, direction, utr_number, payment_mode, payee_name, description, txn_date, verified_at, houses(house_number), transaction_allocations(billing_periods(period_month))'
    )
    .eq('society_id', societyId)
    .eq('processing_status', 'Verified')
    .order('verified_at', { ascending: true });

  if (rangeStart !== undefined) query = query.gte('verified_at', rangeStart.toISOString());
  if (rangeEnd !== undefined) query = query.lt('verified_at', rangeEnd.toISOString());
  if (mode !== undefined) query = query.eq('payment_mode', mode);

  const { data: transactions, error: transactionsError } = await query;

  if (transactionsError) {
    return res.status(500).json({ error: transactionsError.message });
  }

  const rows = (transactions || []).map((txn) => {
    const isMaintenance = txn.transaction_type === 'Maintenance';
    const isWaterCharge = txn.transaction_type === 'WaterCharge';
    const houseLabel = txn.houses?.house_number ? `House ${txn.houses.house_number}` : 'House \u2014';
    let description;
    if (isMaintenance) {
      const coveredMonths = [
        ...new Set(
          (txn.transaction_allocations || [])
            .map((allocation) => allocation.billing_periods?.period_month)
            .filter(Boolean)
        ),
      ].sort();
      description =
        coveredMonths.length > 0
          ? `${houseLabel} - ${coveredMonths.map(formatPeriodMonthLabel).join(', ')}`
          : houseLabel;
    } else if (isWaterCharge) {
      description = txn.description ? `${houseLabel} - Water Charge (${txn.description})` : `${houseLabel} - Water Charge`;
    } else {
      description = txn.description || '\u2014';
    }

    return {
      id: txn.id,
      txn_date: txn.txn_date || txn.verified_at,
      utr_number: txn.utr_number,
      payment_mode: txn.payment_mode,
      transaction_type: txn.transaction_type,
      direction: txn.direction,
      amount: txn.amount,
      description,
    };
  });

  res.json({
    month: targetMonth || null,
    from: rangeStart ? toDateOnly(rangeStart) : null,
    to: rangeEnd ? toDateOnly(new Date(rangeEnd.getTime() - 24 * 60 * 60 * 1000)) : null,
    mode: mode || null,
    transactions: rows,
  });
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

// Known entity_type/action values actually written by this codebase today
// (see society.js/houses.js/transactions.js/assignments.js/members.js's own
// audit_events inserts). Unlike processing_status/transaction_type, neither
// column has a DB CHECK constraint backing it - audit_events.entity_type and
// .action are plain free-text VARCHAR(50) - so these lists exist purely to
// catch a typo'd filter value with a clear 400 rather than a silently-empty
// result, not to enforce a real schema rule. Keep manually in sync with any
// future audit_events.insert() call site.
const AUDIT_ENTITY_TYPES = ['society', 'billing_period', 'transaction', 'resident_house_assignment', 'society_member', 'month_closing'];
const AUDIT_ACTIONS = [
  'Created',
  'Updated',
  'Waived',
  'Verified',
  'Rejected',
  'Approved',
  'Revoked',
  'Reassigned',
  'Suspended',
  'Reactivated',
];

// GET /society/:id/audit-log?entity_type=&entity_id=&action=&actor_user_id=&from=&to=
// - Admin or Committee (same view-only split as every other report in this
// file). The S.No 30 gap: audit_events has been written to on every
// sensitive mutation since the very first migration (member
// create/suspend/reactivate, assignment create/approve/revoke/reassign,
// transaction verify/reject, billing period create/waive, society edit) but
// nothing had ever read it back - the table existed purely as a write-only
// side effect until now.
//
// All five filters are optional and combine as an AND, same pattern as
// GET /transactions/report. entity_type/entity_id together is how a caller
// looks up "the full history of this one record" (e.g. every event for one
// specific billing period); actor_user_id alone is "everything this admin
// has done"; from/to (on created_at, inclusive) is a date-range activity
// feed. No filters at all returns the whole society's log, newest first.
//
// No pagination, same accepted gap as every other listing endpoint in this
// codebase (GET /transactions/report, GET /houses/:houseId/transactions,
// etc.) - a real limitation for a table that only ever grows, but not one
// unique to this endpoint, and not fixed piecemeal here.
router.get('/:id/audit-log', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id: societyId } = req.params;
  const { entity_type, entity_id, action, actor_user_id, from, to } = req.query;

  if (entity_type !== undefined && !AUDIT_ENTITY_TYPES.includes(entity_type)) {
    return res.status(400).json({ error: `entity_type must be one of: ${AUDIT_ENTITY_TYPES.join(', ')}.` });
  }
  if (action !== undefined && !AUDIT_ACTIONS.includes(action)) {
    return res.status(400).json({ error: `action must be one of: ${AUDIT_ACTIONS.join(', ')}.` });
  }
  if (entity_id !== undefined && !UUID_PATTERN.test(entity_id)) {
    return res.status(400).json({ error: 'entity_id must be a valid UUID.' });
  }
  if (actor_user_id !== undefined && !UUID_PATTERN.test(actor_user_id)) {
    return res.status(400).json({ error: 'actor_user_id must be a valid UUID.' });
  }
  let fromIso;
  if (from !== undefined) {
    const parsed = new Date(from);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ error: 'from must be a valid date, e.g. 2026-07-01.' });
    }
    fromIso = parsed.toISOString();
  }
  let toIso;
  if (to !== undefined) {
    const parsed = new Date(to);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ error: 'to must be a valid date, e.g. 2026-07-31.' });
    }
    toIso = parsed.toISOString();
  }

  let callerAllowed;
  try {
    callerAllowed = await requireActiveAdminOrCommittee(supabase, req.user.id, societyId);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!callerAllowed) {
    return res.status(403).json({ error: 'Only an Admin or Committee member can view the audit log.' });
  }

  let query = supabase
    .from('audit_events')
    .select('id, actor_user_id, entity_type, entity_id, action, metadata, created_at')
    .eq('society_id', societyId)
    .order('created_at', { ascending: false });

  if (entity_type !== undefined) query = query.eq('entity_type', entity_type);
  if (entity_id !== undefined) query = query.eq('entity_id', entity_id);
  if (action !== undefined) query = query.eq('action', action);
  if (actor_user_id !== undefined) query = query.eq('actor_user_id', actor_user_id);
  if (fromIso !== undefined) query = query.gte('created_at', fromIso);
  if (toIso !== undefined) query = query.lte('created_at', toIso);

  const { data: events, error: eventsError } = await query;

  if (eventsError) {
    return res.status(500).json({ error: eventsError.message });
  }

  res.json(events);
});

// GET /society/:id/month-end-closing?month=YYYY-MM - the Month-End Closing
// report: Opening Balance -> Income/Expense grid (Bank vs Cash, one row per
// transaction type, Other broken down by exact-match description) ->
// Overall Total -> Closing Balance -> Maintenance Online-vs-Cash breakup.
//
// Access is deliberately asymmetric, confirmed with the user while
// designing this feature:
//   - Admin always gets a live-computed preview, even for a month that has
//     never been generated/saved yet, so they can see the numbers before
//     deciding to actually generate (and sees `guard` below so they know
//     up front whether generation is currently blocked).
//   - Committee only ever sees a month that has already been
//     generated/saved by an Admin (`generated: true`) - for a
//     not-yet-generated month, they get `generated: false` and nothing
//     else, never a live preview of unsaved numbers.
// Once a month IS generated, both roles see the exact same figures,
// computed the same way - Income/Expense is always recomputed live from
// this month's Verified transactions (deterministic - Verified rows are
// never edited after the fact), while Opening/Closing Balance uses the
// saved row's Admin-supplied opening balance rather than re-guessing it.
router.get('/:id/month-end-closing', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id: societyId } = req.params;
  const { month } = req.query;

  let callerIsAdmin;
  let callerIsAdminOrCommittee;
  try {
    callerIsAdmin = await requireActiveAdmin(supabase, req.user.id, societyId);
    callerIsAdminOrCommittee = callerIsAdmin || (await requireActiveAdminOrCommittee(supabase, req.user.id, societyId));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!callerIsAdminOrCommittee) {
    return res.status(403).json({ error: 'Only an Admin or Committee member can view the Month-End Closing report.' });
  }

  let targetMonth;
  if (month !== undefined) {
    if (typeof month !== 'string' || !MONTH_PATTERN.test(month)) {
      return res.status(400).json({ error: 'month must be in YYYY-MM format, e.g. 2026-07.' });
    }
    targetMonth = month;
  } else {
    const now = startOfCurrentMonthUtc();
    targetMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const monthDate = `${targetMonth}-01`;

  const { data: savedRow, error: savedError } = await supabase
    .from('society_month_closings')
    .select('*')
    .eq('society_id', societyId)
    .eq('month', monthDate)
    .maybeSingle();

  if (savedError) {
    return res.status(500).json({ error: savedError.message });
  }

  const isGenerated = !!savedRow;
  if (!callerIsAdmin && !isGenerated) {
    return res.json({ month: targetMonth, generated: false });
  }

  const rangeStart = new Date(`${targetMonth}-01T00:00:00.000Z`);
  const rangeEnd = addMonths(rangeStart, 1);

  const { data: transactions, error: transactionsError } = await supabase
    .from('transactions')
    .select('id, transaction_type, direction, payment_mode, amount, description')
    .eq('society_id', societyId)
    .eq('processing_status', 'Verified')
    .gte('verified_at', rangeStart.toISOString())
    .lt('verified_at', rangeEnd.toISOString());

  if (transactionsError) {
    return res.status(500).json({ error: transactionsError.message });
  }

  const figures = computeMonthEndClosingFigures(transactions || []);

  let openingBalance;
  let openingBalanceSource;
  if (savedRow) {
    openingBalance = { bank: Number(savedRow.bank_opening_balance), cash: Number(savedRow.cash_opening_balance) };
    openingBalanceSource = 'saved';
  } else {
    const { data: previousRow, error: previousError } = await supabase
      .from('society_month_closings')
      .select('bank_closing_balance, cash_closing_balance')
      .eq('society_id', societyId)
      .eq('month', toDateOnly(addMonths(monthDate, -1)))
      .maybeSingle();

    if (previousError) {
      return res.status(500).json({ error: previousError.message });
    }

    if (previousRow) {
      openingBalance = { bank: Number(previousRow.bank_closing_balance), cash: Number(previousRow.cash_closing_balance) };
      openingBalanceSource = 'previous_month_closing';
    } else {
      openingBalance = { bank: 0, cash: 0 };
      openingBalanceSource = 'none';
    }
  }

  const closingBalance = {
    bank: round2(openingBalance.bank + figures.totals.income.online - figures.totals.expense.online),
    cash: round2(openingBalance.cash + figures.totals.income.cash - figures.totals.expense.cash),
  };

  let guard;
  if (callerIsAdmin) {
    let blockedCount;
    try {
      blockedCount = await countBlockingSubmittedTransactions(supabase, societyId, rangeEnd);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    guard = { blocked: blockedCount > 0, blockedCount };
  }

  res.json({
    month: targetMonth,
    generated: isGenerated,
    generatedAt: savedRow ? savedRow.updated_at : null,
    openingBalance: { ...openingBalance, source: openingBalanceSource },
    closingBalance,
    incomeExpense: { rows: figures.rows, totals: figures.totals },
    overallTotal: figures.overallTotal,
    maintenanceBreakup: figures.maintenanceBreakup,
    guard,
  });
});

// POST /society/:id/month-end-closing - Admin-only. Computes and saves
// (upserts - freely re-runnable, see countBlockingSubmittedTransactions's
// own comment on why there is no separate Lock flag) this month's Bank and
// Cash Closing Balance from an Admin-supplied Opening Balance.
//
// bank_opening_balance/cash_opening_balance are both optional - when
// omitted, defaults to whatever is already saved for this exact month (a
// plain re-run), or otherwise the immediately preceding month's own saved
// Closing Balance ("current month's closing balance becomes next month's
// opening balance" - the user's own framing), or zero as the last resort
// for a society's very first-ever generated month. Passing either one
// explicitly is how the Admin exercises the override this was built for:
// correcting for a bank-only entry that never went through
// POST /transactions at all (a bank charge, an interest credit) rather
// than skewing every subsequent month's Bank ledger by that same missed
// amount forever.
router.post('/:id/month-end-closing', authenticate, async (req, res) => {
  const supabase = req.supabase;
  const { id: societyId } = req.params;
  const { month, bank_opening_balance, cash_opening_balance } = req.body || {};

  let callerIsAdmin;
  try {
    callerIsAdmin = await requireActiveAdmin(supabase, req.user.id, societyId);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!callerIsAdmin) {
    return res.status(403).json({ error: 'Only an Admin of this society can generate the Month-End Closing report.' });
  }

  if (typeof month !== 'string' || !MONTH_PATTERN.test(month)) {
    return res.status(400).json({ error: 'month must be in YYYY-MM format, e.g. 2026-07.' });
  }
  if (bank_opening_balance !== undefined && !Number.isFinite(bank_opening_balance)) {
    return res.status(400).json({ error: 'bank_opening_balance must be a number.' });
  }
  if (cash_opening_balance !== undefined && !Number.isFinite(cash_opening_balance)) {
    return res.status(400).json({ error: 'cash_opening_balance must be a number.' });
  }

  const monthDate = `${month}-01`;
  const rangeStart = new Date(`${month}-01T00:00:00.000Z`);
  const rangeEnd = addMonths(rangeStart, 1);

  let blockedCount;
  try {
    blockedCount = await countBlockingSubmittedTransactions(supabase, societyId, rangeEnd);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (blockedCount > 0) {
    return res.status(409).json({
      error: `${blockedCount} transaction(s) dated on or before ${month} ${blockedCount === 1 ? 'is' : 'are'} still awaiting review (Submitted). Verify or reject ${blockedCount === 1 ? 'it' : 'them'} before generating this month's closing.`,
      blockedCount,
    });
  }

  const { data: existingRow, error: existingError } = await supabase
    .from('society_month_closings')
    .select('id, bank_opening_balance, cash_opening_balance')
    .eq('society_id', societyId)
    .eq('month', monthDate)
    .maybeSingle();

  if (existingError) {
    return res.status(500).json({ error: existingError.message });
  }

  const overrideProvided = bank_opening_balance !== undefined || cash_opening_balance !== undefined;

  let openingBalance;
  let openingBalanceSource;
  if (overrideProvided) {
    openingBalance = {
      bank: bank_opening_balance !== undefined ? bank_opening_balance : existingRow ? Number(existingRow.bank_opening_balance) : 0,
      cash: cash_opening_balance !== undefined ? cash_opening_balance : existingRow ? Number(existingRow.cash_opening_balance) : 0,
    };
    openingBalanceSource = 'manual_override';
  } else if (existingRow) {
    openingBalance = { bank: Number(existingRow.bank_opening_balance), cash: Number(existingRow.cash_opening_balance) };
    openingBalanceSource = 'saved';
  } else {
    const { data: previousRow, error: previousError } = await supabase
      .from('society_month_closings')
      .select('bank_closing_balance, cash_closing_balance')
      .eq('society_id', societyId)
      .eq('month', toDateOnly(addMonths(monthDate, -1)))
      .maybeSingle();

    if (previousError) {
      return res.status(500).json({ error: previousError.message });
    }

    openingBalance = previousRow
      ? { bank: Number(previousRow.bank_closing_balance), cash: Number(previousRow.cash_closing_balance) }
      : { bank: 0, cash: 0 };
    openingBalanceSource = previousRow ? 'previous_month_closing' : 'none';
  }

  const { data: transactions, error: transactionsError } = await supabase
    .from('transactions')
    .select('id, transaction_type, direction, payment_mode, amount, description')
    .eq('society_id', societyId)
    .eq('processing_status', 'Verified')
    .gte('verified_at', rangeStart.toISOString())
    .lt('verified_at', rangeEnd.toISOString());

  if (transactionsError) {
    return res.status(500).json({ error: transactionsError.message });
  }

  const figures = computeMonthEndClosingFigures(transactions || []);

  const closingBalance = {
    bank: round2(openingBalance.bank + figures.totals.income.online - figures.totals.expense.online),
    cash: round2(openingBalance.cash + figures.totals.income.cash - figures.totals.expense.cash),
  };

  const { data: saved, error: saveError } = await supabase
    .from('society_month_closings')
    .upsert(
      {
        society_id: societyId,
        month: monthDate,
        bank_opening_balance: openingBalance.bank,
        cash_opening_balance: openingBalance.cash,
        bank_closing_balance: closingBalance.bank,
        cash_closing_balance: closingBalance.cash,
        generated_by: req.user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'society_id,month' }
    )
    .select()
    .single();

  if (saveError) {
    return res.status(500).json({ error: saveError.message });
  }

  const { error: auditError } = await supabase.from('audit_events').insert({
    society_id: societyId,
    actor_user_id: req.user.id,
    entity_type: 'month_closing',
    entity_id: saved.id,
    action: existingRow ? 'Updated' : 'Created',
    metadata: {
      month,
      openingBalance,
      openingBalanceSource,
      closingBalance,
      overallTotal: figures.overallTotal,
      regenerated: !!existingRow,
    },
  });

  if (auditError) {
    return res.status(500).json({
      error: `Month-End Closing generated but the audit log entry failed: ${auditError.message}`,
      monthClosing: saved,
    });
  }

  res.json({
    month,
    generated: true,
    generatedAt: saved.updated_at,
    openingBalance: { ...openingBalance, source: openingBalanceSource },
    closingBalance,
    incomeExpense: { rows: figures.rows, totals: figures.totals },
    overallTotal: figures.overallTotal,
    maintenanceBreakup: figures.maintenanceBreakup,
  });
});

module.exports = router;
