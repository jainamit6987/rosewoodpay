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

// Groups the flat openBillingPeriods list from GET /me by house_id and pairs
// each group with its house's own details from houseAssignments - /me
// returns these as two separate arrays (see backend/src/routes/me.js)
// rather than pre-nested, so the grouping happens here instead.
function groupPeriodsByHouse(membership) {
  const houses = (membership.houseAssignments || []).map((assignment) => ({
    assignmentId: assignment.id,
    relationshipType: assignment.relationship_type,
    house: assignment.houses,
    periods: [],
  }));

  const houseById = new Map(houses.map((entry) => [entry.house?.id, entry]));

  for (const period of membership.openBillingPeriods || []) {
    const entry = houseById.get(period.house_id);
    if (entry) {
      entry.periods.push(period);
    }
  }

  return houses;
}

export default function DuesScreen({ onPayHouse, onViewHistory, onViewTransactions, onLogout }) {
  const { accessToken } = useAuth();
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  // Keyed by house id -> how many of that house's open periods (oldest first)
  // are currently selected to pay. Selection is always a contiguous run from
  // the oldest period, matching the backend's FIFO allocation in
  // routes/transactions.js - there is no "pay this month only, skip an older
  // open one" option, since the backend would silently apply the money to
  // the older period anyway.
  const [selectedCounts, setSelectedCounts] = useState({});

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await apiGet('/me', accessToken);
      setMe(data);
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

  const membership = me?.memberships?.[0];

  if (error || !membership) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{error || 'No society membership found for this account.'}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={handleRefresh}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Personal dues are shown for ANY member with at least one house
  // assignment - is_admin/is_committee_member are independent capability
  // flags, not an exclusive alternative to being a resident (see
  // backend/src/routes/me.js). This screen deliberately shows nothing
  // about admin/committee capability at all: once a member has chosen to
  // act as a Resident (see App.js's mode chooser), they see exactly what
  // a plain resident sees, full stop - switching back to Admin/Committee
  // is a log-out-and-choose-again action, not a shortcut sitting here.
  const housesWithDues = groupPeriodsByHouse(membership);

  const getSelectedCount = (houseId, periodCount) => {
    const count = selectedCounts[houseId] ?? 1;
    return Math.min(Math.max(count, 1), periodCount);
  };

  // Tapping a row selects "pay up through this period" - i.e. it and every
  // older still-open period above it. Tapping the last already-selected row
  // again drops back down by one, so a single tap on the oldest row is how
  // you shrink the selection back to just one period.
  const handleSelectThrough = (houseId, periodCount, tappedIndex) => {
    setSelectedCounts((prev) => {
      const current = getSelectedCount(houseId, periodCount);
      const nextCount = tappedIndex === current - 1 ? tappedIndex : tappedIndex + 1;
      return { ...prev, [houseId]: Math.max(nextCount, 1) };
    });
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{membership.society?.name}</Text>
          <Text style={styles.subtitle}>Total outstanding: {formatMoney(membership.totalOutstanding)}</Text>
        </View>
        <TouchableOpacity onPress={onLogout}>
          <Text style={styles.signOutLink}>Sign out</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity onPress={onViewTransactions}>
        <Text style={styles.transactionsLink}>View all my transactions</Text>
      </TouchableOpacity>

      {housesWithDues.length === 0 && (
        <Text style={styles.subtitle}>No approved house assignments yet - ask an admin to approve one.</Text>
      )}

      {housesWithDues.map((entry) => (
        <View key={entry.house?.id} style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.houseNumber}>{entry.house?.house_number}</Text>
            <Text style={styles.relationshipTag}>{entry.relationshipType}</Text>
          </View>

          <TouchableOpacity onPress={() => onViewHistory(entry.house)}>
            <Text style={styles.historyLink}>View full billing history</Text>
          </TouchableOpacity>

          {entry.periods.length === 0 ? (
            <Text style={styles.paidUp}>All caught up - no open dues.</Text>
          ) : (
            (() => {
              // A period already has a Submitted (not yet Verified/Rejected)
              // payment against it stays 'Open' the whole time it's awaiting
              // review - see backend/src/routes/me.js's hasPendingSubmission.
              // It must not be offered for selection here: the backend's
              // FIFO allocation always targets the oldest Open period, so a
              // second payment while the first is still pending would
              // silently double up on that exact same month instead of
              // moving on to the next one. Since payments are always FIFO,
              // these blocked periods are always a leading run - selection
              // below operates purely on the remaining, genuinely payable
              // suffix.
              const selectablePeriods = entry.periods.filter((period) => !period.hasPendingSubmission);
              const selectedCount = getSelectedCount(entry.house.id, selectablePeriods.length);
              const selectedPeriods = selectablePeriods.slice(0, selectedCount);
              const selectedTotal = selectedPeriods.reduce((sum, p) => sum + Number(p.amount_due), 0);

              return (
                <>
                  {selectablePeriods.length > 0 && (
                    <Text style={styles.selectHint}>Tap a month to select it and every open month above it</Text>
                  )}
                  {entry.periods.map((period) => {
                    if (period.hasPendingSubmission) {
                      return (
                        <View key={period.id} style={[styles.periodRow, styles.periodRowPending]}>
                          <View style={styles.periodRowLeft}>
                            <Text style={styles.periodMonth}>{formatMonth(period.period_month)}</Text>
                            <View style={styles.pendingBadge}>
                              <Text style={styles.pendingBadgeText}>Awaiting review</Text>
                            </View>
                          </View>
                          <Text style={styles.periodAmount}>{formatMoney(period.amount_due)}</Text>
                        </View>
                      );
                    }

                    const selectableIndex = selectablePeriods.indexOf(period);
                    const isSelected = selectableIndex < selectedCount;
                    return (
                      <TouchableOpacity
                        key={period.id}
                        style={[styles.periodRow, isSelected && styles.periodRowSelected]}
                        onPress={() => handleSelectThrough(entry.house.id, selectablePeriods.length, selectableIndex)}
                      >
                        <View style={styles.periodRowLeft}>
                          <View style={[styles.checkbox, isSelected && styles.checkboxChecked]}>
                            {isSelected ? <Text style={styles.checkboxTick}>✓</Text> : null}
                          </View>
                          <Text style={styles.periodMonth}>{formatMonth(period.period_month)}</Text>
                        </View>
                        <Text style={styles.periodAmount}>{formatMoney(period.amount_due)}</Text>
                      </TouchableOpacity>
                    );
                  })}
                  {selectablePeriods.length === 0 ? (
                    <Text style={styles.pendingHint}>
                      A payment for {entry.periods.length === 1 ? 'this month' : 'these months'} has already been
                      submitted and is awaiting admin review.
                    </Text>
                  ) : (
                    <TouchableOpacity
                      style={styles.payButton}
                      onPress={() =>
                        onPayHouse({
                          house: entry.house,
                          society: membership.society,
                          selectedPeriods,
                        })
                      }
                    >
                      <Text style={styles.payButtonText}>
                        Pay {formatMoney(selectedTotal)} ({selectedPeriods.length} month
                        {selectedPeriods.length === 1 ? '' : 's'})
                      </Text>
                    </TouchableOpacity>
                  )}
                </>
              );
            })()
          )}
        </View>
      ))}
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
    textAlign: 'center',
  },
  signOutLink: {
    color: '#1a73e8',
    fontSize: 14,
    fontWeight: '600',
    paddingTop: 4,
  },
  transactionsLink: {
    color: '#1a73e8',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 16,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#e6e6e6',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  houseNumber: {
    fontSize: 18,
    fontWeight: '700',
  },
  relationshipTag: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1a73e8',
    backgroundColor: '#e8f0fe',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  paidUp: {
    fontSize: 14,
    color: '#2e7d32',
  },
  historyLink: {
    fontSize: 12,
    color: '#1a73e8',
    fontWeight: '600',
    marginBottom: 10,
  },
  selectHint: {
    fontSize: 12,
    color: '#888',
    marginBottom: 6,
  },
  periodRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  periodRowSelected: {
    backgroundColor: '#e8f0fe',
  },
  periodRowPending: {
    backgroundColor: '#f5f5f7',
  },
  periodRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  pendingBadge: {
    backgroundColor: '#fdf2d0',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  pendingBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#8a6d00',
  },
  pendingHint: {
    fontSize: 12,
    color: '#8a6d00',
    marginTop: 4,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: '#aaa',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: '#1a73e8',
    borderColor: '#1a73e8',
  },
  checkboxTick: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  periodMonth: {
    fontSize: 14,
    color: '#333',
  },
  periodAmount: {
    fontSize: 14,
    fontWeight: '600',
  },
  payButton: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 12,
  },
  payButtonText: {
    color: '#fff',
    fontWeight: '600',
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
