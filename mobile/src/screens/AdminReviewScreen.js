import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { apiGet, apiPost } from '../api/client';
import { useAuth } from '../context/AuthContext';

function formatMoney(amount) {
  return `\u20B9${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Backend/src/routes/transactions.js's GET /transactions/pending returns
// each transaction's own allocations, but not the billing periods' own
// period_month - a count is enough context here ("covers 3 period(s)"),
// full month-by-month breakdown is what GET /houses/:houseId/transactions
// is for, not this at-a-glance review queue.
function describeAllocations(transaction) {
  const count = (transaction.transaction_allocations || []).length;
  if (count === 0) return 'No allocations recorded';
  return count === 1 ? 'Covers 1 billing period' : `Covers ${count} billing periods`;
}

export default function AdminReviewScreen({ onBack, onLogout }) {
  const { accessToken } = useAuth();
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  // The transaction currently mid-reject (its inline reason box is open),
  // and the reason text typed into it. Only one row can be in this state
  // at a time, mirroring how DuesScreen keeps only one thing "active".
  const [rejectingId, setRejectingId] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  // Per-transaction in-flight/error state so one row's action never blocks
  // or gets confused with another's.
  const [rowState, setRowState] = useState({});

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await apiGet('/transactions/pending', accessToken);
      setPending(data);
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

  const setRowError = (id, message) => {
    setRowState((prev) => ({ ...prev, [id]: { ...prev[id], error: message, busy: false } }));
  };

  const setRowBusy = (id, busy) => {
    setRowState((prev) => ({ ...prev, [id]: { ...prev[id], busy, error: null } }));
  };

  const handleVerify = async (transaction) => {
    setRowBusy(transaction.id, true);
    try {
      await apiPost(`/transactions/${transaction.id}/verify`, accessToken);
      setPending((prev) => prev.filter((t) => t.id !== transaction.id));
    } catch (err) {
      setRowError(transaction.id, err.message);
    }
  };

  const startReject = (transaction) => {
    setRejectingId(transaction.id);
    setRejectReason('');
  };

  const cancelReject = () => {
    setRejectingId(null);
    setRejectReason('');
  };

  const confirmReject = async (transaction) => {
    if (!rejectReason.trim()) {
      setRowError(transaction.id, 'A reason is required to reject a payment.');
      return;
    }
    setRowBusy(transaction.id, true);
    try {
      await apiPost(`/transactions/${transaction.id}/reject`, accessToken, { reason: rejectReason.trim() });
      setPending((prev) => prev.filter((t) => t.id !== transaction.id));
      setRejectingId(null);
      setRejectReason('');
    } catch (err) {
      setRowError(transaction.id, err.message);
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Review pending payments</Text>
          <Text style={styles.subtitle}>
            {pending.length} awaiting {pending.length === 1 ? 'review' : 'reviews'}
          </Text>
        </View>
        <TouchableOpacity onPress={onLogout}>
          <Text style={styles.signOutLink}>Sign out</Text>
        </TouchableOpacity>
      </View>

      {onBack ? (
        <TouchableOpacity style={styles.backLink} onPress={onBack}>
          <Text style={styles.backLinkText}>← Back to my dues</Text>
        </TouchableOpacity>
      ) : null}

      {error && <Text style={styles.error}>{error}</Text>}

      {!error && pending.length === 0 && (
        <Text style={styles.subtitle}>No pending payments right now - everything is reviewed.</Text>
      )}

      {pending.map((transaction) => {
        const state = rowState[transaction.id] || {};
        const isRejecting = rejectingId === transaction.id;

        return (
          <View key={transaction.id} style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.houseNumber}>{transaction.houses?.house_number}</Text>
              <Text style={styles.amount}>{formatMoney(transaction.amount)}</Text>
            </View>
            <Text style={styles.meta}>
              {transaction.transaction_type} • UTR {transaction.utr_number} • {formatDate(transaction.created_at)}
            </Text>
            <Text style={styles.meta}>{describeAllocations(transaction)}</Text>

            {state.error && <Text style={styles.rowError}>{state.error}</Text>}

            {isRejecting ? (
              <View style={styles.rejectBox}>
                <TextInput
                  style={styles.reasonInput}
                  placeholder="Reason for rejecting (required)"
                  value={rejectReason}
                  onChangeText={setRejectReason}
                  multiline
                />
                <View style={styles.actionRow}>
                  <TouchableOpacity style={styles.cancelButton} onPress={cancelReject} disabled={state.busy}>
                    <Text style={styles.cancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.rejectButton}
                    onPress={() => confirmReject(transaction)}
                    disabled={state.busy}
                  >
                    <Text style={styles.rejectButtonText}>{state.busy ? 'Rejecting…' : 'Confirm reject'}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={styles.rejectOutlineButton}
                  onPress={() => startReject(transaction)}
                  disabled={state.busy}
                >
                  <Text style={styles.rejectOutlineButtonText}>Reject</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.verifyButton}
                  onPress={() => handleVerify(transaction)}
                  disabled={state.busy}
                >
                  <Text style={styles.verifyButtonText}>{state.busy ? 'Verifying…' : 'Verify'}</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        );
      })}
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
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f5f5f7',
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
  error: {
    color: '#c0392b',
    fontSize: 14,
    marginBottom: 12,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  houseNumber: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1c1c1e',
  },
  amount: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1c1c1e',
  },
  meta: {
    fontSize: 13,
    color: '#6e6e73',
    marginTop: 2,
  },
  rowError: {
    color: '#c0392b',
    fontSize: 13,
    marginTop: 8,
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 12,
    gap: 8,
  },
  verifyButton: {
    backgroundColor: '#1a9850',
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  verifyButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
  rejectOutlineButton: {
    borderWidth: 1,
    borderColor: '#c0392b',
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  rejectOutlineButtonText: {
    color: '#c0392b',
    fontWeight: '600',
    fontSize: 14,
  },
  rejectBox: {
    marginTop: 12,
  },
  reasonInput: {
    borderWidth: 1,
    borderColor: '#d0d0d5',
    borderRadius: 6,
    padding: 10,
    fontSize: 14,
    minHeight: 44,
  },
  cancelButton: {
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  cancelButtonText: {
    color: '#6e6e73',
    fontWeight: '600',
    fontSize: 14,
  },
  rejectButton: {
    backgroundColor: '#c0392b',
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  rejectButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
});
