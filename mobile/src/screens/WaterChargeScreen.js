import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
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

// Same local-date (not UTC) formatting as RecordExpenseScreen's own
// toDateOnly - a water charge is tied to the specific day the extra water
// was used/paid, never a month or billing cycle (there is no billing
// period behind it at all, unlike Maintenance - see routes/transactions.js).
// No date picker yet - defaults to today, the same "day this actually
// happened" a resident/Admin is submitting on.
function toDateOnly(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Same three-bucket grouping as MyTransactionsScreen's own status badge -
// a resident cares whether a water charge payment settled, was rejected,
// or is still somewhere in between, not the exact internal stage.
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

function buildUpiDeepLink({ society, house, amount }) {
  const params = new URLSearchParams({
    pa: society.upi_vpa,
    pn: society.upi_payee_name,
    am: amount,
    tn: `Water Charge ${house.house_number}`,
    cu: 'INR',
  });
  return `upi://pay?${params.toString()}`;
}

// Resident-facing "pay for extra water" flow - the new S.No item requested
// alongside the Admin's own Cash-recording counterpart on
// HouseDashboardScreen. Deliberately its own screen, not folded into
// DuesScreen: WaterCharge is pay-as-you-go (see
// 20260803000000_add_water_charge_transaction_type.sql), there is no
// "Open" due to select the way DuesScreen's billing periods are, just a
// free-form amount decided at payment time. Still goes through the same
// Submitted -> Admin Verify/Reject review as a Maintenance UPI payment -
// only an Admin-recorded Cash entry (HouseDashboardScreen, not here) skips
// that.
//
// GET /houses/:houseId/transactions already returns every transaction for
// this house regardless of type - reused as-is and filtered client-side to
// WaterCharge rows for the history list below, rather than adding a new
// backend endpoint just to narrow a type filter that already has nowhere
// else to live but the client.
export default function WaterChargeScreen({ house, society, onBack }) {
  const { accessToken } = useAuth();
  const [amount, setAmount] = useState('');
  const [utrNumber, setUtrNumber] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [submitResult, setSubmitResult] = useState(null);

  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [historyError, setHistoryError] = useState(null);

  const loadHistory = useCallback(async () => {
    try {
      setHistoryError(null);
      const data = await apiGet(`/houses/${house.id}/transactions`, accessToken);
      setHistory((data || []).filter((txn) => txn.transaction_type === 'WaterCharge'));
    } catch (err) {
      setHistoryError(err.message);
    }
  }, [accessToken, house.id]);

  useEffect(() => {
    loadHistory().finally(() => setLoadingHistory(false));
  }, [loadHistory]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadHistory();
    setRefreshing(false);
  };

  const handlePayViaUpi = async () => {
    const parsedAmount = Number(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      setSubmitError('Enter a valid amount before opening your UPI app.');
      return;
    }
    const link = buildUpiDeepLink({ society, house, amount: parsedAmount });
    try {
      // Same direct-open (no canOpenURL pre-check) as SubmitPaymentScreen's
      // own handlePayViaUpi - see that screen's comment for why.
      await Linking.openURL(link);
    } catch {
      setSubmitError('No UPI app found on this device to handle the payment link.');
    }
  };

  const handleSubmit = async () => {
    setSubmitError(null);
    const parsedAmount = Number(amount);

    if (!parsedAmount || parsedAmount <= 0) {
      setSubmitError('Enter a valid amount.');
      return;
    }
    if (!utrNumber.trim()) {
      setSubmitError('Enter the UTR / reference number from your payment confirmation.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await apiPost('/transactions', accessToken, {
        house_id: house.id,
        amount: parsedAmount,
        transaction_type: 'WaterCharge',
        payment_mode: 'UPI',
        utr_number: utrNumber.trim(),
        txn_date: toDateOnly(new Date()),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      setSubmitResult(response);
      setAmount('');
      setUtrNumber('');
      setDescription('');
      await loadHistory();
    } catch (err) {
      // Surfaces the backend's own message as-is, same as SubmitPaymentScreen.
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      >
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Water Charges</Text>
            <Text style={styles.subtitle}>{house.house_number}</Text>
          </View>
          {onBack ? (
            <TouchableOpacity onPress={onBack}>
              <Text style={styles.backLink}>Back</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Pay for extra water</Text>
          <Text style={styles.cardHint}>
            Enter whatever amount the society has told you to pay for extra water usage - there is no fixed
            monthly rate for this.
          </Text>

          {submitResult ? (
            <View style={styles.successBox}>
              <Text style={styles.successText}>
                Submitted \u2713 It will show as Verified once an admin confirms it.
              </Text>
            </View>
          ) : null}

          <Text style={styles.label}>Amount</Text>
          <TextInput
            style={styles.input}
            keyboardType="decimal-pad"
            value={amount}
            onChangeText={setAmount}
            editable={!submitting}
            placeholder="e.g. 300"
          />

          <TouchableOpacity style={styles.upiButton} onPress={handlePayViaUpi} disabled={submitting}>
            <Text style={styles.upiButtonText}>Pay via UPI app</Text>
          </TouchableOpacity>

          <Text style={styles.label}>UTR / reference number</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. 402512345678"
            autoCapitalize="characters"
            value={utrNumber}
            onChangeText={setUtrNumber}
            editable={!submitting}
          />

          <Text style={styles.label}>Note (optional)</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. extra water tanker in July"
            value={description}
            onChangeText={setDescription}
            editable={!submitting}
          />

          {submitError ? <Text style={styles.error}>{submitError}</Text> : null}

          <TouchableOpacity
            style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitButtonText}>Submit payment</Text>}
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionHeader}>History</Text>
        {loadingHistory ? (
          <ActivityIndicator size="small" style={{ marginTop: 8 }} />
        ) : historyError ? (
          <Text style={styles.error}>{historyError}</Text>
        ) : history.length === 0 ? (
          <Text style={styles.hint}>No water charge payments submitted yet.</Text>
        ) : (
          history.map((txn) => (
            <View key={txn.id} style={styles.historyCard}>
              <View style={styles.historyCardHeader}>
                <Text style={styles.historyAmount}>{formatMoney(txn.amount)}</Text>
                <View style={[styles.badge, statusBadgeStyle(txn.processing_status)]}>
                  <Text style={[styles.badgeText, statusTextStyle(txn.processing_status)]}>{txn.processing_status}</Text>
                </View>
              </View>
              <Text style={styles.historyMeta}>
                {txn.payment_mode === 'Cash' ? 'Cash' : `UTR ${txn.utr_number}`} \u2022{' '}
                {formatDate(txn.txn_date || txn.created_at)}
              </Text>
              {txn.description ? <Text style={styles.historyMeta}>{txn.description}</Text> : null}
            </View>
          ))
        )}
      </ScrollView>
    </KeyboardAvoidingView>
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
    marginBottom: 16,
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
    color: '#1a73e8',
    fontSize: 14,
    fontWeight: '600',
    paddingTop: 4,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1c1c1e',
    marginBottom: 6,
  },
  cardHint: {
    fontSize: 13,
    color: '#6e6e73',
    marginBottom: 16,
  },
  successBox: {
    backgroundColor: '#e6f4ea',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  successText: {
    color: '#2e7d32',
    fontSize: 13,
    fontWeight: '600',
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: '#d0d0d0',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: 14,
  },
  upiButton: {
    backgroundColor: '#e8f0fe',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 16,
  },
  upiButtonText: {
    color: '#1a73e8',
    fontWeight: '600',
  },
  submitButton: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  submitButtonDisabled: {
    backgroundColor: '#a8c5ef',
  },
  submitButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: '#8a8a8e',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  hint: {
    fontSize: 13,
    color: '#6e6e73',
  },
  historyCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  historyCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  historyAmount: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1c1c1e',
  },
  historyMeta: {
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
    fontSize: 13,
    marginBottom: 12,
  },
});
