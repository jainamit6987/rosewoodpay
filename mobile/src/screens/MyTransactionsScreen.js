import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { apiGet } from '../api/client';
import { useAuth } from '../context/AuthContext';

function formatMoney(amount) {
  return `\u20B9${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function formatMonth(periodMonth) {
  return new Date(periodMonth).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

// Cash payments (Admin-recorded, see routes/transactions.js) never have a
// utr_number - it stays NULL, since there is no bank reference for a
// physical cash handover. Showing "UTR null" there would read as a data
// bug rather than the expected absence, so this names the payment mode
// itself instead whenever there is no UTR to show.
function formatPaymentReference(transaction) {
  return transaction.payment_mode === 'Cash' ? 'Cash' : `UTR ${transaction.utr_number}`;
}

// Names the actual month(s) this payment was allocated to, not just a
// count - the DB has always fully supported this (transaction_allocations
// is a real many-to-many join table, one row per transaction+billing_period
// pair, exactly to let one payment cover several months and still know
// which ones). Sorted oldest-first to read as a small FIFO timeline,
// matching the order the backend actually applies payments in
// (routes/transactions.js).
//
// WaterCharge never has any allocations at all - it is pay-as-you-go, not
// allocated against billing_periods - so "No billing period allocated yet"
// would misread as still-pending rather than simply not applicable here.
function describeAllocations(transaction) {
  if (transaction.transaction_type === 'WaterCharge') {
    return transaction.description ? `Water charge: ${transaction.description}` : 'Water charge';
  }
  const allocations = transaction.transaction_allocations || [];
  if (allocations.length === 0) return 'No billing period allocated yet';
  const months = allocations
    .map((a) => a.billing_periods?.period_month)
    .filter(Boolean)
    .sort()
    .map(formatMonth);
  return `Covers: ${months.join(', ')}`;
}

// Kept in sync with the chk_processing_status CHECK constraint. Grouped into
// three visual buckets rather than one color per exact value - a resident
// cares whether a payment is settled, rejected, or still somewhere in
// between, not which exact internal processing stage it is sitting in.
function statusBadgeStyle(status) {
  if (status === 'Verified') return styles.badgeVerified;
  if (status === 'Rejected' || status === 'Failed') return styles.badgeRejected;
  return styles.badgePending;
}

function statusTextStyle(status) {
  if (status === 'Verified') return styles.badgeTextVerified;
  if (status === 'Rejected' || status === 'Failed') return styles.badgeTextRejected;
  return styles.badgeTextPending;
}

// The resident-facing "My Transactions" tile off ResidentHomeScreen -
// backed by GET /houses/:houseId/transactions (the same endpoint
// HouseTransactionsScreen's Admin view already uses), scoped to whichever
// house the resident is currently viewing, not GET /transactions/mine's
// old across-every-house aggregation. An owner who holds more than one
// house used to see every house's payments mixed into one list here, which
// read as confusing since the rest of this dashboard (Pay Maintenance, My
// Receipts, etc.) is already scoped to just the one house currently being
// viewed - the user asked for this screen to match that same scope. That
// aggregated GET /transactions/mine endpoint itself is untouched (still
// covers the co-assignee-visibility case - an owner sees their own tenant's
// payments on this same house), just no longer what this particular screen
// calls.
//
// Rendered as a table (Date/Type/Amount/Status columns, zebra-striped rows)
// rather than one tall card per transaction - reading down a column (e.g.
// every Amount) is far easier once a resident has a long payment history,
// and more rows fit on screen at once. The UTR/Cash reference and which
// month(s) a payment covers don't fit in a single compact row, so tapping
// a row expands it in place to reveal them instead of dropping that detail.
export default function MyTransactionsScreen({ house, onBack }) {
  const { accessToken } = useAuth();
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await apiGet(`/houses/${house.id}/transactions`, accessToken);
      setTransactions(data);
    } catch (err) {
      setError(err.message);
    }
  }, [accessToken, house.id]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>My Transactions</Text>
          <Text style={styles.subtitle}>
            {transactions.length} payment{transactions.length === 1 ? '' : 's'} for {house.house_number}
          </Text>
        </View>
        <TouchableOpacity onPress={onBack}>
          <Text style={styles.backLink}>Back</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={styles.error}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={handleRefresh}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : transactions.length === 0 ? (
        <Text style={styles.empty}>No payments submitted yet.</Text>
      ) : (
        <View style={styles.table}>
          <View style={styles.tableHeaderRow}>
            <Text style={[styles.headerCell, styles.colDate]}>Date</Text>
            <Text style={[styles.headerCell, styles.colType]}>Type</Text>
            <Text style={[styles.headerCell, styles.colAmount]}>Amount</Text>
            <Text style={[styles.headerCell, styles.colStatus]}>Status</Text>
          </View>
          {transactions.map((transaction, index) => {
            const isExpanded = expandedId === transaction.id;
            return (
              <TouchableOpacity
                key={transaction.id}
                activeOpacity={0.7}
                onPress={() => setExpandedId(isExpanded ? null : transaction.id)}
                style={[styles.tableRow, index % 2 === 1 && styles.tableRowZebra]}
              >
                <View style={styles.tableRowLine}>
                  <Text style={[styles.cellText, styles.colDate, styles.cellMuted]}>
                    {formatDate(transaction.created_at)}
                  </Text>
                  <Text style={[styles.cellText, styles.colType]} numberOfLines={1}>
                    {transaction.transaction_type}
                  </Text>
                  <Text style={[styles.cellText, styles.colAmount, styles.cellAmount]}>
                    {formatMoney(transaction.amount)}
                  </Text>
                  <View style={[styles.colStatus, styles.cellStatusWrap]}>
                    <View style={[styles.badge, statusBadgeStyle(transaction.processing_status)]}>
                      <Text style={[styles.badgeText, statusTextStyle(transaction.processing_status)]}>
                        {transaction.processing_status}
                      </Text>
                    </View>
                  </View>
                </View>
                {isExpanded ? (
                  <View style={styles.detailBox}>
                    <Text style={styles.detailText}>{formatPaymentReference(transaction)}</Text>
                    <Text style={styles.detailText}>{describeAllocations(transaction)}</Text>
                  </View>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f6f8',
  },
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    gap: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 20,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 14,
    color: '#555',
    marginTop: 4,
  },
  backLink: {
    color: '#1a73e8',
    fontSize: 14,
    fontWeight: '600',
    paddingTop: 4,
  },
  empty: {
    fontSize: 14,
    color: '#777',
    textAlign: 'center',
    marginTop: 20,
  },
  table: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e6e6e6',
    overflow: 'hidden',
  },
  tableHeaderRow: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eeeeee',
  },
  headerCell: {
    fontSize: 11,
    fontWeight: '700',
    color: '#8a8a8e',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  tableRow: {
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  tableRowZebra: {
    backgroundColor: '#fafafa',
  },
  tableRowLine: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cellText: {
    fontSize: 12,
    color: '#1c1c1e',
  },
  cellMuted: {
    color: '#6e6e73',
  },
  cellAmount: {
    fontWeight: '700',
    textAlign: 'right',
  },
  cellStatusWrap: {
    alignItems: 'flex-end',
  },
  colDate: {
    flex: 1.1,
  },
  colType: {
    flex: 1.3,
  },
  colAmount: {
    flex: 1.2,
    textAlign: 'right',
  },
  colStatus: {
    flex: 1.1,
  },
  detailBox: {
    backgroundColor: '#f0f4fb',
    borderRadius: 6,
    padding: 10,
    marginTop: 10,
  },
  detailText: {
    fontSize: 12,
    color: '#6e6e73',
    marginTop: 2,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  badgeVerified: {
    backgroundColor: '#e6f4ea',
  },
  badgeTextVerified: {
    color: '#2e7d32',
  },
  badgeRejected: {
    backgroundColor: '#fdecea',
  },
  badgeTextRejected: {
    color: '#c0392b',
  },
  badgePending: {
    backgroundColor: '#e8f0fe',
  },
  badgeTextPending: {
    color: '#1a73e8',
  },
  error: {
    color: '#c0392b',
    fontSize: 14,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  retryButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
});
