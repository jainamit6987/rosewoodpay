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
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function formatMonth(periodMonth) {
  return new Date(periodMonth).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

// Same as MyTransactionsScreen's own formatPaymentReference - a Cash
// payment never has a utr_number (no bank reference for a physical
// handover), so this names the payment mode itself instead of showing a
// misleading "UTR null". In practice a Cash transaction never actually
// reaches this particular screen (it auto-Verifies immediately and never
// sits in Submitted - see routes/transactions.js), but kept here anyway so
// this list stays correct if that ever changes, and for consistency with
// the other transaction-list screens.
function formatPaymentReference(transaction) {
  return transaction.payment_mode === 'Cash' ? 'Cash' : `UTR ${transaction.utr_number}`;
}

// Same as MyTransactionsScreen's own describeAllocations - names the actual
// month(s) this payment was allocated to via GET /transactions/pending's
// nested transaction_allocations -> billing_periods embed, not just a bare
// count, so an admin reviewing a payment can see at a glance which specific
// months it would settle before deciding to Verify it. Sorted oldest-first
// to match the FIFO order routes/transactions.js actually applies in.
//
// WaterCharge never has any allocations at all - it is deliberately
// pay-as-you-go, not allocated against billing_periods (see
// routes/transactions.js) - so "No allocations recorded" would misread as
// something having gone wrong. Shown instead as its own description, or a
// plain fallback if the resident/admin left one blank.
function describeAllocations(transaction) {
  if (transaction.transaction_type === 'WaterCharge') {
    return transaction.description ? `Water charge: ${transaction.description}` : 'Water charge';
  }
  const allocations = transaction.transaction_allocations || [];
  if (allocations.length === 0) return 'No allocations recorded';
  const months = allocations
    .map((a) => a.billing_periods?.period_month)
    .filter(Boolean)
    .sort()
    .map(formatMonth);
  return `Covers: ${months.join(', ')}`;
}

// Same table treatment as MyTransactionsScreen/HouseTransactionsScreen -
// House/Date/Type/Amount as compact table columns, zebra-striped rows,
// tap-a-row-to-expand for the UTR/Cash reference and covered month(s)
// (there is no separate Status column here, unlike those two screens -
// every row in this queue is, by definition, still Submitted, so it would
// be the same badge repeated on every single row). The Verify/Reject
// actions stay directly on each row, always visible below it, rather than
// hidden behind the tap - unlike a pure history list, doing something
// about each row is this screen's entire purpose.
// isAdmin gates Verify/Reject only - Committee members still see this
// whole queue (same read access GET /transactions/pending already grants
// them), just without the two action buttons on each row, replaced by a
// plain "View only" note. See routes/transactions.js's
// loadTransactionAndCheckAdmin, which already rejects both actions
// server-side for a Committee-only caller - this mirrors that rule in the
// UI instead of letting the tap round-trip into a 403.
export default function AdminReviewScreen({ isAdmin, onBack }) {
  const { accessToken } = useAuth();
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
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
      </View>

      {onBack ? (
        <TouchableOpacity style={styles.backLink} onPress={onBack}>
          <Text style={styles.backLinkText}>← Back to dashboard</Text>
        </TouchableOpacity>
      ) : null}

      {error && <Text style={styles.error}>{error}</Text>}

      {!error && pending.length === 0 && (
        <Text style={styles.subtitle}>No pending payments right now - everything is reviewed.</Text>
      )}

      {pending.length > 0 ? (
        <View style={styles.table}>
          <View style={styles.tableHeaderRow}>
            <Text style={[styles.headerCell, styles.colHouse]}>House</Text>
            <Text style={[styles.headerCell, styles.colDate]}>Date</Text>
            <Text style={[styles.headerCell, styles.colType]}>Type</Text>
            <Text style={[styles.headerCell, styles.colAmount]}>Amount</Text>
          </View>
          {pending.map((transaction, index) => {
            const state = rowState[transaction.id] || {};
            const isRejecting = rejectingId === transaction.id;
            const isExpanded = expandedId === transaction.id;

            return (
              <View key={transaction.id} style={[styles.tableRow, index % 2 === 1 && styles.tableRowZebra]}>
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={() => setExpandedId(isExpanded ? null : transaction.id)}
                >
                  <View style={styles.tableRowLine}>
                    <Text style={[styles.cellText, styles.colHouse]} numberOfLines={1}>
                      {transaction.houses?.house_number}
                    </Text>
                    <Text style={[styles.cellText, styles.colDate, styles.cellMuted]}>
                      {formatDate(transaction.created_at)}
                    </Text>
                    <Text style={[styles.cellText, styles.colType]} numberOfLines={1}>
                      {transaction.transaction_type}
                    </Text>
                    <Text style={[styles.cellText, styles.colAmount, styles.cellAmount]}>
                      {formatMoney(transaction.amount)}
                    </Text>
                  </View>
                  {isExpanded ? (
                    <View style={styles.detailBox}>
                      <Text style={styles.detailText}>{formatPaymentReference(transaction)}</Text>
                      <Text style={styles.detailText}>{describeAllocations(transaction)}</Text>
                    </View>
                  ) : null}
                </TouchableOpacity>

                {state.error && <Text style={styles.rowError}>{state.error}</Text>}

                {!isAdmin ? (
                  <Text style={styles.viewOnlyNote}>View only - ask an Admin to verify or reject this.</Text>
                ) : isRejecting ? (
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
        </View>
      ) : null}
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
  table: {
    backgroundColor: '#fff',
    borderRadius: 10,
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
  colHouse: {
    flex: 1,
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
  rowError: {
    color: '#c0392b',
    fontSize: 13,
    marginTop: 8,
  },
  viewOnlyNote: {
    fontSize: 12,
    color: '#8a8a8e',
    fontStyle: 'italic',
    marginTop: 10,
    textAlign: 'right',
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
