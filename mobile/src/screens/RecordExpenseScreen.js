import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import DateField from '../components/DateField';
import { apiPost } from '../api/client';
import { useAuth } from '../context/AuthContext';

const CATEGORIES = [
  { value: 'Salary', label: 'Salary' },
  { value: 'UtilityBill', label: 'Utility Bill' },
  { value: 'Other', label: 'Other' },
];

// Kept in sync with the chk_payment_mode CHECK constraint, extended in
// 20260802000000_extend_expense_payment_modes_and_description.sql. Each
// mode's referenceLabel is what the "reference number" field is actually
// called for that mode in the real world (UTR for UPI, a bank-assigned
// reference for NEFT/IMPS, the physical cheque's own number) - Cash has
// none at all, since there is nothing to reference.
const PAYMENT_MODES = [
  { value: 'UPI', label: 'UPI', referenceLabel: 'UTR Number' },
  { value: 'Cash', label: 'Cash', referenceLabel: null },
  { value: 'NEFT_IMPS', label: 'NEFT/IMPS', referenceLabel: 'Reference Number' },
  { value: 'Cheque', label: 'Cheque', referenceLabel: 'Cheque Number' },
];

function formatMoney(amount) {
  return `\u20B9${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

function toDateOnly(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// The Admin-facing counterpart to society-level expenses (backend/src/
// routes/transactions.js's UtilityBill/Salary/Other path, added in
// 20260726010000_society_expenses_house_optional.sql but never had a
// mobile screen until now) - salary, security agency, and other misc
// payments the society itself makes, not something any house owes. There
// is no confirmed UPI-collect setup on the society's own bank account, so
// (discussed and confirmed with the user) this is bookkeeping only: the
// Admin is recording a payment that has already happened by some other
// means, not initiating one through this screen. Modeled almost
// identically to SubmitPaymentScreen's own Cash flow for that reason -
// same auto-Verified-immediately behavior, since the Admin recording it
// is already the attestation that it's real (see that migration's own
// comment for the full reasoning).
//
// Category (Salary/UtilityBill/Other) is the one field not explicitly
// requested but included anyway - transaction_type is a required column
// on this same table, and reusing the three values the schema already
// defines (rather than inventing a fourth "expense" catch-all) means
// GET /transactions/report?transaction_type=... can already filter by it
// with no further backend work. Defaults to "Other" so it never blocks
// submission for whoever doesn't care to pick a more specific one.
export default function RecordExpenseScreen({ societyId, onDone, onCancel }) {
  const { accessToken } = useAuth();
  const [category, setCategory] = useState('Other');
  const [description, setDescription] = useState('');
  const [txnDate, setTxnDate] = useState(() => new Date());
  const [amount, setAmount] = useState('');
  const [paymentMode, setPaymentMode] = useState('UPI');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [paidTo, setPaidTo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const selectedMode = PAYMENT_MODES.find((mode) => mode.value === paymentMode);
  const referenceRequired = !!selectedMode?.referenceLabel;

  const resetForm = () => {
    setCategory('Other');
    setDescription('');
    setTxnDate(new Date());
    setAmount('');
    setPaymentMode('UPI');
    setReferenceNumber('');
    setPaidTo('');
    setError(null);
    setResult(null);
  };

  const handleSubmit = async () => {
    setError(null);

    const parsedAmount = Number(amount);
    if (!amount || Number.isNaN(parsedAmount) || parsedAmount <= 0) {
      setError('Enter a valid amount greater than zero.');
      return;
    }
    if (!description.trim()) {
      setError('Enter a description of what this payment was for.');
      return;
    }
    if (!paidTo.trim()) {
      setError('Enter who (or what) this payment was made to.');
      return;
    }
    if (referenceRequired && !referenceNumber.trim()) {
      setError(`Enter the ${selectedMode.referenceLabel.toLowerCase()} - required for every mode except Cash.`);
      return;
    }

    setSubmitting(true);
    try {
      const response = await apiPost('/transactions', accessToken, {
        society_id: societyId,
        transaction_type: category,
        description: description.trim(),
        txn_date: toDateOnly(txnDate),
        amount: parsedAmount,
        payment_mode: paymentMode,
        ...(referenceRequired ? { utr_number: referenceNumber.trim() } : {}),
        payee_name: paidTo.trim(),
      });
      setResult(response);
    } catch (err) {
      // Surfaces the backend's own message as-is - e.g. the
      // already-submitted-reference-number 409 already explains itself in
      // plain language (see routes/transactions.js).
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <View style={styles.centered}>
        <Text style={styles.successTitle}>Expense recorded</Text>
        <Text style={styles.subtitle}>
          {formatMoney(result.amount)} paid to {result.payee_name} has been recorded and marked Verified.
        </Text>
        <TouchableOpacity style={styles.button} onPress={resetForm}>
          <Text style={styles.buttonText}>Record another</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.cancelButton} onPress={() => onDone?.(result)}>
          <Text style={styles.cancelButtonText}>Done</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Record Expense</Text>
        <Text style={styles.subtitle}>
          A payment the society itself made (salary, security agency, utility bills, etc.) - for bookkeeping, not a
          real payment.
        </Text>

        <Text style={styles.label}>Category</Text>
        <View style={styles.chipRow}>
          {CATEGORIES.map((cat) => (
            <TouchableOpacity
              key={cat.value}
              style={[styles.chip, category === cat.value && styles.chipActive]}
              onPress={() => setCategory(cat.value)}
              disabled={submitting}
            >
              <Text style={[styles.chipText, category === cat.value && styles.chipTextActive]}>{cat.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.label}>Description</Text>
        <TextInput
          style={[styles.input, styles.multilineInput]}
          placeholder="e.g. July security guard salary"
          value={description}
          onChangeText={setDescription}
          multiline
          numberOfLines={3}
          editable={!submitting}
        />

        <Text style={styles.label}>Transaction Date</Text>
        <DateField value={txnDate} onChange={setTxnDate} maximumDate={new Date()} disabled={submitting} />

        <Text style={styles.label}>Amount</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. 15000"
          keyboardType="numeric"
          value={amount}
          onChangeText={setAmount}
          editable={!submitting}
        />

        <Text style={styles.label}>Payment Mode</Text>
        <View style={styles.chipRow}>
          {PAYMENT_MODES.map((mode) => (
            <TouchableOpacity
              key={mode.value}
              style={[styles.chip, paymentMode === mode.value && styles.chipActive]}
              onPress={() => setPaymentMode(mode.value)}
              disabled={submitting}
            >
              <Text style={[styles.chipText, paymentMode === mode.value && styles.chipTextActive]}>{mode.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {referenceRequired ? (
          <>
            <Text style={styles.label}>{selectedMode.referenceLabel}</Text>
            <TextInput
              style={styles.input}
              placeholder={`Enter the ${selectedMode.referenceLabel.toLowerCase()}`}
              autoCapitalize="none"
              autoCorrect={false}
              value={referenceNumber}
              onChangeText={setReferenceNumber}
              editable={!submitting}
            />
          </>
        ) : (
          <Text style={styles.helper}>Cash has no reference number to record.</Text>
        )}

        <Text style={styles.label}>Paid To</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. XYZ Security Agency"
          value={paidTo}
          onChangeText={setPaidTo}
          editable={!submitting}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.button, submitting && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
        >
          {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Record Expense</Text>}
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
    marginBottom: 16,
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
  multilineInput: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 16,
  },
  chip: {
    borderWidth: 1,
    borderColor: '#d0d0d0',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  chipActive: {
    backgroundColor: '#e8f0fe',
    borderColor: '#1a73e8',
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6e6e73',
  },
  chipTextActive: {
    color: '#1a73e8',
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
