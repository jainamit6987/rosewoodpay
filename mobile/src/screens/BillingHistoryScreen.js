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
import { apiGet } from '../api/client';
import { useAuth } from '../context/AuthContext';

function formatMonth(periodMonth) {
  return new Date(periodMonth).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function formatMoney(amount) {
  return `\u20B9${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

// Kept in sync with the chk_billing_status CHECK constraint (Open / Closed /
// Waived) - anything unrecognized falls back to a neutral gray badge rather
// than crashing on an unexpected value. "Pending Approval" is not a real
// status value - a period stays 'Open' in the database right up until a
// payment against it is actually Verified (see GET /houses/:houseId/billing
// -periods' hasPendingSubmission flag), so an Open period that already has
// a Submitted payment sitting in the review queue is relabeled here purely
// for display, using its own badge color, without pretending it's some
// fourth database status.
function displayStatus(period) {
  if (period.status === 'Open' && period.hasPendingSubmission) return 'Pending Approval';
  return period.status;
}

function statusBadgeStyle(period) {
  if (period.status === 'Open' && period.hasPendingSubmission) return styles.badgePending;
  if (period.status === 'Open') return styles.badgeOpen;
  if (period.status === 'Closed') return styles.badgeClosed;
  if (period.status === 'Waived') return styles.badgeWaived;
  return styles.badgeUnknown;
}

function statusTextStyle(period) {
  if (period.status === 'Open' && period.hasPendingSubmission) return styles.badgeTextPending;
  if (period.status === 'Open') return styles.badgeTextOpen;
  if (period.status === 'Closed') return styles.badgeTextClosed;
  if (period.status === 'Waived') return styles.badgeTextWaived;
  return styles.badgeTextUnknown;
}

// Full month-by-month history for a single house - every period regardless
// of status, unlike DuesScreen which only ever shows still-Open ones (that
// screen's whole purpose is "what do I owe right now"). This is the
// "Live Receipt view" from the workflow doc: proof a given month was
// actually paid/closed, not just what's currently outstanding.
export default function BillingHistoryScreen({ house, onBack }) {
  const { accessToken } = useAuth();
  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await apiGet(`/houses/${house.id}/billing-periods`, accessToken);
      setPeriods(data);
    } catch (err) {
      setError(err.message);
    }
  }, [accessToken, house.id]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{house.house_number}</Text>
          <Text style={styles.subtitle}>Full billing history</Text>
        </View>
        <TouchableOpacity onPress={onBack}>
          <Text style={styles.backLink}>Back</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={styles.error}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={handleRefresh}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : periods.length === 0 ? (
        <Text style={styles.empty}>No billing periods recorded yet for this house.</Text>
      ) : (
        <View style={styles.card}>
          {periods.map((period) => (
            <View key={period.id} style={styles.periodRow}>
              <View style={styles.periodRowLeft}>
                <Text style={styles.periodMonth}>{formatMonth(period.period_month)}</Text>
                <View style={[styles.badge, statusBadgeStyle(period)]}>
                  <Text style={[styles.badgeText, statusTextStyle(period)]}>{displayStatus(period)}</Text>
                </View>
              </View>
              <Text style={styles.periodAmount}>{formatMoney(period.amount_due)}</Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f6f8',
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
    gap: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 20,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 14,
    color: '#555',
    marginTop: 4,
  },
  backLink: {
    color: '#1a73e8',
    fontSize: 14,
    fontWeight: '600',
    paddingTop: 4,
  },
  empty: {
    fontSize: 14,
    color: '#777',
    textAlign: 'center',
    marginTop: 20,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e6e6e6',
  },
  periodRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  periodRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  periodMonth: {
    fontSize: 14,
    color: '#333',
  },
  periodAmount: {
    fontSize: 14,
    fontWeight: '600',
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
  badgeOpen: {
    backgroundColor: '#e8f0fe',
  },
  badgeTextOpen: {
    color: '#1a73e8',
  },
  badgePending: {
    backgroundColor: '#fdf2d0',
  },
  badgeTextPending: {
    color: '#8a6d00',
  },
  badgeClosed: {
    backgroundColor: '#e6f4ea',
  },
  badgeTextClosed: {
    color: '#2e7d32',
  },
  badgeWaived: {
    backgroundColor: '#f1eefe',
  },
  badgeTextWaived: {
    color: '#6a1fc7',
  },
  badgeUnknown: {
    backgroundColor: '#eee',
  },
  badgeTextUnknown: {
    color: '#666',
  },
  error: {
    color: '#c0392b',
    fontSize: 14,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  retryButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
});
