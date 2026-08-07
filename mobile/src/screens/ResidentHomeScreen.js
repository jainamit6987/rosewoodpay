import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

function formatMoney(amount) {
  return `\u20B9${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

function formatMonth(periodMonth) {
  return new Date(periodMonth).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// First token of the member's full name (e.g. "Ananya Iyer" -> "Ananya") -
// there is no separate first/last name column, name is stored as one
// free-text field (society_members.name). Falls back to null (renders
// nothing) rather than an empty greeting when the name hasn't loaded yet or
// is blank, same defensive-null-check convention as formatMoney/formatDate
// above never being called on missing data.
function firstName(fullName) {
  const trimmed = (fullName || '').trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0];
}

// "Current billing period" here is this calendar month's own period,
// whatever its status - see backend/src/routes/me.js's currentPeriod. It is
// deliberately not the same figure as "Current Due" below, which is the
// full arrears total across every still-Open period, this month included.
function currentPeriodLabel(currentPeriod) {
  if (!currentPeriod) return 'Not yet generated';
  return `${formatMonth(currentPeriod.period_month)} \u00b7 ${currentPeriod.status}`;
}

// The resident landing dashboard - a personal billing summary "table" plus
// three sections: "Payment" (the two things a resident actually pays -
// Maintenance dues and ad-hoc Water Charges - as prominent, accent-colored
// tiles, replacing the old single "Pay your dues" banner), "Transaction
// History and Receipts" (My Transactions - every payment and what it
// covered; My Receipts - the full billing-period history, framed as a
// resident's receipts rather than raw "Billing Periods" plumbing, per the
// user's own reasoning that a Closed period IS a receipt, with no physical
// paper needed), and "More" (Society Listings - browse other owners'
// available-to-rent houses; anything account-level like Change Password
// has moved to HouseProfileScreen instead, since it is not specific to
// this one house).
//
// The house number, formerly plain header text, is now a tappable
// circular avatar opening HouseProfileScreen (onViewProfile, wired in
// App.js) - the new home for house-level facts (Owner/Tenant contact
// info, the Available-to-Rent toggle, Change Password) that used to live
// directly in this screen's own table. See HouseProfileScreen.js for why:
// showing a housemate's contact info is a new, separate trust boundary
// from this screen's own personal summary, so it now lives on its own
// screen rather than folded into this one.
//
// "Switch to Admin view" (onSwitchToAdmin, only ever passed for a member
// who genuinely has both capabilities - see App.js's own bothAvailable)
// mirrors AdminHomeScreen's existing "Switch to Resident view" - this used
// to be a one-way trip (the only way back to Admin from here was logging
// out and choosing again at ModeChooserScreen), which the user pointed out
// was an asymmetry, not a deliberate restriction worth keeping.
export default function ResidentHomeScreen({
  residentName,
  assignment,
  openBillingPeriods,
  onPayDues,
  onViewTransactions,
  onViewHistory,
  onViewWaterCharges,
  onViewProfile,
  onViewListings,
  onSwitchToAdmin,
  onBack,
  onLogout,
  refreshing,
  onRefresh,
}) {
  const greetingName = firstName(residentName);
  const house = assignment?.houses;
  const housePeriods = (openBillingPeriods || []).filter((period) => period.house_id === house?.id);
  const currentDue = housePeriods.reduce((sum, period) => sum + Number(period.amount_due), 0);
  const lastPayment = assignment?.lastPayment;

  const rows = [
    { label: 'Current Billing Period', value: currentPeriodLabel(assignment?.currentPeriod) },
    { label: 'Current Due', value: formatMoney(currentDue) },
    { label: 'Last Payment Date', value: lastPayment ? formatDate(lastPayment.date) : '\u2014' },
    { label: 'Last Payment Amount', value: lastPayment ? formatMoney(lastPayment.amount) : '\u2014' },
  ];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}
    >
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.avatarCircle}
          onPress={onViewProfile}
          disabled={!onViewProfile}
          accessibilityLabel="View house profile"
        >
          <Text style={styles.avatarText} numberOfLines={1}>
            {house?.house_number}
          </Text>
          <View style={styles.avatarBadge}>
            <Text style={styles.avatarBadgeText}>{'\u203a'}</Text>
          </View>
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          {/* "Add above" placement from the greeting mockup (canvases/
              dashboard-greeting-mockup.canvas.tsx) - italic, its own line,
              existing "Resident dashboard" subtitle kept unchanged below
              it. Only rendered once a name has actually loaded - no
              "Hi, " placeholder flash before /me resolves. */}
          {greetingName ? <Text style={styles.greeting}>{`Hi, ${greetingName}`}</Text> : null}
          <Text style={styles.subtitle}>Resident dashboard</Text>
        </View>
        {onLogout ? (
          <TouchableOpacity onPress={onLogout}>
            <Text style={styles.signOutLink}>Sign out</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {onSwitchToAdmin ? (
        <TouchableOpacity onPress={onSwitchToAdmin}>
          <Text style={styles.switchLink}>Switch to Admin view</Text>
        </TouchableOpacity>
      ) : null}

      {onBack ? (
        <TouchableOpacity style={styles.backLink} onPress={onBack}>
          <Text style={styles.backLinkText}>← Back to my houses</Text>
        </TouchableOpacity>
      ) : null}

      <View style={styles.card}>
        {rows.map((row, index) => (
          <View key={row.label} style={[styles.detailRow, index === rows.length - 1 && styles.detailRowLast]}>
            <Text style={styles.detailLabel}>{row.label}</Text>
            <Text style={styles.detailValue}>{row.value}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.sectionHeader}>Payment</Text>
      <View style={styles.grid}>
        <TouchableOpacity style={styles.payTile} onPress={onPayDues}>
          <Text style={styles.payTileTitle}>Pay Maintenance</Text>
          <Text style={styles.payTileSummary}>
            {housePeriods.length === 0 ? 'All caught up' : `${formatMoney(currentDue)} due`}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.payTile} onPress={onViewWaterCharges}>
          <Text style={styles.payTileTitle}>Pay Water Charges</Text>
          <Text style={styles.payTileSummary}>Pay for extra water</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionHeader}>Transaction History and Receipts</Text>
      <View style={styles.grid}>
        <TouchableOpacity style={styles.tile} onPress={onViewTransactions}>
          <Text style={styles.tileTitle}>My Transactions</Text>
          <Text style={styles.tileSummary}>Payments & coverage</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tile} onPress={onViewHistory}>
          <Text style={styles.tileTitle}>My Receipts</Text>
          <Text style={styles.tileSummary}>All months & status</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionHeader}>More</Text>
      <View style={styles.grid}>
        <TouchableOpacity style={styles.tile} onPress={onViewListings}>
          <Text style={styles.tileTitle}>Society Listings</Text>
          <Text style={styles.tileSummary}>Houses available to rent</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f7',
  },
  content: {
    padding: 16,
    paddingTop: 48,
    paddingBottom: 40,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  avatarCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#1a73e8',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: '#fff',
    shadowColor: '#1a73e8',
    shadowOpacity: 0.45,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  avatarText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  // A small overlapping badge, the same "editable profile picture" cue
  // most apps use - combined with the ring/shadow above on avatarCircle,
  // these are meant to be noticed together: the shadow makes the circle
  // read as a raised, pressable surface even before you look closely, and
  // the chevron confirms exactly what it is once you do. Positioned
  // absolutely so it overlaps the circle's own edge without needing a
  // separate wrapping container - TouchableOpacity is itself the relative
  // positioning parent here.
  avatarBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#f5f5f7',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  avatarBadgeText: {
    color: '#1a73e8',
    fontSize: 12,
    fontWeight: '900',
    lineHeight: 12,
  },
  greeting: {
    fontSize: 15,
    fontStyle: 'italic',
    fontWeight: '600',
    color: '#1c1c1e',
  },
  subtitle: {
    fontSize: 14,
    color: '#6e6e73',
    marginTop: 4,
  },
  signOutLink: {
    color: '#1a73e8',
    fontSize: 14,
    fontWeight: '600',
    paddingTop: 4,
  },
  switchLink: {
    color: '#1a73e8',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 16,
  },
  backLink: {
    marginBottom: 16,
  },
  backLinkText: {
    color: '#1a73e8',
    fontSize: 14,
    fontWeight: '600',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    marginTop: 12,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  detailRowLast: {
    borderBottomWidth: 0,
  },
  detailLabel: {
    fontSize: 13,
    color: '#6e6e73',
  },
  detailValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1c1c1e',
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: '#8a8a8e',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 20,
  },
  tile: {
    flexBasis: '47%',
    flexGrow: 1,
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    minHeight: 76,
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  tileTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1c1c1e',
  },
  tileSummary: {
    fontSize: 13,
    color: '#1a73e8',
    fontWeight: '600',
    marginTop: 6,
  },
  // The two Payment tiles are deliberately filled/accent-colored, not just
  // plain white cards like every other tile - the user asked for this
  // section to read as the most prominent thing on the dashboard, the same
  // visual weight the old single "Pay your dues" button had.
  payTile: {
    flexBasis: '47%',
    flexGrow: 1,
    backgroundColor: '#1a73e8',
    borderRadius: 10,
    padding: 16,
    minHeight: 76,
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  payTileTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },
  payTileSummary: {
    fontSize: 13,
    color: '#e3edfd',
    fontWeight: '600',
    marginTop: 6,
  },
});
