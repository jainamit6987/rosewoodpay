import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { apiGet } from '../api/client';
import { useAuth } from '../context/AuthContext';

// First letter of each of the first two words (e.g. "Rosewood Century" ->
// "RC"), or the first two letters of a single-word name (e.g. "Sunview" ->
// "SU") - same short-identifier role the house number itself already plays
// inside ResidentHomeScreen's own avatar circle, just derived rather than
// a real field, since a society has no equivalent short code of its own.
function societyInitials(name) {
  const words = (name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// The Admin/Committee landing screen - a grouped grid of tiles, one per
// feature, rather than one screen (previously AdminReviewScreen) collecting
// an ever-growing stack of one-off links to every other screen. Sections
// mirror app-workflows.csv's own natural groupings (Payments / Members &
// Houses / Billing / Reports / Society Reports & Actions). Deliberately
// only ever shows a tile for a screen that actually exists yet - no
// grayed-out "coming soon" placeholders - so this grid grows by exactly one
// tile each time a new screen ships, and never needs a redesign as more get
// added. Every spoke screen reached from here (AdminReviewScreen,
// SocietyScreen, HousesScreen, ...) shows a single "← Back to dashboard"
// link back to here, and none of them carry their own Sign out link
// anymore - same "only the true home screen for this mode has Sign out"
// convention DuesScreen already established on the resident side
// (BillingHistoryScreen/MyTransactionsScreen don't have one either).
//
// The header's circular avatar (society initials, tappable) opens
// SocietyProfileScreen (onViewSocietyProfile) - the exact same tappable
// circular-avatar-plus-chevron-badge pattern ResidentHomeScreen's own
// house-number avatar already established for HouseProfileScreen, just
// with derived initials standing in for a house's own real house_number.
// Society details (UPI VPA, timezone, registered date, ...) used to live in
// a card directly on SocietyScreen; that screen is now Reports/Actions
// only, so this is their one new home.
export default function AdminHomeScreen({
  isAdmin,
  onReviewPayments,
  onRecordExpense,
  onViewHouses,
  onViewMembers,
  onViewSociety,
  onViewSocietyProfile,
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
        <TouchableOpacity
          style={styles.avatarCircle}
          onPress={onViewSocietyProfile}
          disabled={!onViewSocietyProfile}
          accessibilityLabel="View society profile"
        >
          <Text style={styles.avatarText} numberOfLines={1}>
            {societyInitials(societyName)}
          </Text>
          {onViewSocietyProfile ? (
            <View style={styles.avatarBadge}>
              <Text style={styles.avatarBadgeText}>{'\u203a'}</Text>
            </View>
          ) : null}
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
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
          <Text style={styles.tileSummary}>
            {pendingCount} pending{isAdmin ? '' : ' \u00b7 view only'}
          </Text>
        </TouchableOpacity>
        {/* Committee members can view every other tile on this dashboard,
            but recording an expense is Admin-only on the backend (see
            routes/transactions.js's EXPENSE_TYPES branch) - grayed out and
            unpressable here rather than left live and just bouncing a 403
            back once tapped. */}
        <TouchableOpacity
          style={[styles.tile, !isAdmin && styles.tileDisabled]}
          onPress={isAdmin ? onRecordExpense : undefined}
          disabled={!isAdmin}
        >
          <Text style={[styles.tileTitle, !isAdmin && styles.tileTitleDisabled]}>Record Expense</Text>
          <Text style={[styles.tileSummary, !isAdmin && styles.tileSummaryDisabled]}>
            {isAdmin ? 'Salary, bills & more' : 'Admin only'}
          </Text>
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
          <Text style={styles.tileSummary}>{isAdmin ? 'View, add & suspend' : 'View only'}</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionHeader}>Society Reports/Actions</Text>
      <View style={styles.grid}>
        <TouchableOpacity style={styles.tile} onPress={onViewSociety}>
          <Text style={styles.tileTitle}>Reports & Actions</Text>
          <Text style={styles.tileSummary}>Ledger, dues & billing</Text>
        </TouchableOpacity>
        {onChangePassword ? (
          <TouchableOpacity style={styles.tile} onPress={onChangePassword}>
            <Text style={styles.tileTitle}>Change Password</Text>
          </TouchableOpacity>
        ) : null}
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
    alignItems: 'center',
    marginBottom: 8,
  },
  // Same avatar-circle-plus-overlapping-badge treatment as
  // ResidentHomeScreen's own avatarCircle/avatarBadge - the shadow/ring
  // read as a raised, pressable surface, and the badge's chevron confirms
  // what tapping it does, before or after the disabled check below removes
  // both entirely for a caller onViewSocietyProfile was never passed for.
  avatarCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#1a73e8',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: '#fff',
    shadowColor: '#1a73e8',
    shadowOpacity: 0.45,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  avatarText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  avatarBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#f5f5f7',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  avatarBadgeText: {
    color: '#1a73e8',
    fontSize: 12,
    fontWeight: '900',
    lineHeight: 12,
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
  tileDisabled: {
    backgroundColor: '#f5f5f7',
    shadowOpacity: 0,
  },
  tileTitleDisabled: {
    color: '#a8a8ad',
  },
  tileSummaryDisabled: {
    color: '#a8a8ad',
  },
});
