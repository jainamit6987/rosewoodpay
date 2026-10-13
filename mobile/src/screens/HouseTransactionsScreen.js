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

// Same as MyTransactionsScreen's own formatPaymentReference - a Cash
// payment never has a utr_number (no bank reference for a physical
// handover), so this names the payment mode itself instead of showing a
// misleading "UTR null". This is the one transaction-list screen where a
// Cash row is actually common (an Admin's own house-scoped view sees every
// status, not just Submitted ones), so this is the fix that matters most.
function formatPaymentReference(transaction) {
  return transaction.payment_mode === 'Cash' ? 'Cash' : `UTR ${transaction.utr_number}`;
}

// Same allocation-naming logic as MyTransactionsScreen - see that file's
// own comment for why this reads transaction_allocations rather than a
// plain count, and for why WaterCharge (never allocated against
// billing_periods at all) gets its own description-based line instead.
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

// The Admin/Committee-facing "view transactions for a house" screen
// (workflow S.No 23) - every payment ever submitted against this one
// house, backed by GET /houses/:houseId/transactions. Reached from a
// "Transactions" tile on HouseDashboardScreen.
//
// Rendered as a table (Date/Type/Amount columns, zebra-striped rows), same
// layout MyTransactionsScreen uses - no separate House column here since
// this screen is already scoped to one house (its own title). The
// UTR/Cash reference and which month(s) a payment covers don't fit in a
// single compact row, so tapping a row expands it in place to reveal them
// instead of dropping that detail - a trailing chevron on each row signals
// that affordance.
//
// Status is a colored icon next to the Amount (utils/transactionStatus.js)
// rather than a text badge, with a frozen TransactionStatusLegend pinned
// above the scrollable table - same reasoning/discussion as
// MyTransactionsScreen's own copy of this comment (2026-10-13). This also
// picks up the Gateway-vs-Admin-review distinction MyTransactionsScreen
// already had and this screen previously didn't (it used to just show the
// raw processing_status word, with no PaySharp-specific split) - now both
// screens share the exact same status logic instead of two near-identical
// copies of it.
//
// A "View Receipt" link is shown in that expanded detail box for
// WaterCharge rows only (via onViewReceipt, if provided) - this was the
// one Admin-facing screen that listed WaterCharge payments but had no way
// to open a receipt for one at all (Admin's other receipt path, the
// "Receipts" tile/BillingHistoryScreen, is built around billing_periods,
// which WaterCharge never has - see WaterChargeReceiptScreen's own
// comment). Maintenance rows deliberately do NOT get one here - a single
// Maintenance transaction can span several billing periods (FIFO/advance
// payments), each with its own already-correct receipt reachable from
// BillingHistoryScreen instead; a transaction-level receipt link here
// would have to arbitrarily pick one of those periods, which is exactly
// the ambiguity that screen's own per-period design avoids.
export default function HouseTransactionsScreen({ house, onBack, onViewReceipt }) {
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
      {/* Fixed (non-scrolling) header + legend - see MyTransactionsScreen's
          own copy of this comment for why. */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{house.house_number}</Text>
          <Text style={styles.subtitle}>
            {transactions.length} payment{transactions.length === 1 ? '' : 's'}
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
          <Text style={styles.empty}>No payments recorded for this house yet.</Text>
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
                      {transaction.transaction_type === 'WaterCharge' && onViewReceipt ? (
                        <TouchableOpacity onPress={() => onViewReceipt(transaction)} style={styles.viewReceiptLink}>
                          <Text style={styles.viewReceiptLinkText}>View Receipt &rsaquo;</Text>
                        </TouchableOpacity>
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
  viewReceiptLink: {
    alignSelf: 'flex-start',
    marginTop: 8,
  },
  viewReceiptLinkText: {
    fontSize: 12.5,
    fontWeight: '600',
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
