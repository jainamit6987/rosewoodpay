import { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import LoginScreen from './src/screens/LoginScreen';
import DuesScreen from './src/screens/DuesScreen';
import SubmitPaymentScreen from './src/screens/SubmitPaymentScreen';

// No navigation library on purpose: React Navigation 8.x (the version that
// supports React 19 / React Native 0.86, both pinned by this Expo SDK 57
// project) requires a custom development build and does not run in plain
// Expo Go. For three screens with a strictly linear flow (dues -> pay ->
// back to dues), a plain state-driven switch avoids that whole dependency
// and keeps this testable in Expo Go, matching the manual-UTR-entry
// decision (no native share-sheet module either) for this first pass.
// Revisit if/when the app grows enough screens to need real navigation
// (stacks, deep links, tab bars).
function AuthenticatedApp() {
  const [paymentTarget, setPaymentTarget] = useState(null);
  const { logout } = useAuth();

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
