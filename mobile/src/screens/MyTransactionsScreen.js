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
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
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
// which ones), GET /transactions/mine just wasn't asking for each
// allocation's own period_month until now. Sorted oldest-first to read as
// a small FIFO timeline, matching the order the backend actually applies
// payments in (routes/transactions.js).
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

// The resident-facing "View Transactions (all)" screen (workflow S.No 4) -
// every payment the caller has ever submitted, across every house they are
// Active-assigned to, backed by the aggregated GET /transactions/mine
// (co-assignee visibility included, so an owner who rents out a house sees
// their tenant's payments here too - see that route's own comment). Unlike
// BillingHistoryScreen (one house, every billing period), this is
// transaction-shaped and spans every house at once, matching how the
// backend endpoint itself aggregates.
export default function MyTransactionsScreen({ onBack }) {
  const { accessToken } = useAuth();
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await apiGet('/transactions/mine', accessToken);
      setTransactions(data);
    } catch (err) {
      setError(err.message);
    }
  }, [accessToken]);

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
          <Text style={styles.title}>My transactions</Text>
          <Text style={styles.subtitle}>
            {transactions.length} payment{transactions.length === 1 ? '' : 's'} across all your houses
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
        transactions.map((transaction) => (
          <View key={transaction.id} style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.houseNumber}>{transaction.houses?.house_number}</Text>
              <View style={[styles.badge, statusBadgeStyle(transaction.processing_status)]}>
                <Text style={[styles.badgeText, statusTextStyle(transaction.processing_status)]}>
                  {transaction.processing_status}
                </Text>
              </View>
            </View>
            <Text style={styles.amount}>{formatMoney(transaction.amount)}</Text>
            <Text style={styles.meta}>
              {transaction.transaction_type} • {formatPaymentReference(transaction)} • {formatDate(transaction.created_at)}
            </Text>
            <Text style={styles.meta}>{describeAllocations(transaction)}</Text>
          </View>
        ))
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
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#e6e6e6',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  houseNumber: {
    fontSize: 16,
    fontWeight: '700',
  },
  amount: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 6,
  },
  meta: {
    fontSize: 13,
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
