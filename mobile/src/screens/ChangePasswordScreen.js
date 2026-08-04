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
import { useAuth } from '../context/AuthContext';

const MIN_PASSWORD_LENGTH = 6;

// Self-service "change my own password" for an already-logged-in member -
// no email/SMTP involved (there is none configured in this project - see
// backend/src/routes/members.js's own note), so this is the entire
// password-change surface for now: an Admin resetting someone ELSE's
// forgotten password, and a true pre-login "forgot password" email flow,
// are both separate, not-yet-built features. Reachable from both
// AdminHomeScreen and ResidentHomeScreen's Settings/More sections - the
// same account-level action regardless of which mode a bothAvailable
// member happens to be viewing right now.
export default function ChangePasswordScreen({ onDone, onCancel }) {
  const { changePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const handleSubmit = async () => {
    setError(null);

    if (!currentPassword) {
      setError('Enter your current password.');
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    if (newPassword === currentPassword) {
      setError('New password must be different from your current password.');
      return;
    }

    setSubmitting(true);
    const result = await changePassword(currentPassword, newPassword);
    setSubmitting(false);

    if (!result.success) {
      setError(result.error);
      return;
    }
    setDone(true);
  };

  if (done) {
    return (
      <View style={styles.centered}>
        <Text style={styles.successTitle}>Password changed</Text>
        <Text style={styles.subtitle}>Use your new password the next time you sign in.</Text>
        <TouchableOpacity style={styles.button} onPress={() => onDone?.()}>
          <Text style={styles.buttonText}>Done</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Change Password</Text>
        <Text style={styles.subtitle}>You'll need your current password to confirm it's really you.</Text>

        <Text style={styles.label}>Current Password</Text>
        <TextInput
          style={styles.input}
          placeholder="Current password"
          secureTextEntry
          value={currentPassword}
          onChangeText={setCurrentPassword}
          editable={!submitting}
        />

        <Text style={styles.label}>New Password</Text>
        <TextInput
          style={styles.input}
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          secureTextEntry
          value={newPassword}
          onChangeText={setNewPassword}
          editable={!submitting}
        />

        <Text style={styles.label}>Confirm New Password</Text>
        <TextInput
          style={styles.input}
          placeholder="Re-enter new password"
          secureTextEntry
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          editable={!submitting}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.button, submitting && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
        >
          {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Change Password</Text>}
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
  input: {
    borderWidth: 1,
    borderColor: '#d0d0d0',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: 16,
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
