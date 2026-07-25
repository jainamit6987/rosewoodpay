import { useCallback, useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { apiGet } from './src/api/client';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import LoginScreen from './src/screens/LoginScreen';
import DuesScreen from './src/screens/DuesScreen';
import SubmitPaymentScreen from './src/screens/SubmitPaymentScreen';
import AdminReviewScreen from './src/screens/AdminReviewScreen';
import ModeChooserScreen from './src/screens/ModeChooserScreen';

// No navigation library on purpose: React Navigation 8.x (the version that
// supports React 19 / React Native 0.86, both pinned by this Expo SDK 57
// project) requires a custom development build and does not run in plain
// Expo Go. For a small, strictly linear set of flows (dues -> pay -> back
// to dues; admin review; an optional one-time mode choice between the two),
// a plain state-driven switch avoids that whole dependency and keeps this
// testable in Expo Go, matching the manual-UTR-entry decision (no native
// share-sheet module either) for this first pass. Revisit if/when the app
// grows enough screens to need real navigation (stacks, deep links, tab
// bars).
function AuthenticatedApp() {
  const [paymentTarget, setPaymentTarget] = useState(null);
  // null = no explicit choice made yet. Only matters when both resident and
  // admin/committee access are available - see hasResidentAccess/
  // hasAdminAccess below; when only one applies there is nothing to choose
  // and this stays null forever without affecting which screen renders.
  const [mode, setMode] = useState(null);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { accessToken, logout } = useAuth();

  // A single /me fetch, done once here, is enough to decide which of the
  // resident/admin views (or the chooser between them) applies - is_admin/
  // is_committee_member and "has a house assignment" are independent facts
  // about the same member (see backend/src/routes/me.js), never an
  // either-or. DuesScreen does its own separate /me fetch for its own
  // display data; duplicating this cheap, side-effect-free GET is an
  // accepted MVP tradeoff against lifting all of /me's state up here.
  const loadMe = useCallback(async () => {
    try {
      setError(null);
      const data = await apiGet('/me', accessToken);
      setMe(data);
    } catch (err) {
      setError(err.message);
    }
  }, [accessToken]);

  useEffect(() => {
    loadMe().finally(() => setLoading(false));
  }, [loadMe]);

  const handleRetry = () => {
    setLoading(true);
    loadMe().finally(() => setLoading(false));
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  const membership = me?.memberships?.[0];

  if (error || !membership) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{error || 'No society membership found for this account.'}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={handleRetry}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const hasResidentAccess = (membership.houseAssignments || []).length > 0;
  const hasAdminAccess = membership.isAdmin || membership.isCommitteeMember;
  const bothAvailable = hasResidentAccess && hasAdminAccess;

  if (bothAvailable && mode === null) {
    return (
      <ModeChooserScreen
        societyName={membership.society?.name}
        onChooseResident={() => setMode('resident')}
        onChooseAdmin={() => setMode('admin')}
        onLogout={logout}
      />
    );
  }

  if (paymentTarget) {
    return (
      <SubmitPaymentScreen
        house={paymentTarget.house}
        society={paymentTarget.society}
        selectedPeriods={paymentTarget.selectedPeriods}
        onDone={() => setPaymentTarget(null)}
        onCancel={() => setPaymentTarget(null)}
      />
    );
  }

  const effectiveMode = mode || (hasAdminAccess ? 'admin' : 'resident');

  if (effectiveMode === 'admin') {
    // Goes straight back to Dues, not back to the chooser - re-asking
    // "Resident or Admin?" every time someone taps a screen labeled
    // "Back to my dues" would be a bait-and-switch, not a real back button.
    return <AdminReviewScreen onBack={bothAvailable ? () => setMode('resident') : undefined} onLogout={logout} />;
  }

  // No admin entry point here on purpose - once "Resident" is chosen (or
  // is the only thing available), this screen is the entire experience.
  // Getting to Admin/Committee from here means logging out and choosing
  // again, not a shortcut on this screen - see the note in DuesScreen.js.
  return <DuesScreen onPayHouse={setPaymentTarget} onLogout={logout} />;
}

function RootNavigator() {
  const { isCheckingSession, isSignedIn } = useAuth();

  if (isCheckingSession) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return isSignedIn ? <AuthenticatedApp /> : <LoginScreen />;
}

export default function App() {
  return (
    <AuthProvider>
      <RootNavigator />
      <StatusBar style="auto" />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f5f5f7',
    padding: 24,
  },
  error: {
    color: '#c0392b',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: '#1a73e8',
    borderRadius: 6,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  retryButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
});
