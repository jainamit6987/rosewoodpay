import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { apiGet } from '../api/client';
import { useAuth } from '../context/AuthContext';

const SEARCH_DEBOUNCE_MS = 350;
const MAX_SEARCH_RESULTS = 5; // kept in sync with backend/src/routes/houses.js's own cap

function formatMoney(amount) {
  return `\u20B9${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

// Kept in sync with the chk_house_status CHECK constraint (Active /
// Inactive) - same "unrecognized falls back to a neutral gray badge"
// pattern as every other status badge in this codebase.
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

// Search-first, not list-everything: GET /me used to embed every house in
// the society here, but a real society can have well over a hundred, and
// scrolling through all of them stops being usable long before that (see
// Society_App_Progress_Log.md). This screen shows nothing until the
// Admin/Committee member actually types something, then calls the
// dedicated GET /houses/search?q=... endpoint (matches house_number OR
// owner_name, capped server-side at MAX_SEARCH_RESULTS) with a short
// debounce so a request does not fire on every single keystroke. Tapping a
// result hands the whole search-result house object up to onSelectHouse,
// which App.js uses to open that house's own dashboard (HouseDashboardScreen).
export default function HousesScreen({ onBack, onSelectHouse }) {
  const { accessToken } = useAuth();
  const [query, setQuery] = useState('');
  const [houses, setHouses] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  // Guards against an older, slower request's response overwriting a
  // newer one's results if they resolve out of order - compared against
  // the exact query that was in flight when each response arrives, not
  // just "is this the most recently started timer".
  const latestQueryRef = useRef('');

  const runSearch = useCallback(
    async (searchTerm) => {
      const trimmed = searchTerm.trim();
      latestQueryRef.current = trimmed;

      if (!trimmed) {
        setHouses([]);
        setError(null);
        setSearching(false);
        return;
      }

      setSearching(true);
      try {
        const data = await apiGet(`/houses/search?q=${encodeURIComponent(trimmed)}`, accessToken);
        if (latestQueryRef.current === trimmed) {
          setHouses(data);
          setError(null);
        }
      } catch (err) {
        if (latestQueryRef.current === trimmed) {
          setError(err.message);
        }
      } finally {
        if (latestQueryRef.current === trimmed) {
          setSearching(false);
        }
      }
    },
    [accessToken]
  );

  useEffect(() => {
    const timer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  const hasTyped = query.trim().length > 0;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Houses</Text>
          <Text style={styles.subtitle}>Search by house number or owner name</Text>
        </View>
      </View>

      {onBack ? (
        <TouchableOpacity style={styles.backLink} onPress={onBack}>
          <Text style={styles.backLinkText}>← Back to dashboard</Text>
        </TouchableOpacity>
      ) : null}

      <TextInput
        style={styles.searchInput}
        placeholder="e.g. A-101 or an owner's name"
        placeholderTextColor="#999"
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
      />

      {searching ? (
        <View style={styles.searchingRow}>
          <ActivityIndicator size="small" />
          <Text style={styles.searchingText}>Searching...</Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.error}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => runSearch(query)}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {!hasTyped && !error ? <Text style={styles.hint}>Type a house number or owner's name to search.</Text> : null}

      {hasTyped && !searching && !error && houses.length === 0 ? (
        <Text style={styles.hint}>No houses match "{query.trim()}".</Text>
      ) : null}

      {houses.map((house) => (
        <TouchableOpacity
          key={house.id}
          style={styles.card}
          activeOpacity={onSelectHouse ? 0.7 : 1}
          disabled={!onSelectHouse}
          onPress={() => onSelectHouse?.(house)}
        >
          <View style={styles.cardHeader}>
            <Text style={styles.houseNumber}>{house.house_number}</Text>
            <View style={[styles.badge, statusBadgeStyle(house.status)]}>
              <Text style={[styles.badgeText, statusTextStyle(house.status)]}>{house.status}</Text>
            </View>
          </View>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Type</Text>
            <Text style={styles.detailValue}>{house.type}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Owner</Text>
            <Text style={styles.detailValue}>{house.owner_name || '—'}</Text>
          </View>
          <View style={[styles.detailRow, styles.detailRowLast]}>
            <Text style={styles.detailLabel}>Monthly rate</Text>
            <Text style={styles.detailValue}>
              {house.default_monthly_amount != null ? formatMoney(house.default_monthly_amount) : 'Not set'}
            </Text>
          </View>
          {onSelectHouse ? <Text style={styles.viewDashboardHint}>Tap to view dashboard →</Text> : null}
        </TouchableOpacity>
      ))}

      {houses.length === MAX_SEARCH_RESULTS ? (
        <Text style={styles.hint}>Showing the first {MAX_SEARCH_RESULTS} matches - refine your search for a more specific result.</Text>
      ) : null}
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
  searchInput: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    marginBottom: 12,
  },
  searchingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  searchingText: {
    fontSize: 13,
    color: '#6e6e73',
  },
  hint: {
    fontSize: 13,
    color: '#6e6e73',
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
  houseNumber: {
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
  viewDashboardHint: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1a73e8',
    marginTop: 10,
    textAlign: 'right',
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
