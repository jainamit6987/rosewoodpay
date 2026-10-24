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
// Two more things layered on top of that color, answering a different
// question than the bucket color does - "for the CURRENT month
// specifically, who has actually paid, and in what sense" (a green tile
// just means "not seriously behind overall", not "already paid this
// month"). 2026-10-24: replaced the original simpler version of this
// (a single checkmark badge + a 2-count Paid/Pending legend) with a
// 4-way scheme, after the 2-bucket version confused the user in two real
// cases - an advance-payer counted as "Paid" but got no tick, and a
// resident who'd just cleared old arrears got a tick but didn't count as
// "Paid". The backend (GET /society/:id/houses-dues-grid) now computes
// one `paymentStatus` per house from the same two underlying booleans
// (currentMonthSettled - is THIS month's own period Closed/Waived;
// paidThisMonth - did a Verified Maintenance transaction land THIS
// calendar month) - see its own comment in society.js for the exact 2x2:
//   - paidCurrent - solid tick. The "clean" case: settled, and that's
//     because of a payment that actually happened this month.
//   - paidAdvance - star. Settled, but NOT from anything happening this
//     month - paid ahead of time in an earlier month.
//   - paidOld     - hollow tick (outlined in the tile's own bucket
//     color). A payment happened this month, but it went toward old
//     arrears - this month's OWN bill is still open.
//   - unpaid      - no badge at all.
// The summary row above the grid mirrors this with 4 counts instead of
// the old 2 (paidCurrentCount/paidOldCount/paidAdvanceCount/unpaidCount).
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
  const [paidCurrentCount, setPaidCurrentCount] = useState(0);
  const [paidOldCount, setPaidOldCount] = useState(0);
  const [paidAdvanceCount, setPaidAdvanceCount] = useState(0);
  const [unpaidCount, setUnpaidCount] = useState(0);
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
        setPaidCurrentCount(data.paidCurrentCount || 0);
        setPaidOldCount(data.paidOldCount || 0);
        setPaidAdvanceCount(data.paidAdvanceCount || 0);
        setUnpaidCount(data.unpaidCount || 0);
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

  // Month name only (no year) - used as the "Paid (<Month>)" summary-table
  // label, which only ever needs to disambiguate which of the 12 months,
  // not which year (it's always read as "right now, this calendar
  // month") - the subtitle above already states the full date for anyone
  // who needs the year too.
  const currentMonthName = useMemo(() => {
    if (!currentMonth) return '';
    return new Date(`${currentMonth}T00:00:00Z`).toLocaleDateString('en-IN', {
      month: 'long',
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
            <View style={styles.paymentSummaryBox}>
              <Text style={styles.paymentSummaryHeading}>{currentMonthLabel} - payment status</Text>
              <View style={styles.paymentSummaryGrid}>
                <View style={[styles.paymentSummaryCard, { borderColor: '#1a9850' }]}>
                  <Text style={[styles.paymentSummaryIcon, { color: '#1a9850' }]}>{'\u2713'}</Text>
                  <Text style={styles.paymentSummaryCount}>{paidCurrentCount}</Text>
                  <Text style={styles.paymentSummaryLabel}>
                    {currentMonthName ? `Paid (${currentMonthName})` : 'Paid'}
                  </Text>
                </View>
                <View style={[styles.paymentSummaryCard, { borderColor: '#e67e22' }]}>
                  <Text style={[styles.paymentSummaryIcon, styles.paymentSummaryIconHollow, { color: '#e67e22' }]}>
                    {'\u2713'}
                  </Text>
                  <Text style={styles.paymentSummaryCount}>{paidOldCount}</Text>
                  <Text style={styles.paymentSummaryLabel}>Paid (Old)</Text>
                </View>
                <View style={[styles.paymentSummaryCard, { borderColor: '#caa000' }]}>
                  <Text style={[styles.paymentSummaryIcon, { color: '#caa000' }]}>{'\u2605'}</Text>
                  <Text style={styles.paymentSummaryCount}>{paidAdvanceCount}</Text>
                  <Text style={styles.paymentSummaryLabel}>Paid (Advance)</Text>
                </View>
                <View style={[styles.paymentSummaryCard, { borderColor: '#c0392b' }]}>
                  <Text style={[styles.paymentSummaryCount, { color: '#c0392b' }]}>{unpaidCount}</Text>
                  <Text style={styles.paymentSummaryLabel}>Unpaid</Text>
                </View>
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
                  {house.paymentStatus === 'paidCurrent' ? (
                    <View style={styles.statusBadge} accessibilityLabel="Paid this month, settled">
                      <Text style={styles.statusBadgeTick}>{'\u2713'}</Text>
                    </View>
                  ) : null}
                  {house.paymentStatus === 'paidAdvance' ? (
                    <View style={styles.statusBadge} accessibilityLabel="Paid in advance">
                      <Text style={styles.statusBadgeStar}>{'\u2605'}</Text>
                    </View>
                  ) : null}
                  {house.paymentStatus === 'paidOld' ? (
                    <View
                      style={[styles.statusBadge, styles.statusBadgeHollow, { borderColor: bucketStyle.tile }]}
                      accessibilityLabel="Paid old dues, this month still open"
                    >
                      <Text style={[styles.statusBadgeHollowTick, { color: bucketStyle.tile }]}>{'\u2713'}</Text>
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
  paymentSummaryBox: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 14,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  paymentSummaryHeading: {
    fontSize: 12.5,
    fontWeight: '600',
    color: '#6e6e73',
    marginBottom: 8,
  },
  paymentSummaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  // 4 small bordered cards, 2 per row - border color (not fill) carries
  // the category's accent color, so the card stays readable with dark
  // text while still being visually tied to its matching tick/star badge
  // color on the grid above.
  paymentSummaryCard: {
    flexBasis: '47%',
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1.5,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  paymentSummaryIcon: {
    fontSize: 13,
    fontWeight: '900',
    width: 14,
    textAlign: 'center',
  },
  // Lighter weight than the solid tick/star icons above - mirrors the
  // hollow-tick badge's own "outlined, not filled" look on the grid.
  paymentSummaryIconHollow: {
    fontWeight: '500',
  },
  paymentSummaryCount: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1c1c1e',
  },
  paymentSummaryLabel: {
    fontSize: 11.5,
    fontWeight: '600',
    color: '#6e6e73',
    flexShrink: 1,
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
  // Small white badge, not a plain colored checkmark/star directly on the
  // tile - a colored glyph on an already-colored tile (green/yellow/red)
  // would be hard to read; white stays legible against all three bucket
  // colors. One shared base style for all 3 badge variants (solid tick,
  // star, hollow tick) - only the glyph (and, for the hollow variant, a
  // colored ring) changes between them.
  statusBadge: {
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
  statusBadgeTick: {
    fontSize: 9,
    fontWeight: '900',
    color: '#1a9850',
    lineHeight: 10,
  },
  statusBadgeStar: {
    fontSize: 9,
    fontWeight: '900',
    color: '#caa000',
    lineHeight: 10,
  },
  // "Hollow" tick - a colored ring (matching the tile's own bucket color,
  // set inline per-house) around the white fill, plus a lighter-weight
  // glyph in that same color, instead of the solid tick's bold fixed
  // green - visually "outlined", not "filled", to distinguish "paid old
  // dues, this month still open" from the solid tick's "fully settled".
  statusBadgeHollow: {
    borderWidth: 1.5,
  },
  statusBadgeHollowTick: {
    fontSize: 8.5,
    fontWeight: '600',
    lineHeight: 10,
  },
});
