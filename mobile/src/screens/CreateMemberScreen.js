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
import { apiPost } from '../api/client';
import { useAuth } from '../context/AuthContext';

// POST /members (backend/src/routes/members.js) - Admin-only. Creates a
// brand-new login (email + either a chosen password or an auto-generated
// one) plus the society_members row, but deliberately does NOT link them
// to a house - that stays a separate step, either via the House
// Dashboard's own Edit-mode "+ Add resident" flow (once built) or the
// Assignments feature directly. This screen is purely "get this person
// into the system with a name, login, and role", nothing more - mirroring
// the backend route's own comment.
export default function CreateMemberScreen({ societyId, onDone, onCancel }) {
  const { accessToken } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [isCommitteeMember, setIsCommitteeMember] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const handleSubmit = async () => {
    setError(null);

    if (!name.trim()) {
      setError('Enter the member\'s name.');
      return;
    }
    if (!email.trim()) {
      setError('Enter a valid email address.');
      return;
    }
    if (password && password.length < 6) {
      setError('If setting a password, it must be at least 6 characters - or leave it blank to auto-generate one.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await apiPost('/members', accessToken, {
        society_id: societyId,
        name: name.trim(),
        email: email.trim(),
        ...(password ? { password } : {}),
        ...(phoneNumber.trim() ? { phone_number: phoneNumber.trim() } : {}),
        is_admin: isAdmin,
        is_committee_member: isCommitteeMember,
      });
      setResult(response);
    } catch (err) {
      // Surfaces the backend's own message as-is - e.g. the
      // already-registered-email 409 already explains itself in plain
      // language (see routes/members.js).
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <View style={styles.centered}>
        <Text style={styles.successTitle}>Member created</Text>
        <Text style={styles.subtitle}>
          {result.name} ({result.email}) has been added to the society, Active.
        </Text>
        {result.temporaryPassword ? (
          <View style={styles.tempPasswordBox}>
            <Text style={styles.tempPasswordLabel}>Temporary password (shown only once)</Text>
            <Text style={styles.tempPasswordValue}>{result.temporaryPassword}</Text>
            <Text style={styles.tempPasswordHint}>Share this with them directly - it will not be shown again.</Text>
          </View>
        ) : null}
        <TouchableOpacity style={styles.button} onPress={() => onDone?.(result)}>
          <Text style={styles.buttonText}>Done</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>New Member</Text>
        <Text style={styles.subtitle}>Creates a login for this person - linking them to a house is a separate step.</Text>

        <Text style={styles.label}>Name</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. Priya Sharma"
          value={name}
          onChangeText={setName}
          editable={!submitting}
        />

        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. priya@example.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          value={email}
          onChangeText={setEmail}
          editable={!submitting}
        />

        <Text style={styles.label}>Mobile Number (optional)</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. +91 90000 09999"
          keyboardType="phone-pad"
          value={phoneNumber}
          onChangeText={setPhoneNumber}
          editable={!submitting}
        />

        <Text style={styles.label}>Password (optional)</Text>
        <Text style={styles.helper}>Leave blank to auto-generate a temporary one, shown once after creation.</Text>
        <TextInput
          style={styles.input}
          placeholder="At least 6 characters"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          editable={!submitting}
        />

        <Text style={styles.label}>Role</Text>
        <View style={styles.roleRow}>
          <TouchableOpacity
            style={[styles.roleChip, isAdmin && styles.roleChipActive]}
            onPress={() => setIsAdmin((v) => !v)}
            disabled={submitting}
          >
            <Text style={[styles.roleChipText, isAdmin && styles.roleChipTextActive]}>Admin</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.roleChip, isCommitteeMember && styles.roleChipActive]}
            onPress={() => setIsCommitteeMember((v) => !v)}
            disabled={submitting}
          >
            <Text style={[styles.roleChipText, isCommitteeMember && styles.roleChipTextActive]}>Committee</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.helper}>Leave both off for a plain resident with no admin/committee powers.</Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.button, submitting && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
        >
          {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Create Member</Text>}
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
  tempPasswordBox: {
    backgroundColor: '#f5f6f8',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    width: '100%',
  },
  tempPasswordLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#333',
    marginBottom: 6,
  },
  tempPasswordValue: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a73e8',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  tempPasswordHint: {
    fontSize: 12,
    color: '#777',
    textAlign: 'center',
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
  roleRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 8,
  },
  roleChip: {
    borderWidth: 1,
    borderColor: '#d0d0d0',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  roleChipActive: {
    backgroundColor: '#e8f0fe',
    borderColor: '#1a73e8',
  },
  roleChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6e6e73',
  },
  roleChipTextActive: {
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
