import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { apiPost } from '../api/client';
import { useAuth } from '../context/AuthContext';

function buildUpiDeepLink({ society, house, amount }) {
  const params = new URLSearchParams({
    pa: society.upi_vpa,
    pn: society.upi_payee_name,
    am: amount,
    tn: `Maintenance ${house.house_number}`,
    cu: 'INR',
  });
  return `upi://pay?${params.toString()}`;
}

function formatMonth(periodMonth) {
  return new Date(periodMonth).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

// Sum of the periods the resident picked on the Dues screen - just used to
// seed the Amount field below. The resident can still edit the amount
// freely; the backend (routes/transactions.js) is the source of truth for
// which periods actually get paid off and always applies FIFO from the
// oldest open period regardless of what was selected here.
function sumAmountDue(periods) {
  return (periods || []).reduce((sum, p) => sum + Number(p.amount_due), 0);
}

// paymentMode defaults to 'UPI' - the only mode this screen supported
// before Cash existed, and still the entire resident self-service flow
// (UPI deep link + UTR entry) below. 'Cash' is the Admin-only counterpart
// (see HouseDashboardScreen's "Submit Cash Payment" link, the only place
// that passes it): no UTR to collect, no UPI app to open - the backend
// (routes/transactions.js) auto-Verifies a Cash submission immediately, so
// this screen's own copy/success message reflects that instead of "will
// show as Verified once an admin confirms it".
export default function SubmitPaymentScreen({ house, society, selectedPeriods, paymentMode, onDone, onCancel }) {
  const { accessToken } = useAuth();
  const isCash = paymentMode === 'Cash';
  const [amount, setAmount] = useState(
    selectedPeriods && selectedPeriods.length > 0 ? String(sumAmountDue(selectedPeriods)) : ''
  );
  const [utrNumber, setUtrNumber] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const handlePayViaUpi = async () => {
    const parsedAmount = Number(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      setError('Enter a valid amount before opening your UPI app.');
      return;
    }
    const link = buildUpiDeepLink({ society, house, amount: parsedAmount });
    try {
      // Deliberately skips Linking.canOpenURL() and opens directly instead.
      // canOpenURL for a custom scheme like upi:// is unreliable on Android
      // 11+ unless the scheme is declared via a config plugin (a
      // custom-dev-client requirement) - the same native-config complexity
      // this whole screen is avoiding for this pass. openURL's own
      // rejection already tells us "no app can handle this" just as
      // reliably, without the extra native config.
      await Linking.openURL(link);
    } catch {
      setError('No UPI app found on this device to handle the payment link.');
    }
  };

  const handleSubmit = async () => {
    setError(null);
    const parsedAmount = Number(amount);

    if (!parsedAmount || parsedAmount <= 0) {
      setError('Enter a valid amount.');
      return;
    }
    if (!isCash && !utrNumber.trim()) {
      setError('Enter the UTR / reference number from your payment confirmation.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await apiPost('/transactions', accessToken, {
        house_id: house.id,
        amount: parsedAmount,
        payment_mode: paymentMode || 'UPI',
        ...(isCash ? {} : { utr_number: utrNumber.trim() }),
      });
      setResult(response);
    } catch (err) {
      // Surfaces the backend's own message as-is - e.g. the base-amount-
      // multiple rejection or a duplicate-UTR conflict already explain
      // themselves in plain language (see routes/transactions.js).
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <View style={styles.centered}>
        <Text style={styles.successTitle}>{isCash ? 'Cash payment recorded' : 'Payment submitted'}</Text>
        <Text style={styles.subtitle}>
          Covered {result.allocations.length} billing period{result.allocations.length === 1 ? '' : 's'} for{' '}
          {house.house_number}.{' '}
          {isCash ? 'Already Verified - no further review needed.' : 'It will show as Verified once an admin confirms it.'}
        </Text>
        <TouchableOpacity style={styles.button} onPress={onDone}>
          <Text style={styles.buttonText}>{isCash ? 'Back to dashboard' : 'Back to dues'}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{isCash ? `Record cash payment for ${house.house_number}` : `Pay for ${house.house_number}`}</Text>
        <Text style={styles.subtitle}>
          {isCash
            ? "Only for cash actually received in hand - this is recorded as already Verified immediately, no separate review step."
            : 'Pay for one or more full months - partial-month amounts are not accepted.'}
        </Text>

        {selectedPeriods && selectedPeriods.length > 0 ? (
          <View style={styles.coveredBox}>
            <Text style={styles.coveredLabel}>
              Selected on the dues screen ({selectedPeriods.length} month
              {selectedPeriods.length === 1 ? '' : 's'}):
            </Text>
            <Text style={styles.coveredMonths}>
              {selectedPeriods.map((p) => formatMonth(p.period_month)).join(', ')}
            </Text>
            <Text style={styles.coveredNote}>
              You can still change the amount below to cover more or fewer whole months - the oldest
              open month is always paid first.
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
        />

        {isCash ? null : (
          <>
            <TouchableOpacity style={styles.upiButton} onPress={handlePayViaUpi} disabled={submitting}>
              <Text style={styles.upiButtonText}>Pay via UPI app</Text>
            </TouchableOpacity>

            <Text style={styles.label}>UTR / reference number</Text>
            <Text style={styles.helper}>
              After paying, copy the 12-digit UTR (or reference number) from your UPI app's
              confirmation screen and paste it here.
            </Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. 402512345678"
              autoCapitalize="characters"
              value={utrNumber}
              onChangeText={setUtrNumber}
              editable={!submitting}
            />
          </>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.button, submitting && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>{isCash ? 'Record cash payment' : 'Submit payment'}</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.cancelButton} onPress={onCancel} disabled={submitting}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
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
    gap: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#555',
    marginBottom: 20,
    textAlign: 'center',
  },
  coveredBox: {
    backgroundColor: '#f5f6f8',
    borderRadius: 8,
    padding: 12,
    marginBottom: 20,
  },
  coveredLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
    marginBottom: 4,
  },
  coveredMonths: {
    fontSize: 14,
    color: '#1a73e8',
    fontWeight: '600',
    marginBottom: 6,
  },
  coveredNote: {
    fontSize: 12,
    color: '#777',
  },
  successTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#2e7d32',
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
    marginBottom: 6,
  },
  helper: {
    fontSize: 12,
    color: '#777',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#d0d0d0',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: 16,
  },
  upiButton: {
    backgroundColor: '#e8f0fe',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 20,
  },
  upiButtonText: {
    color: '#1a73e8',
    fontWeight: '600',
  },
  error: {
    color: '#c0392b',
    marginBottom: 12,
    fontSize: 14,
  },
  button: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonDisabled: {
    backgroundColor: '#a8c5ef',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  cancelButton: {
    alignItems: 'center',
    marginTop: 16,
  },
  cancelButtonText: {
    color: '#777',
    fontSize: 14,
  },
});
