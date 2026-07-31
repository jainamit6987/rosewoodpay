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
export default function SocietyScreen({ onBack }) {
  const { accessToken } = useAuth();
  const [societies, setSocieties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

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

      {societies.map((society) => (
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
        </View>
      ))}
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
