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
// summarized, "periods due" = overdueMonths + the current month's own due
// if also unpaid, and 1/2/3+ maps to green/yellow/red (simplified
// 2026-10-13 - no more day-of-month grace period).
//
// Two more things layered on top of that color, added the same day
// (discussed directly with the user) to answer a different question -
// "for the CURRENT month specifically, who has actually paid" - which the
// color alone can't answer (a green tile just means "not seriously
// behind overall", not "already paid this month"):
//   - A small checkmark badge on a tile means a Verified Maintenance
//     transaction (not Water Charge) landed in THIS calendar month for
//     that house (paidThisMonth) - deliberately transaction-based, not
//     period-based, so a house that pre-paid months ago gets no tick now.
//   - The "Paid / Pending" counts above the grid are period-based instead
//     (currentMonthPaidCount/currentMonthPendingCount) - whether this
//     month's own billing period is actually Closed/Waived, with a
//     never-billed house counting as Pending, not Paid.
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
  const [currentMonth, setCurrentMonth] = useState(null);
  const [currentMonthPaidCount, setCurrentMonthPaidCount] = useState(0);
  const [currentMonthPendingCount, setCurrentMonthPendingCount] = useState(0);
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
        setCurrentMonth(data.currentMonth || null);
        setCurrentMonthPaidCount(data.currentMonthPaidCount || 0);
        setCurrentMonthPendingCount(data.currentMonthPendingCount || 0);
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

  // "October 2026" - period_month is a plain date-only string, parsed as
  // UTC parts directly rather than a bare `new Date(currentMonth)` (which
  // some engines would otherwise roll back a day on a negative-offset
  // timezone) - same reasoning as every other period_month display helper
  // in this codebase.
  const currentMonthLabel = useMemo(() => {
    if (!currentMonth) return '';
    return new Date(`${currentMonth}T00:00:00Z`).toLocaleDateString('en-IN', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }, [currentMonth]);

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

          {currentMonthLabel ? (
            <View style={styles.monthStatusRow}>
              <Text style={styles.monthStatusLabel}>{currentMonthLabel} - Paid / Pending</Text>
              <View style={styles.monthStatusCounts}>
                <Text style={[styles.monthStatusCount, styles.monthStatusPaid]}>Paid {currentMonthPaidCount}</Text>
                <Text style={styles.monthStatusDot}>·</Text>
                <Text style={[styles.monthStatusCount, styles.monthStatusPending]}>
                  Pending {currentMonthPendingCount}
                </Text>
              </View>
            </View>
          ) : null}

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
                  {house.paidThisMonth ? (
                    <View style={styles.paidBadge} accessibilityLabel="Maintenance paid this month">
                      <Text style={styles.paidBadgeText}>{'\u2713'}</Text>
                    </View>
                  ) : null}
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
  monthStatusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 14,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  monthStatusLabel: {
    fontSize: 12.5,
    fontWeight: '600',
    color: '#6e6e73',
    flexShrink: 1,
    marginRight: 8,
  },
  monthStatusCounts: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  monthStatusCount: {
    fontSize: 13,
    fontWeight: '700',
  },
  monthStatusPaid: {
    color: '#1a9850',
  },
  monthStatusPending: {
    color: '#c0392b',
  },
  monthStatusDot: {
    fontSize: 13,
    color: '#c7c7cc',
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
    position: 'relative',
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  },
  tileText: {
    fontSize: 10.5,
    fontWeight: '700',
  },
  // Small white badge, not a plain colored checkmark directly on the tile
  // - a green check on an already-green tile (or any other bucket color)
  // would be hard to read; white stays legible against all three bucket
  // colors.
  paidBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 1.5,
    shadowOffset: { width: 0, height: 1 },
  },
  paidBadgeText: {
    fontSize: 9,
    fontWeight: '900',
    color: '#1a9850',
    lineHeight: 10,
  },
});
