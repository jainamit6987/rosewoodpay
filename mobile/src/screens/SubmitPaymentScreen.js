import { useEffect, useState } from 'react';
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
import { usePaysharpPayment } from '../hooks/usePaysharpPayment';
import { openPaymentUrl } from '../utils/upiLinking';
import UpiAppPicker from '../components/UpiAppPicker';

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
  const [mobileNoInput, setMobileNoInput] = useState('');

  // "Instant" path via PaySharp's UPI Intent API - separate from the
  // self-report flow below (amount/UTR fields, handleSubmit), which stays
  // exactly as-is as the fallback for Cash and for anyone who'd rather just
  // pay directly to the society's own UPI VPA and report the UTR. Only
  // wired up for the UPI (non-Cash) case - see the `isCash ? null : (...)`
  // guard below.
  const paysharp = usePaysharpPayment({ accessToken, house, transactionType: undefined });

  useEffect(() => {
    if (paysharp.state === 'verified' && paysharp.transaction) {
      setResult(paysharp.transaction);
    }
  }, [paysharp.state, paysharp.transaction]);

  const handleStartInstantPay = () => {
    const parsedAmount = Number(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      setError('Enter a valid amount before starting an instant UPI payment.');
      return;
    }
    setError(null);
    paysharp.start(parsedAmount);
  };

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
      // reliably, without the extra native config. On web, openPaymentUrl
      // forces a top-level navigation instead of window.open - see
      // utils/upiLinking.js for why that matters.
      await openPaymentUrl(link);
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
    // Three distinct ways to land here, each with its own true status:
    // Cash (Admin-recorded, always already Verified), the instant PaySharp
    // flow (also already Verified by the time paysharp.state hits
    // 'verified' - PaySharp's own webhook/status already confirmed it,
    // there is no separate admin review step for it), and the plain
    // self-reported UPI flow below (still Submitted, genuinely awaiting an
    // admin's manual Verify).
    const alreadyVerified = isCash || result.processing_status === 'Verified';
    const allocationCount = result.allocations ? result.allocations.length : 0;
    return (
      <View style={styles.centered}>
        <Text style={styles.successTitle}>
          {isCash ? 'Cash payment recorded' : alreadyVerified ? 'Payment confirmed' : 'Payment submitted'}
        </Text>
        <Text style={styles.subtitle}>
          Covered {allocationCount} billing period{allocationCount === 1 ? '' : 's'} for {house.house_number}.{' '}
          {alreadyVerified
            ? 'Already Verified - no further review needed.'
            : 'It will show as Verified once an admin confirms it.'}
        </Text>
        <TouchableOpacity style={styles.button} onPress={onDone}>
          <Text style={styles.buttonText}>{isCash ? 'Back to dashboard' : 'Back to dues'}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (paysharp.state === 'rejected') {
    const reason = paysharp.transaction?.gateway_failure_reason || paysharp.transaction?.rejection_reason || 'Payment failed.';
    return (
      <View style={styles.centered}>
        <Text style={[styles.successTitle, { color: '#c0392b' }]}>Payment failed</Text>
        <Text style={styles.subtitle}>{reason}</Text>
        <TouchableOpacity style={styles.button} onPress={paysharp.reset}>
          <Text style={styles.buttonText}>Try again</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (['creating', 'waiting', 'polling', 'timeout'].includes(paysharp.state)) {
    return (
      <View style={styles.centered}>
        {paysharp.state !== 'timeout' ? <ActivityIndicator size="large" color="#1a73e8" /> : null}
        <Text style={styles.successTitle}>
          {paysharp.state === 'creating'
            ? 'Creating your payment request\u2026'
            : paysharp.state === 'timeout'
            ? "Still haven't heard back"
            : 'Choose your UPI app to pay'}
        </Text>
        <Text style={styles.subtitle}>
          {paysharp.state === 'creating'
            ? 'Just a moment.'
            : paysharp.state === 'timeout'
            ? "This is taking longer than usual. If you completed the payment, tap Check again - otherwise you can cancel and use the self-report option below instead."
            : "Tap the app you have below - the amount is already filled in. This screen updates on its own once you pay, or tap Check now."}
        </Text>
        {['waiting', 'polling', 'timeout'].includes(paysharp.state) ? (
          <>
            <UpiAppPicker transaction={paysharp.transaction} onOpenApp={paysharp.openSpecificApp} />
            <TouchableOpacity style={styles.button} onPress={paysharp.checkNow}>
              <Text style={styles.buttonText}>Check {paysharp.state === 'timeout' ? 'again' : 'now'}</Text>
            </TouchableOpacity>
          </>
        ) : null}
        {paysharp.error ? <Text style={styles.error}>{paysharp.error}</Text> : null}
        <TouchableOpacity style={styles.cancelButton} onPress={paysharp.reset}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
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
            <TouchableOpacity style={styles.instantButton} onPress={handleStartInstantPay} disabled={submitting}>
              <Text style={styles.instantButtonText}>{'\u26A1 Instant UPI Payment'}</Text>
            </TouchableOpacity>
            <Text style={styles.instantHint}>
              Choose your UPI app with the amount already filled in - confirms automatically once paid, no UTR to
              copy.
            </Text>

            {paysharp.needsMobileNo ? (
              <View style={styles.coveredBox}>
                <Text style={styles.coveredLabel}>We need a mobile number on file to use Instant UPI Payment.</Text>
                <TextInput
                  style={styles.input}
                  keyboardType="phone-pad"
                  placeholder="10-digit mobile number"
                  value={mobileNoInput}
                  onChangeText={setMobileNoInput}
                />
                <TouchableOpacity
                  style={styles.button}
                  onPress={() => {
                    const parsedAmount = Number(amount);
                    if (!parsedAmount || parsedAmount <= 0) {
                      setError('Enter a valid amount first.');
                      return;
                    }
                    paysharp.start(parsedAmount, { customer_mobile_no: mobileNoInput.trim() });
                  }}
                >
                  <Text style={styles.buttonText}>Continue</Text>
                </TouchableOpacity>
              </View>
            ) : paysharp.error ? (
              <Text style={styles.error}>{paysharp.error}</Text>
            ) : null}

            <Text style={styles.orDivider}>{'\u2014 or pay to the society\u2019s own UPI ID and report it yourself \u2014'}</Text>

            <TouchableOpacity style={styles.upiButton} onPress={handlePayViaUpi} disabled={submitting}>
              <Text style={styles.upiButtonText}>Pay via UPI app</Text>
            </TouchableOpacity>

            <Text style={styles.label}>Amount paid</Text>
            <TextInput
              style={styles.input}
              keyboardType="decimal-pad"
              value={amount}
              onChangeText={setAmount}
              editable={!submitting}
            />

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

            <View style={styles.reviewNoteBox}>
              <Text style={styles.reviewNoteText}>
                This payment will be reviewed by an Admin before it's marked as Verified.
              </Text>
            </View>
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
            <Text style={styles.buttonText}>{isCash ? 'Record cash payment' : 'Submit payment details'}</Text>
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
  instantButton: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 6,
  },
  instantButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  instantHint: {
    fontSize: 12,
    color: '#777',
    textAlign: 'center',
    marginBottom: 16,
  },
  orDivider: {
    fontSize: 12,
    color: '#999',
    textAlign: 'center',
    marginBottom: 12,
  },
  reviewNoteBox: {
    backgroundColor: '#fff8e1',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  reviewNoteText: {
    fontSize: 12,
    color: '#8a6d1a',
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
