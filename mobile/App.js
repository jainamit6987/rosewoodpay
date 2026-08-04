import { useCallback, useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { apiGet } from './src/api/client';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import LoginScreen from './src/screens/LoginScreen';
import DuesScreen from './src/screens/DuesScreen';
import SubmitPaymentScreen from './src/screens/SubmitPaymentScreen';
import AdminReviewScreen from './src/screens/AdminReviewScreen';
import AdminHomeScreen from './src/screens/AdminHomeScreen';
import HousesScreen from './src/screens/HousesScreen';
import ModeChooserScreen from './src/screens/ModeChooserScreen';
import BillingHistoryScreen from './src/screens/BillingHistoryScreen';
import MyTransactionsScreen from './src/screens/MyTransactionsScreen';
import SocietyScreen from './src/screens/SocietyScreen';
import ResidentHomeScreen from './src/screens/ResidentHomeScreen';
import SelectHouseScreen from './src/screens/SelectHouseScreen';
import HouseDashboardScreen from './src/screens/HouseDashboardScreen';
import HouseTransactionsScreen from './src/screens/HouseTransactionsScreen';
import MembersScreen from './src/screens/MembersScreen';
import CreateMemberScreen from './src/screens/CreateMemberScreen';
import MemberDetailScreen from './src/screens/MemberDetailScreen';
import PendencyReportScreen from './src/screens/PendencyReportScreen';
import TransactionReportScreen from './src/screens/TransactionReportScreen';
import RecordExpenseScreen from './src/screens/RecordExpenseScreen';
import WaterChargeScreen from './src/screens/WaterChargeScreen';
import ChangePasswordScreen from './src/screens/ChangePasswordScreen';

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
  const [historyTarget, setHistoryTarget] = useState(null);
  // Which house-assignment's dashboard the resident is currently looking at
  // - stored as just an id, not the whole object, and re-resolved against
  // the latest houseAssignments on every render below, so a pull-to-refresh
  // actually reflects updated dues/currentPeriod/lastPayment instead of
  // showing a stale snapshot from whenever it was first selected. Null
  // means "not chosen yet" (only relevant with more than one house - with
  // exactly one, the chooser is skipped and this stays unused for the
  // session). payDuesHouseId is a further, separate drill-down from that
  // dashboard into DuesScreen's own period-selection UI, scoped to the same
  // one house.
  const [residentAssignmentId, setResidentAssignmentId] = useState(null);
  const [payDuesHouseId, setPayDuesHouseId] = useState(null);
  // Admin counterpart to payDuesHouseId above, for the "Submit Cash
  // Payment" link on an arbitrary house's dashboard (see
  // houseDashboardTarget below) - holds the whole house object (DuesScreen's
  // cashForHouse prop), not just an id, for the same reason
  // houseDashboardTarget does: there is no /me-derived assignment to
  // re-resolve this against for a house that may not be the Admin's own.
  const [cashDuesTarget, setCashDuesTarget] = useState(null);
  // The Admin/Committee counterpart to residentAssignmentId above - which
  // house's own dashboard an Admin/Committee member drilled into from a
  // HousesScreen search result. A plain house object (not just an id) is
  // fine to hold here, unlike the resident flow: this is never re-derived
  // from /me (which only ever describes the caller's own assignments), it
  // is only ever used as HouseDashboardScreen's initial prop plus a target
  // to hand onward to BillingHistoryScreen/HouseTransactionsScreen - the
  // dashboard screen itself re-fetches its own live data on load/refresh.
  const [houseDashboardTarget, setHouseDashboardTarget] = useState(null);
  const [houseTransactionsTarget, setHouseTransactionsTarget] = useState(null);
  // Boolean, not an object like historyTarget/paymentTarget above - unlike
  // billing history or a payment, "my transactions" is never scoped to one
  // house, it already aggregates across every house the caller is assigned
  // to (see GET /transactions/mine), so there is nothing house-specific to
  // carry through this state slot.
  const [showMyTransactions, setShowMyTransactions] = useState(false);
  // Resident's own "pay for extra water" spoke off ResidentHomeScreen - a
  // {house, society} pair (WaterChargeScreen needs both, same shape as
  // paymentTarget above), not just a boolean, since the screen builds its
  // own UPI deep link from society.upi_vpa/upi_payee_name.
  const [waterChargeTarget, setWaterChargeTarget] = useState(null);
  // Same reasoning as showMyTransactions above - plain booleans, not
  // objects, since neither GET /society nor the houses list is ever scoped
  // to one house/target. Both are spokes off AdminHomeScreen now (see
  // effectiveMode below) - reachable only from there, once effectiveMode is
  // already 'admin', so there is no separate access check needed here.
  const [showSociety, setShowSociety] = useState(false);
  // Drill-down from a specific society card on SocietyScreen (see that
  // screen's own "View Pendency Report" link) - a whole society object,
  // not just an id, since PendencyReportScreen needs its name for the
  // report header/export title and SocietyScreen already has the full
  // object in hand from its own GET /society call.
  const [pendencyReportTarget, setPendencyReportTarget] = useState(null);
  // Same shape/reasoning as pendencyReportTarget above - a second,
  // independent spoke off the same society card on SocietyScreen (see that
  // screen's own report tiles), not a variant of the pendency report.
  const [transactionReportTarget, setTransactionReportTarget] = useState(null);
  const [showHouses, setShowHouses] = useState(false);
  const [showReviewQueue, setShowReviewQueue] = useState(false);
  // Members hub spokes off AdminHomeScreen, same shape as showHouses/
  // houseDashboardTarget above: a boolean for the search directory itself,
  // plus a target for the one drill-down off it (MemberDetailScreen).
  // showCreateMember is its own separate flag, not a "target" object -
  // unlike editing/viewing an existing member, there is no existing
  // record to carry through, just society_id (derived from membership
  // below, not stored here).
  const [showMembers, setShowMembers] = useState(false);
  const [showCreateMember, setShowCreateMember] = useState(false);
  const [memberDetailTarget, setMemberDetailTarget] = useState(null);
  // Another AdminHomeScreen spoke, same "just a boolean, no target object"
  // shape as showHouses/showMembers - a society-level expense has no
  // existing record to carry through either, just society_id (derived
  // from membership below, not stored here), same reasoning as
  // showCreateMember above.
  const [showRecordExpense, setShowRecordExpense] = useState(false);
  // Account-level, not mode-specific - reachable from both AdminHomeScreen
  // and ResidentHomeScreen's Settings/More sections, same boolean-flag shape
  // as showRecordExpense/showCreateMember above (nothing existing to carry
  // through, just the current session ChangePasswordScreen already gets via
  // useAuth() itself).
  const [showChangePassword, setShowChangePassword] = useState(false);
  // null = no explicit choice made yet. Only matters when both resident and
  // admin/committee access are available - see hasResidentAccess/
  // hasAdminAccess below; when only one applies there is nothing to choose
  // and this stays null forever without affecting which screen renders.
  const [mode, setMode] = useState(null);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
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

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadMe();
    setRefreshing(false);
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
    // Cancelling deliberately only drops paymentTarget, not
    // payDuesHouseId/cashDuesTarget (whichever led here) - falling through
    // to that still-set state below lands back on the period-selection
    // screen, not the dashboard, so a resident/Admin who backs out of the
    // amount step doesn't lose their month selection. Finishing (onDone)
    // clears both, matching this screen's own "Back to dues"/"Back to
    // dashboard" button copy (see SubmitPaymentScreen) - a completed cash
    // payment has nothing left to re-select on the now-closed period(s), so
    // it goes all the way back to the dashboard instead.
    const isCashFlow = paymentTarget.paymentMode === 'Cash';
    return (
      <SubmitPaymentScreen
        house={paymentTarget.house}
        society={paymentTarget.society}
        selectedPeriods={paymentTarget.selectedPeriods}
        paymentMode={paymentTarget.paymentMode}
        onDone={() => {
          setPaymentTarget(null);
          if (isCashFlow) setCashDuesTarget(null);
        }}
        onCancel={() => setPaymentTarget(null)}
      />
    );
  }

  if (payDuesHouseId) {
    return (
      <DuesScreen houseId={payDuesHouseId} onPayHouse={setPaymentTarget} onBack={() => setPayDuesHouseId(null)} />
    );
  }

  if (cashDuesTarget) {
    return (
      <DuesScreen
        cashForHouse={cashDuesTarget}
        onPayHouse={setPaymentTarget}
        onBack={() => setCashDuesTarget(null)}
      />
    );
  }

  if (historyTarget) {
    return <BillingHistoryScreen house={historyTarget} onBack={() => setHistoryTarget(null)} />;
  }

  if (houseTransactionsTarget) {
    return <HouseTransactionsScreen house={houseTransactionsTarget} onBack={() => setHouseTransactionsTarget(null)} />;
  }

  // Checked before houseDashboardTarget/showMembers below - a resident
  // card tapped from either the House Dashboard or the Members directory
  // sets this on top of whichever of those is still set underneath it, so
  // backing out of the detail screen (which only ever clears this one
  // piece of state) lands back on whichever of those the Admin came from,
  // not further back than that.
  if (memberDetailTarget) {
    return <MemberDetailScreen member={memberDetailTarget} onBack={() => setMemberDetailTarget(null)} />;
  }

  if (houseDashboardTarget) {
    return (
      <HouseDashboardScreen
        house={houseDashboardTarget}
        onViewTransactions={() => setHouseTransactionsTarget(houseDashboardTarget)}
        onViewHistory={() => setHistoryTarget(houseDashboardTarget)}
        onSubmitCashPayment={() => setCashDuesTarget(houseDashboardTarget)}
        onSelectMember={setMemberDetailTarget}
        onBack={() => setHouseDashboardTarget(null)}
      />
    );
  }

  if (showMyTransactions) {
    return <MyTransactionsScreen onBack={() => setShowMyTransactions(false)} />;
  }

  if (waterChargeTarget) {
    return (
      <WaterChargeScreen
        house={waterChargeTarget.house}
        society={waterChargeTarget.society}
        onBack={() => setWaterChargeTarget(null)}
      />
    );
  }

  // Checked before showSociety below - a drill-down set on top of it, same
  // "clearing this one piece of state falls back to whichever screen
  // underneath is still set" shape as memberDetailTarget/houseDashboardTarget.
  if (pendencyReportTarget) {
    return (
      <PendencyReportScreen society={pendencyReportTarget} onBack={() => setPendencyReportTarget(null)} />
    );
  }

  if (transactionReportTarget) {
    return (
      <TransactionReportScreen society={transactionReportTarget} onBack={() => setTransactionReportTarget(null)} />
    );
  }

  if (showSociety) {
    return (
      <SocietyScreen
        onBack={() => setShowSociety(false)}
        onViewPendencyReport={setPendencyReportTarget}
        onViewTransactionReport={setTransactionReportTarget}
      />
    );
  }

  if (showHouses) {
    return <HousesScreen onBack={() => setShowHouses(false)} onSelectHouse={setHouseDashboardTarget} />;
  }

  if (showCreateMember) {
    return (
      <CreateMemberScreen
        societyId={membership.society?.id}
        onDone={() => setShowCreateMember(false)}
        onCancel={() => setShowCreateMember(false)}
      />
    );
  }

  if (showMembers) {
    return (
      <MembersScreen
        onBack={() => setShowMembers(false)}
        onSelectMember={setMemberDetailTarget}
        onCreateMember={() => setShowCreateMember(true)}
      />
    );
  }

  if (showRecordExpense) {
    return (
      <RecordExpenseScreen
        societyId={membership.society?.id}
        onDone={() => setShowRecordExpense(false)}
        onCancel={() => setShowRecordExpense(false)}
      />
    );
  }

  if (showChangePassword) {
    return (
      <ChangePasswordScreen
        onDone={() => setShowChangePassword(false)}
        onCancel={() => setShowChangePassword(false)}
      />
    );
  }

  if (showReviewQueue) {
    return <AdminReviewScreen onBack={() => setShowReviewQueue(false)} />;
  }

  const effectiveMode = mode || (hasAdminAccess ? 'admin' : 'resident');

  if (effectiveMode === 'admin') {
    // "Switch to Resident view" goes straight back to Dues, not back to the
    // chooser - re-asking "Resident or Admin?" every time someone taps a
    // link labeled "Switch to Resident view" would be a bait-and-switch,
    // not a real mode switch.
    return (
      <AdminHomeScreen
        onReviewPayments={() => setShowReviewQueue(true)}
        onRecordExpense={() => setShowRecordExpense(true)}
        onViewHouses={() => setShowHouses(true)}
        onViewMembers={() => setShowMembers(true)}
        onViewSociety={() => setShowSociety(true)}
        onChangePassword={() => setShowChangePassword(true)}
        onSwitchToResident={bothAvailable ? () => setMode('resident') : undefined}
        onLogout={logout}
      />
    );
  }

  // No admin entry point here on purpose - once "Resident" is chosen (or
  // is the only thing available), this screen (or SelectHouseScreen below
  // it, for a multi-house resident) is the entire experience. Getting to
  // Admin/Committee from here means logging out and choosing again, not a
  // shortcut sitting here.
  const houseAssignments = membership.houseAssignments || [];
  const effectiveAssignment =
    houseAssignments.find((assignment) => assignment.id === residentAssignmentId) ||
    (houseAssignments.length === 1 ? houseAssignments[0] : null);

  if (!effectiveAssignment) {
    // Also covers the zero-houses case (SelectHouseScreen shows its own
    // "no house assignments yet" message then) - a resident with more than
    // one Active house picks one here before seeing its dashboard.
    return (
      <SelectHouseScreen
        houseAssignments={houseAssignments}
        openBillingPeriods={membership.openBillingPeriods}
        societyName={membership.society?.name}
        onSelectHouse={(assignment) => setResidentAssignmentId(assignment.id)}
        onLogout={logout}
        refreshing={refreshing}
        onRefresh={handleRefresh}
      />
    );
  }

  return (
    <ResidentHomeScreen
      assignment={effectiveAssignment}
      openBillingPeriods={membership.openBillingPeriods}
      userEmail={me.user?.email}
      phoneNumber={membership.phoneNumber}
      onPayDues={() => setPayDuesHouseId(effectiveAssignment.houses?.id)}
      onViewTransactions={() => setShowMyTransactions(true)}
      onViewHistory={() => setHistoryTarget(effectiveAssignment.houses)}
      onViewWaterCharges={() =>
        setWaterChargeTarget({ house: effectiveAssignment.houses, society: membership.society })
      }
      onChangePassword={() => setShowChangePassword(true)}
      onBack={houseAssignments.length > 1 ? () => setResidentAssignmentId(null) : undefined}
      onLogout={houseAssignments.length > 1 ? undefined : logout}
      refreshing={refreshing}
      onRefresh={handleRefresh}
    />
  );
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
