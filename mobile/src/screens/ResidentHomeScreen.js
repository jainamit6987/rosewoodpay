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

// "Current billing period" here is this calendar month's own period,
// whatever its status - see backend/src/routes/me.js's currentPeriod. It is
// deliberately not the same figure as "Current Due" below, which is the
// full arrears total across every still-Open period, this month included.
function currentPeriodLabel(currentPeriod) {
  if (!currentPeriod) return 'Not yet generated';
  return `${formatMonth(currentPeriod.period_month)} \u00b7 ${currentPeriod.status}`;
}

// The resident landing dashboard - a personal summary "table" plus three
// spokes: paying dues (DuesScreen's existing period-selection UI, now
// scoped to just this one house - see App.js), all past transactions, and
// the full billing history for this house. onBack is only passed when this
// screen is itself a spoke off SelectHouseScreen (a resident with more than
// one house); with exactly one house this IS the resident's true home
// screen, so it gets Sign out instead of a back link - same "only the true
// home screen has Sign out" convention AdminHomeScreen/HousesScreen follow.
export default function ResidentHomeScreen({
  assignment,
  openBillingPeriods,
  userEmail,
  phoneNumber,
  onPayDues,
  onViewTransactions,
  onViewHistory,
  onBack,
  onLogout,
  refreshing,
  onRefresh,
}) {
  const house = assignment?.houses;
  // Owner's Name intentionally shows the house's recorded owner_name, not
  // the logged-in member's own name - this app has no name field for
  // members at all yet. Labeled explicitly as "Owner's Name" rather than
  // "Name" so it never reads as a claim about who is logged in; for a
  // Tenant resident this is genuinely a different person, by design.
  const housePeriods = (openBillingPeriods || []).filter((period) => period.house_id === house?.id);
  const currentDue = housePeriods.reduce((sum, period) => sum + Number(period.amount_due), 0);
  const lastPayment = assignment?.lastPayment;

  const rows = [
    { label: "Owner's Name", value: house?.owner_name || '\u2014' },
    { label: 'Mobile Number', value: phoneNumber || '\u2014' },
    { label: 'Email', value: userEmail || '\u2014' },
    { label: 'Resident Type', value: assignment?.relationship_type || '\u2014' },
    { label: 'House Number', value: house?.house_number || '\u2014' },
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
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{house?.house_number}</Text>
          <Text style={styles.subtitle}>Resident dashboard</Text>
        </View>
        {onLogout ? (
          <TouchableOpacity onPress={onLogout}>
            <Text style={styles.signOutLink}>Sign out</Text>
          </TouchableOpacity>
        ) : null}
      </View>

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

      {housePeriods.length === 0 ? (
        <Text style={styles.paidUp}>All caught up - no open dues.</Text>
      ) : (
        <TouchableOpacity style={styles.payButton} onPress={onPayDues}>
          <Text style={styles.payButtonText}>Pay your dues</Text>
        </TouchableOpacity>
      )}

      <Text style={styles.sectionHeader}>More</Text>
      <View style={styles.grid}>
        <TouchableOpacity style={styles.tile} onPress={onViewTransactions}>
          <Text style={styles.tileTitle}>My Transactions</Text>
          <Text style={styles.tileSummary}>Payments & coverage</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tile} onPress={onViewHistory}>
          <Text style={styles.tileTitle}>Billing Periods</Text>
          <Text style={styles.tileSummary}>All months & status</Text>
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
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
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
    marginBottom: 16,
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
  paidUp: {
    fontSize: 14,
    color: '#2e7d32',
    marginBottom: 16,
  },
  payButton: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 16,
  },
  payButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
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
});
