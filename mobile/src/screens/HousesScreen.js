import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { apiGet } from '../api/client';
import { useAuth } from '../context/AuthContext';

// ─────────────────────────────────────────────────────────────────────────
// A color-coded grid - one small tile per house - so an Admin/Committee
// member can see the whole society's dues status at a glance (this society
// alone has 125 houses, so the grid is sized dense enough that most fit
// per screen, with scrolling for the rest). Previously a search-only
// detail-card list (see Society_App_Progress_Log.md) - that mode still
// exists here as the search box below, just filtering the grid instead of
// hitting a separate search endpoint, since the whole dataset is already
// in hand.
//
// All color logic is computed server-side by GET /society/:id/houses-dues-
// grid (backend/src/routes/society.js) - this screen just renders whatever
// `bucket` each house comes back with, rather than re-deriving it
// client-side. That endpoint's own comment has the full color rule:
// summarized, this is an "as of today" view (not a manual toggle) -
// day <= 10 of the month gives the current month's own due a grace period
// (doesn't count), day >= 11 counts it same as any older unpaid month, and
// 0/1/2+ resulting "months due" maps to green/yellow/red.
// ─────────────────────────────────────────────────────────────────────────

const BUCKET_STYLES = {
  green: { tile: '#34a853', text: '#ffffff' },
  yellow: { tile: '#fbbc04', text: '#3c2f00' },
  red: { tile: '#ea4335', text: '#ffffff' },
};

const MIN_TILE_WIDTH = 58;
const TILE_HEIGHT = 42;
const TILE_GAP = 6;

export default function HousesScreen({ societyId, onBack, onSelectHouse }) {
  const { accessToken } = useAuth();
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [houses, setHouses] = useState([]);
  const [asOfDate, setAsOfDate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(
    async ({ isRefresh } = {}) => {
      if (!societyId) return;
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      try {
        setError(null);
        const data = await apiGet(`/society/${societyId}/houses-dues-grid`, accessToken);
        setHouses(data.houses || []);
        setAsOfDate(data.asOfDate || null);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [accessToken, societyId]
  );

  useEffect(() => {
    load();
  }, [load]);

  const filteredHouses = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return houses;
    return houses.filter(
      (h) =>
        h.house_number.toLowerCase().includes(trimmed) ||
        (h.owner_name || '').toLowerCase().includes(trimmed)
    );
  }, [houses, query]);

  // Color + count summary is always over the FULL list, not whatever the
  // search box currently filters down to - this is a whole-society
  // at-a-glance total, independent of looking up one specific house.
  const bucketCounts = useMemo(() => {
    const counts = { green: 0, yellow: 0, red: 0 };
    for (const house of houses) {
      if (counts[house.bucket] !== undefined) counts[house.bucket] += 1;
    }
    return counts;
  }, [houses]);

  // Mimics "auto fit": recompute how many columns fit the current width
  // (phone portrait, tablet, resizable web window) rather than a
  // hardcoded column count. Sized small/dense deliberately - the goal is
  // "most houses visible at a glance, scroll for the rest", not one
  // screen-height per handful of tiles.
  const availableWidth = width - 32; // screen padding
  const numColumns = Math.max(4, Math.floor((availableWidth + TILE_GAP) / (MIN_TILE_WIDTH + TILE_GAP)));
  const tileWidth = (availableWidth - TILE_GAP * (numColumns - 1)) / numColumns;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load({ isRefresh: true })} />}
    >
      <View style={styles.header}>
        <Text style={styles.title}>Houses</Text>
        {houses.length > 0 ? <Text style={styles.houseCount}>{houses.length} houses</Text> : null}
      </View>
      {asOfDate ? (
        <Text style={styles.subtitle}>
          As of today ({new Date(`${asOfDate}T00:00:00Z`).toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
          })})
        </Text>
      ) : null}

      {onBack ? (
        <TouchableOpacity style={styles.backLink} onPress={onBack}>
          <Text style={styles.backLinkText}>← Back to dashboard</Text>
        </TouchableOpacity>
      ) : null}

      {loading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" />
          <Text style={styles.loadingText}>Loading houses...</Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.error}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => load()}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {!loading && !error ? (
        <>
          <View style={styles.summaryRow}>
            {['green', 'yellow', 'red'].map((bucket) => (
              <View key={bucket} style={styles.summaryPill}>
                <View style={[styles.summarySwatch, { backgroundColor: BUCKET_STYLES[bucket].tile }]} />
                <Text style={styles.summaryCount}>{bucketCounts[bucket]}</Text>
              </View>
            ))}
          </View>

          <TextInput
            style={styles.searchInput}
            placeholder="Filter by house number or owner's name"
            placeholderTextColor="#999"
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
          />

          {filteredHouses.length === 0 ? (
            <Text style={styles.hint}>
              {houses.length === 0 ? 'No houses found.' : `No houses match "${query.trim()}".`}
            </Text>
          ) : null}

          <View style={[styles.grid, { gap: TILE_GAP }]}>
            {filteredHouses.map((house) => {
              const bucketStyle = BUCKET_STYLES[house.bucket] || BUCKET_STYLES.green;
              return (
                <TouchableOpacity
                  key={house.id}
                  style={[styles.tile, { width: tileWidth, height: TILE_HEIGHT, backgroundColor: bucketStyle.tile }]}
                  activeOpacity={onSelectHouse ? 0.7 : 1}
                  disabled={!onSelectHouse}
                  onPress={() => onSelectHouse?.(house)}
                >
                  <Text style={[styles.tileText, { color: bucketStyle.text }]} numberOfLines={1}>
                    {house.house_number}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </>
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
    paddingBottom: 48,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1c1c1e',
  },
  houseCount: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6e6e73',
  },
  subtitle: {
    fontSize: 13,
    color: '#6e6e73',
    marginTop: 4,
    marginBottom: 14,
  },
  backLink: {
    marginBottom: 16,
  },
  backLinkText: {
    color: '#1a73e8',
    fontSize: 14,
    fontWeight: '600',
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  loadingText: {
    fontSize: 13,
    color: '#6e6e73',
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
  summaryRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
  summaryPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  summarySwatch: {
    width: 16,
    height: 16,
    borderRadius: 4,
  },
  summaryCount: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1c1c1e',
  },
  searchInput: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 14,
    marginBottom: 14,
  },
  hint: {
    fontSize: 13,
    color: '#6e6e73',
    marginBottom: 16,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  tile: {
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  },
  tileText: {
    fontSize: 10.5,
    fontWeight: '700',
  },
});
