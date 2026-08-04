import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { apiGet } from '../api/client';
import { useAuth } from '../context/AuthContext';

// The Admin/Committee landing screen - a grouped grid of tiles, one per
// feature, rather than one screen (previously AdminReviewScreen) collecting
// an ever-growing stack of one-off links to every other screen. Sections
// mirror app-workflows.csv's own natural groupings (Payments / Members &
// Houses / Billing / Reports / Settings). Deliberately only ever shows a
// tile for a screen that actually exists yet - no grayed-out "coming soon"
// placeholders - so this grid grows by exactly one tile each time a new
// screen ships, and never needs a redesign as more get added. Every spoke
// screen reached from here (AdminReviewScreen, SocietyScreen, HousesScreen,
// ...) shows a single "← Back to dashboard" link back to here, and none of
// them carry their own Sign out link anymore - same "only the true home
// screen for this mode has Sign out" convention DuesScreen already
// established on the resident side (BillingHistoryScreen/MyTransactionsScreen
// don't have one either).
export default function AdminHomeScreen({
  onReviewPayments,
  onRecordExpense,
  onViewHouses,
  onViewMembers,
  onViewSociety,
  onChangePassword,
  onSwitchToResident,
  onLogout,
}) {
  const { accessToken } = useAuth();
  const [societyName, setSocietyName] = useState(null);
  const [houseCount, setHouseCount] = useState(null);
  const [pendingCount, setPendingCount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      // Two independent, cheap reads for the two tile summaries below -
      // /me's houseCount is a real Postgres count query, not "fetch every
      // house and measure .length" (a real society can have well over a
      // hundred houses; see GET /houses/search for the actual house list,
      // which HousesScreen now uses instead of reading from /me at all).
      // AdminReviewScreen makes its own separate /transactions/pending call
      // too when opened directly - refetching it again here purely for a
      // count is the same accepted per-screen-fetches-independently
      // tradeoff already made everywhere else in this app (see App.js's
      // own note on DuesScreen's /me fetch).
      const [me, pending] = await Promise.all([apiGet('/me', accessToken), apiGet('/transactions/pending', accessToken)]);
      const membership = me.memberships?.[0];
      setSocietyName(membership?.society?.name ?? null);
      setHouseCount(membership?.houseCount ?? 0);
      setPendingCount(Array.isArray(pending) ? pending.length : 0);
    } catch (err) {
      setError(err.message);
    }
  }, [accessToken]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{societyName || 'Admin dashboard'}</Text>
          <Text style={styles.subtitle}>Admin dashboard</Text>
        </View>
        <TouchableOpacity onPress={onLogout}>
          <Text style={styles.signOutLink}>Sign out</Text>
        </TouchableOpacity>
      </View>

      {onSwitchToResident ? (
        <TouchableOpacity onPress={onSwitchToResident}>
          <Text style={styles.switchLink}>Switch to Resident view</Text>
        </TouchableOpacity>
      ) : null}

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.error}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={handleRefresh}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      <Text style={styles.sectionHeader}>Payments</Text>
      <View style={styles.grid}>
        <TouchableOpacity style={styles.tile} onPress={onReviewPayments}>
          <Text style={styles.tileTitle}>Review Payments</Text>
          <Text style={styles.tileSummary}>{pendingCount} pending</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tile} onPress={onRecordExpense}>
          <Text style={styles.tileTitle}>Record Expense</Text>
          <Text style={styles.tileSummary}>Salary, bills & more</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionHeader}>Members & Houses</Text>
      <View style={styles.grid}>
        <TouchableOpacity style={styles.tile} onPress={onViewHouses}>
          <Text style={styles.tileTitle}>Houses</Text>
          <Text style={styles.tileSummary}>
            {houseCount} {houseCount === 1 ? 'house' : 'houses'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tile} onPress={onViewMembers}>
          <Text style={styles.tileTitle}>Members</Text>
          <Text style={styles.tileSummary}>View, add & suspend</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionHeader}>Settings</Text>
      <View style={styles.grid}>
        <TouchableOpacity style={styles.tile} onPress={onViewSociety}>
          <Text style={styles.tileTitle}>Society Settings</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tile} onPress={onChangePassword}>
          <Text style={styles.tileTitle}>Change Password</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f7',
  },
  content: {
    padding: 16,
    paddingTop: 48,
    paddingBottom: 40,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f5f5f7',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1c1c1e',
  },
  subtitle: {
    fontSize: 14,
    color: '#6e6e73',
    marginTop: 4,
  },
  signOutLink: {
    color: '#1a73e8',
    fontSize: 14,
    fontWeight: '600',
    paddingTop: 4,
  },
  switchLink: {
    color: '#1a73e8',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 16,
  },
  errorBox: {
    marginBottom: 16,
  },
  error: {
    color: '#c0392b',
    fontSize: 14,
    marginBottom: 8,
  },
  retryButton: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
    alignSelf: 'flex-start',
  },
  retryButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: '#8a8a8e',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 16,
    marginBottom: 8,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  tile: {
    flexBasis: '47%',
    flexGrow: 1,
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    minHeight: 76,
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  tileTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1c1c1e',
  },
  tileSummary: {
    fontSize: 13,
    color: '#1a73e8',
    fontWeight: '600',
    marginTop: 6,
  },
});
