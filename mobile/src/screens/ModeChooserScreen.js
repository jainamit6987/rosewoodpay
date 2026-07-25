import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

// Shown once, right after login, only for a member who genuinely has both
// capabilities available - is_admin/is_committee_member AND at least one
// house assignment (see App.js). A member with only one of the two never
// sees this screen at all; they land directly on the one view that applies.
export default function ModeChooserScreen({ societyName, onChooseResident, onChooseAdmin, onLogout }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{societyName}</Text>
      <Text style={styles.subtitle}>You have both resident and admin/committee access. Continue as:</Text>

      <TouchableOpacity style={styles.optionButton} onPress={onChooseResident}>
        <Text style={styles.optionTitle}>Resident</Text>
        <Text style={styles.optionDescription}>View and pay your own maintenance dues</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.optionButton} onPress={onChooseAdmin}>
        <Text style={styles.optionTitle}>Admin / Committee</Text>
        <Text style={styles.optionDescription}>Review and verify pending payments across the society</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={onLogout}>
        <Text style={styles.signOutLink}>Sign out</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f7',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1c1c1e',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: '#6e6e73',
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 32,
  },
  optionButton: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 20,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  optionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#1c1c1e',
    marginBottom: 4,
  },
  optionDescription: {
    fontSize: 13,
    color: '#6e6e73',
  },
  signOutLink: {
    color: '#1a73e8',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 16,
  },
});
