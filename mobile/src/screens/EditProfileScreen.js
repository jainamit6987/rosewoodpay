import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { apiPatch } from '../api/client';
import { useAuth } from '../context/AuthContext';

// Self-service counterpart to the Admin-only MemberDetailScreen edit form -
// a resident (or a pure-Admin member with no house of their own, see
// App.js's onEditProfile wiring, same shape as onChangePassword there)
// updating their OWN name/phone_number, via the new PATCH /me/profile
// (backend/src/routes/me.js) - previously this data was only ever set by
// an Admin at account-creation time or edited via PATCH /members/:id.
//
// Email is shown read-only with a short explanation rather than omitted
// entirely - a resident asking "why can't I change my email here" is a
// support question worth heading off, not just missing UI. See
// 20260913000000_allow_resident_self_service_profile_update.sql's own
// comment for why this is out of scope for now (email lives on
// auth.users, not society_members, and changing a login identifier is a
// bigger, separate decision than a contact-detail edit).
export default function EditProfileScreen({ membership, userEmail, onSaved, onCancel }) {
  const { accessToken } = useAuth();
  const [name, setName] = useState(membership?.name || '');
  const [phoneNumber, setPhoneNumber] = useState(membership?.phoneNumber || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleSave = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Name cannot be empty.');
      return;
    }

    setSubmitting(true);
    try {
      await apiPatch('/me/profile', accessToken, {
        society_member_id: membership.id,
        name: name.trim(),
        // Sending null (not omitting) clears a previously-set number -
        // matches PATCH /members/:id's own phone_number handling, and
        // avoids an empty string tripping the backend's format check.
        phone_number: phoneNumber.trim() || null,
      });
      onSaved();
    } catch (err) {
      // Surfaces the backend's own message as-is - e.g. its phone_number
      // format error already explains itself in plain language.
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Edit Profile</Text>
        <Text style={styles.subtitle}>Update your own contact details.</Text>

        <Text style={styles.label}>Name</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} editable={!submitting} placeholder="Your full name" />

        <Text style={styles.label}>Mobile Number</Text>
        <TextInput
          style={styles.input}
          value={phoneNumber}
          onChangeText={setPhoneNumber}
          editable={!submitting}
          keyboardType="phone-pad"
          placeholder="e.g. 9876543210"
        />

        <Text style={styles.label}>Email</Text>
        <View style={styles.readOnlyBox}>
          <Text style={styles.readOnlyValue}>{userEmail || '\u2014'}</Text>
        </View>
        <Text style={styles.helper}>
          Email can't be changed here yet - contact your society Admin if this needs to be updated.
        </Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity style={[styles.button, submitting && styles.buttonDisabled]} onPress={handleSave} disabled={submitting}>
          {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Save changes</Text>}
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
    paddingTop: 48,
    paddingBottom: 40,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1c1c1e',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#6e6e73',
    marginBottom: 24,
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
  readOnlyBox: {
    backgroundColor: '#f5f5f7',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 6,
  },
  readOnlyValue: {
    fontSize: 16,
    color: '#6e6e73',
  },
  helper: {
    fontSize: 12,
    color: '#8a8a8e',
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
