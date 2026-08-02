import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { apiGet, apiPost } from '../api/client';
import { useAuth } from '../context/AuthContext';

function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Kept in sync with the chk_societies_status CHECK constraint (Active /
// Inactive) - same "unrecognized falls back to a neutral gray badge" rule
// as every other status badge in this codebase (BillingHistoryScreen,
// MyTransactionsScreen).
function statusBadgeStyle(status) {
  if (status === 'Active') return styles.badgeActive;
  if (status === 'Inactive') return styles.badgeInactive;
  return styles.badgeUnknown;
}

function statusTextStyle(status) {
  if (status === 'Active') return styles.badgeTextActive;
  if (status === 'Inactive') return styles.badgeTextInactive;
  return styles.badgeTextUnknown;
}

// GET /society (backend/src/routes/society.js) returns every society this
// caller is an Active Admin/Committee member of, as an array - in practice
// always exactly one for how this app is used today (one membership, one
// society), but rendered as a list rather than assumed-singular so a future
// multi-society Admin/Committee member is handled for free, matching how
// GET /transactions/mine's list rendering never assumed "exactly one house"
// either.
export default function SocietyScreen({ onBack, onViewPendencyReport, onViewTransactionReport }) {
  const { accessToken } = useAuth();
  const [societies, setSocieties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  // Keyed by society.id (this screen renders a list, same reasoning as
  // HouseDashboardScreen's own residentRowState) - tracks the inline
  // confirm-then-run flow for POST /society/:id/billing-periods/generate-next-month
  // (S.No 16), the one write action on an otherwise read-only settings
  // screen. confirming/result/error/busy mirror MemberDetailScreen's own
  // Suspend confirmation shape - this action touches every house in the
  // society at once, so it gets the same "explicit inline confirm first"
  // treatment Suspend does, not Verify's immediate one.
  const [generateState, setGenerateState] = useState({});

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await apiGet('/society', accessToken);
      setSocieties(data);
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

  const startGenerateConfirm = (societyId) => {
    setGenerateState((prev) => ({ ...prev, [societyId]: { confirming: true, busy: false, error: null, result: null } }));
  };

  const cancelGenerateConfirm = (societyId) => {
    setGenerateState((prev) => {
      const next = { ...prev };
      delete next[societyId];
      return next;
    });
  };

  const confirmGenerateNextMonth = async (societyId) => {
    setGenerateState((prev) => ({ ...prev, [societyId]: { ...prev[societyId], busy: true, error: null } }));
    try {
      const result = await apiPost(`/society/${societyId}/billing-periods/generate-next-month`, accessToken);
      setGenerateState((prev) => ({ ...prev, [societyId]: { confirming: false, busy: false, error: null, result } }));
    } catch (err) {
      setGenerateState((prev) => ({
        ...prev,
        [societyId]: { ...prev[societyId], busy: false, error: err.message },
      }));
    }
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
          <Text style={styles.title}>Society settings</Text>
          <Text style={styles.subtitle}>
            {societies.length} {societies.length === 1 ? 'society' : 'societies'}
          </Text>
        </View>
      </View>

      {onBack ? (
        <TouchableOpacity style={styles.backLink} onPress={onBack}>
          <Text style={styles.backLinkText}>← Back to dashboard</Text>
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

      {!error && societies.length === 0 && (
        <Text style={styles.subtitle}>No society found for this account.</Text>
      )}

      {societies.map((society) => {
        const generate = generateState[society.id] || {};
        return (
          <View key={society.id} style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.societyName}>{society.name}</Text>
              <View style={[styles.badge, statusBadgeStyle(society.status)]}>
                <Text style={[styles.badgeText, statusTextStyle(society.status)]}>{society.status}</Text>
              </View>
            </View>

            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>UPI VPA</Text>
              <Text style={styles.detailValue}>{society.upi_vpa}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>UPI payee name</Text>
              <Text style={styles.detailValue}>{society.upi_payee_name}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Timezone</Text>
              <Text style={styles.detailValue}>{society.timezone}</Text>
            </View>
            <View style={[styles.detailRow, styles.detailRowLast]}>
              <Text style={styles.detailLabel}>Registered on</Text>
              <Text style={styles.detailValue}>{formatDate(society.created_at)}</Text>
            </View>

            <View style={styles.reportGrid}>
              {onViewPendencyReport ? (
                <TouchableOpacity style={styles.reportTile} onPress={() => onViewPendencyReport(society)}>
                  <Text style={styles.reportTileTitle}>Pendency Report</Text>
                  <Text style={styles.reportTileSummary}>Who still owes dues →</Text>
                </TouchableOpacity>
              ) : null}
              {onViewTransactionReport ? (
                <TouchableOpacity style={styles.reportTile} onPress={() => onViewTransactionReport(society)}>
                  <Text style={styles.reportTileTitle}>Transaction Report</Text>
                  <Text style={styles.reportTileSummary}>Society ledger by month →</Text>
                </TouchableOpacity>
              ) : null}
              {/* S.No 16: bulk-create next month's billing period for every
                  Active house in this society in one call. Styled as a
                  filled (not gray) tile - the two above are navigation,
                  this one is a write action - and turns green once it has
                  already run once for this screen session, to make an
                  accidental double-run (which is otherwise harmless -
                  already-existing months are just skipped) visually
                  unlikely rather than relying on the backend's own
                  idempotency alone. Not gated on either onView* prop above -
                  this tile is self-contained (calls apiPost directly), not a
                  navigation handoff to App.js. */}
              <TouchableOpacity
                style={[styles.actionTile, generate.result && styles.actionTileDone]}
                onPress={() => startGenerateConfirm(society.id)}
                disabled={generate.confirming || generate.busy}
              >
                <Text style={styles.actionTileTitle}>
                  {generate.result ? 'Generated ✓' : "Generate Next Month's Billing"}
                </Text>
                <Text style={styles.actionTileSummary}>
                  {generate.result ? 'Run again if needed' : 'Every house, one month ahead'}
                </Text>
              </TouchableOpacity>
            </View>

            {generate.confirming ? (
              <View style={styles.confirmBox}>
                <Text style={styles.confirmText}>
                  This creates next month's billing period for every Active house in {society.name} that doesn't
                  already have one, using each house's own configured rate. Continue?
                </Text>
                <View style={styles.confirmActionRow}>
                  <TouchableOpacity
                    style={styles.confirmCancelButton}
                    onPress={() => cancelGenerateConfirm(society.id)}
                    disabled={generate.busy}
                  >
                    <Text style={styles.confirmCancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.confirmGoButton}
                    onPress={() => confirmGenerateNextMonth(society.id)}
                    disabled={generate.busy}
                  >
                    <Text style={styles.confirmGoButtonText}>{generate.busy ? 'Generating…' : 'Confirm'}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}

            {generate.error ? <Text style={styles.generateError}>{generate.error}</Text> : null}

            {generate.result ? (
              <View style={styles.confirmBox}>
                <Text style={styles.generateResultText}>
                  Created for {generate.result.created.length} house
                  {generate.result.created.length === 1 ? '' : 's'}
                  {generate.result.skipped.length > 0
                    ? `, skipped ${generate.result.skipped.length} house${generate.result.skipped.length === 1 ? '' : 's'}:`
                    : '.'}
                </Text>
                {generate.result.skipped.map((skip) => (
                  <Text key={skip.house_id} style={styles.generateSkippedText}>
                    • {skip.house_number}: {skip.reason}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        );
      })}
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
  backLink: {
    marginBottom: 16,
  },
  backLinkText: {
    color: '#1a73e8',
    fontSize: 14,
    fontWeight: '600',
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
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  societyName: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1c1c1e',
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  detailRowLast: {
    borderBottomWidth: 0,
  },
  detailLabel: {
    fontSize: 13,
    color: '#6e6e73',
  },
  detailValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1c1c1e',
  },
  reportGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 14,
  },
  reportTile: {
    flexBasis: '47%',
    flexGrow: 1,
    backgroundColor: '#f5f5f7',
    borderRadius: 10,
    padding: 14,
    minHeight: 70,
    justifyContent: 'center',
  },
  reportTileTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1c1c1e',
  },
  reportTileSummary: {
    fontSize: 12,
    color: '#1a73e8',
    fontWeight: '600',
    marginTop: 4,
  },
  actionTile: {
    flexBasis: '47%',
    flexGrow: 1,
    backgroundColor: '#1a73e8',
    borderRadius: 10,
    padding: 14,
    minHeight: 70,
    justifyContent: 'center',
  },
  actionTileDone: {
    backgroundColor: '#2e7d32',
  },
  actionTileTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
  },
  actionTileSummary: {
    fontSize: 12,
    color: '#e8f0fe',
    fontWeight: '600',
    marginTop: 4,
  },
  confirmBox: {
    backgroundColor: '#f5f5f7',
    borderRadius: 10,
    padding: 14,
    marginTop: 12,
  },
  confirmText: {
    fontSize: 13,
    color: '#1c1c1e',
    marginBottom: 12,
  },
  confirmActionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  confirmCancelButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d0d0d0',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  confirmCancelButtonText: {
    color: '#6e6e73',
    fontWeight: '600',
    fontSize: 13,
  },
  confirmGoButton: {
    flex: 1,
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  confirmGoButtonText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },
  generateError: {
    color: '#c0392b',
    fontSize: 13,
    marginTop: 10,
  },
  generateResultText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1c1c1e',
  },
  generateSkippedText: {
    fontSize: 12,
    color: '#6e6e73',
    marginTop: 4,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  badgeActive: {
    backgroundColor: '#e6f4ea',
  },
  badgeTextActive: {
    color: '#2e7d32',
  },
  badgeInactive: {
    backgroundColor: '#fdecea',
  },
  badgeTextInactive: {
    color: '#c0392b',
  },
  badgeUnknown: {
    backgroundColor: '#eee',
  },
  badgeTextUnknown: {
    color: '#666',
  },
});
