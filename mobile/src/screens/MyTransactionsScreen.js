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
import TransactionStatusLegend from '../components/TransactionStatusLegend';
import { getTransactionStatusInfo } from '../utils/transactionStatus';

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
// physical cash handover. A PaySharp gateway order also has no utr_number
// until PaySharp actually confirms SUCCESS (see transactionGateway.js) -
// while still Submitted, there is genuinely nothing to show yet. Showing
// "UTR null" in either case would read as a data bug rather than the
// expected absence, so both are named explicitly instead.
function formatPaymentReference(transaction) {
  if (transaction.payment_mode === 'Cash') return 'Cash';
  if (transaction.payment_gateway === 'paysharp' && !transaction.utr_number) {
    return 'UTR pending gateway confirmation';
  }
  return `UTR ${transaction.utr_number}`;
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
// Rendered as a table (Date/Type/Amount columns, zebra-striped rows) rather
// than one tall card per transaction - reading down a column (e.g. every
// Amount) is far easier once a resident has a long payment history, and
// more rows fit on screen at once. The UTR/Cash reference and which
// month(s) a payment covers don't fit in a single compact row, so tapping
// a row expands it in place to reveal them instead of dropping that detail
// - a trailing chevron on each row now signals that affordance exists,
// which nothing on this screen used to hint at before.
//
// Status used to be its own badge column; it is now a colored icon shown
// right next to the Amount instead (see utils/transactionStatus.js), with
// a frozen TransactionStatusLegend pinned above the scrollable table
// explaining what each icon means - discussed directly with the user
// (2026-10-13): a plain color-only Amount would have lost the "gateway
// auto-resolves" vs "needs a human Admin" distinction and hurt colorblind
// readability, so each status keeps its own icon SHAPE, not just a color.
// Pinning the legend (rather than scrolling with row 1) means it's still
// one glance away no matter how far down a long history the resident has
// scrolled, without repeating a status word on every single row.
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
    <View style={styles.container}>
      {/* Fixed (non-scrolling) header + legend - only the table below
          scrolls, so the legend stays one glance away no matter how far
          down a long history the resident scrolls. Pull-to-refresh moves
          down to the scrollable ScrollView below instead of this outer
          View, since that's the region the gesture naturally belongs to. */}
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

      {!loading && !error && transactions.length > 0 ? (
        <View style={styles.legendWrap}>
          <TransactionStatusLegend />
        </View>
      ) : null}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      >
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
              <View style={styles.colChevron} />
            </View>
            {transactions.map((transaction, index) => {
              const isExpanded = expandedId === transaction.id;
              const statusInfo = getTransactionStatusInfo(transaction);
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
                    <View style={[styles.colAmount, styles.amountWrap]}>
                      <Text style={[styles.cellAmount, { color: statusInfo.color }]}>
                        {formatMoney(transaction.amount)}
                      </Text>
                      <Text
                        style={[styles.statusIcon, { color: statusInfo.color }]}
                        accessibilityLabel={statusInfo.label}
                      >
                        {statusInfo.icon}
                      </Text>
                    </View>
                    <Text style={styles.chevron}>{isExpanded ? '\u25BE' : '\u203A'}</Text>
                  </View>
                  {isExpanded ? (
                    <View style={styles.detailBox}>
                      <Text style={[styles.detailText, styles.detailStatus, { color: statusInfo.color }]}>
                        {statusInfo.label}
                      </Text>
                      <Text style={styles.detailText}>{formatPaymentReference(transaction)}</Text>
                      <Text style={styles.detailText}>{describeAllocations(transaction)}</Text>
                      {transaction.processing_status === 'Submitted' && transaction.payment_gateway === 'paysharp' ? (
                        <Text style={styles.detailText}>
                          This is a PaySharp instant-UPI order - it resolves automatically (Success or
                          Failed/Expired) within 15 minutes, no action needed from you.
                        </Text>
                      ) : null}
                    </View>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f6f8',
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 20,
    paddingTop: 0,
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
    padding: 20,
    paddingBottom: 14,
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
  legendWrap: {
    marginHorizontal: 20,
    marginBottom: 10,
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
    fontSize: 12,
    fontWeight: '700',
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
  amountWrap: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 5,
  },
  statusIcon: {
    fontSize: 13,
    fontWeight: '700',
  },
  colChevron: {
    width: 16,
  },
  chevron: {
    width: 16,
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '700',
    color: '#b0b0b5',
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
  detailStatus: {
    fontWeight: '700',
    marginTop: 0,
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
