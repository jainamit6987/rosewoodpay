import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { apiGet, apiPost } from '../api/client';
import { useAuth } from '../context/AuthContext';

const SEARCH_DEBOUNCE_MS = 350;
const RELATIONSHIP_TYPES = ['Owner', 'Tenant', 'Occupant'];

function formatMoney(amount) {
  return `\u20B9${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

function formatMonth(periodMonth) {
  return new Date(periodMonth).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Same definition as ResidentHomeScreen's own currentPeriodLabel - this
// calendar month's own billing period and its status, distinct from
// currentDue (the full arrears total across every still-Open period).
function currentPeriodLabel(currentPeriod) {
  if (!currentPeriod) return 'Not yet generated';
  return `${formatMonth(currentPeriod.period_month)} \u00b7 ${currentPeriod.status}`;
}

// The Admin/Committee-facing counterpart to ResidentHomeScreen - reached by
// tapping a result on HousesScreen's search. Shows the same house-level
// facts a resident sees about their own house (current billing period,
// current due, last payment), backed by the dedicated GET /houses/
// :houseId/dashboard (not GET /me, which only ever describes the caller's
// own house assignments). Unlike ResidentHomeScreen there is no single
// "Name/Mobile/Email" row here - a house can have zero, one, or two
// (owner + tenant) Active residents, so those are listed separately below
// as their own small section rather than assumed to be exactly one person.
// "Submit Cash Payment" is the one write action here (unlike the read-only
// tiles below it) - for the one real scenario an Admin submits a payment
// on someone else's behalf: cash physically handed over, not a UPI
// transfer only the resident themselves could have made.
//
// Residents section has two modes, discussed with the user directly: in
// normal mode each card just shows name + role and is tappable straight
// through to onSelectMember (MemberDetailScreen); "Edit" flips every card
// to a "Remove" button (revokes that one assignment) and reveals an
// "+ Add resident" search-and-pick box below the list (searches existing
// members via GET /members/search, then POST /assignments + an immediate
// /approve so the new resident shows up Active right away, with no
// separate pending-approval screen to visit). Both revoke and the new
// assignment go through the same backend guards as everywhere else
// (assignments.js's last-Owner check on revoke, the Suspended-member
// check on create) - this screen just surfaces whatever error those
// return, it does not duplicate the rules client-side.
export default function HouseDashboardScreen({ house, onViewTransactions, onViewHistory, onSubmitCashPayment, onSelectMember, onBack }) {
  const { accessToken } = useAuth();
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const [editingResidents, setEditingResidents] = useState(false);
  const [residentRowState, setResidentRowState] = useState({});

  const [addQuery, setAddQuery] = useState('');
  const [addResults, setAddResults] = useState([]);
  const [addSearching, setAddSearching] = useState(false);
  const [addSearchError, setAddSearchError] = useState(null);
  const [addSelectedMember, setAddSelectedMember] = useState(null);
  const [addRelationshipType, setAddRelationshipType] = useState('Tenant');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState(null);
  const latestAddQueryRef = useRef('');

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await apiGet(`/houses/${house.id}/dashboard`, accessToken);
      setDashboard(data);
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

  const resetAddForm = () => {
    setAddQuery('');
    setAddResults([]);
    setAddSearchError(null);
    setAddSelectedMember(null);
    setAddRelationshipType('Tenant');
    setAddError(null);
  };

  const toggleEditResidents = () => {
    setEditingResidents((prev) => !prev);
    setResidentRowState({});
    resetAddForm();
  };

  const handleRevoke = async (resident) => {
    setResidentRowState((prev) => ({ ...prev, [resident.assignmentId]: { busy: true, error: null } }));
    try {
      await apiPost(`/assignments/${resident.assignmentId}/revoke`, accessToken);
      await load();
      setResidentRowState((prev) => {
        const next = { ...prev };
        delete next[resident.assignmentId];
        return next;
      });
    } catch (err) {
      // Surfaces the backend's own message as-is - e.g. the last-Owner
      // guard's 409 already explains exactly what to do first (see
      // routes/assignments.js).
      setResidentRowState((prev) => ({ ...prev, [resident.assignmentId]: { busy: false, error: err.message } }));
    }
  };

  const runAddSearch = useCallback(
    async (searchTerm) => {
      const trimmed = searchTerm.trim();
      latestAddQueryRef.current = trimmed;

      if (!trimmed) {
        setAddResults([]);
        setAddSearchError(null);
        setAddSearching(false);
        return;
      }

      setAddSearching(true);
      try {
        const data = await apiGet(`/members/search?q=${encodeURIComponent(trimmed)}`, accessToken);
        if (latestAddQueryRef.current === trimmed) {
          setAddResults(data);
          setAddSearchError(null);
        }
      } catch (err) {
        if (latestAddQueryRef.current === trimmed) {
          setAddSearchError(err.message);
        }
      } finally {
        if (latestAddQueryRef.current === trimmed) {
          setAddSearching(false);
        }
      }
    },
    [accessToken]
  );

  useEffect(() => {
    if (!editingResidents || addSelectedMember) return;
    const timer = setTimeout(() => runAddSearch(addQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [addQuery, editingResidents, addSelectedMember, runAddSearch]);

  const confirmAddResident = async () => {
    setAddError(null);
    setAddBusy(true);
    try {
      const created = await apiPost('/assignments', accessToken, {
        society_id: dashboard.house.society_id,
        society_member_id: addSelectedMember.id,
        house_id: house.id,
        relationship_type: addRelationshipType,
      });
      // A House Dashboard add is meant to take effect immediately, not
      // land in the separate pending-approval queue POST /assignments
      // otherwise leaves it in (there is no dedicated review screen for
      // that queue yet) - so this always follows straight up with the
      // one approve call an Admin would otherwise have to do themselves.
      await apiPost(`/assignments/${created.id}/approve`, accessToken);
      await load();
      resetAddForm();
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAddBusy(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (error || !dashboard) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{error || 'Could not load this house.'}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={handleRefresh}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
        {onBack ? (
          <TouchableOpacity onPress={onBack}>
            <Text style={styles.backLinkText}>← Back</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  const rows = [
    { label: "Owner's Name", value: dashboard.house.owner_name || '\u2014' },
    { label: 'House Number', value: dashboard.house.house_number },
    { label: 'Current Billing Period', value: currentPeriodLabel(dashboard.currentPeriod) },
    { label: 'Current Due', value: formatMoney(dashboard.currentDue) },
    { label: 'Last Payment Date', value: dashboard.lastPayment ? formatDate(dashboard.lastPayment.date) : '\u2014' },
    { label: 'Last Payment Amount', value: dashboard.lastPayment ? formatMoney(dashboard.lastPayment.amount) : '\u2014' },
  ];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{dashboard.house.house_number}</Text>
          <Text style={styles.subtitle}>House dashboard</Text>
        </View>
      </View>

      {onBack ? (
        <TouchableOpacity style={styles.backLink} onPress={onBack}>
          <Text style={styles.backLinkText}>← Back to search</Text>
        </TouchableOpacity>
      ) : null}

      <View style={styles.card}>
        {rows.map((row, index) => (
          <View key={row.label} style={[styles.detailRow, index === rows.length - 1 && styles.detailRowLast]}>
            <Text style={styles.detailLabel}>{row.label}</Text>
            <Text style={styles.detailValue}>{row.value}</Text>
          </View>
        ))}
      </View>

      {dashboard.currentDue > 0 ? (
        <TouchableOpacity style={styles.cashButton} onPress={onSubmitCashPayment}>
          <Text style={styles.cashButtonText}>Submit Cash Payment</Text>
        </TouchableOpacity>
      ) : (
        <Text style={styles.paidUp}>All caught up - no open dues.</Text>
      )}

      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionHeader}>Residents</Text>
        <TouchableOpacity onPress={toggleEditResidents}>
          <Text style={styles.editToggleText}>{editingResidents ? 'Done' : 'Edit'}</Text>
        </TouchableOpacity>
      </View>

      {dashboard.residents.length === 0 ? (
        <Text style={styles.hint}>No resident currently assigned to this house.</Text>
      ) : (
        dashboard.residents.map((resident) => {
          const rowState = residentRowState[resident.assignmentId] || {};
          return (
            <TouchableOpacity
              key={resident.assignmentId}
              style={styles.card}
              activeOpacity={editingResidents || !onSelectMember ? 1 : 0.7}
              disabled={editingResidents || !onSelectMember || !resident.memberId}
              onPress={() => onSelectMember?.({ id: resident.memberId })}
            >
              <View style={styles.cardHeader}>
                <Text style={styles.residentName}>{resident.memberName || resident.memberEmail || 'Unnamed member'}</Text>
                <Text style={styles.relationshipTag}>{resident.relationshipType}</Text>
              </View>

              {rowState.error ? <Text style={styles.rowError}>{rowState.error}</Text> : null}

              {editingResidents ? (
                <TouchableOpacity
                  style={styles.removeButton}
                  onPress={() => handleRevoke(resident)}
                  disabled={rowState.busy}
                >
                  <Text style={styles.removeButtonText}>{rowState.busy ? 'Removing…' : 'Remove'}</Text>
                </TouchableOpacity>
              ) : (
                <Text style={styles.viewMemberHint}>{resident.memberId ? 'Tap to view member →' : ''}</Text>
              )}
            </TouchableOpacity>
          );
        })
      )}

      {editingResidents ? (
        <View style={styles.card}>
          <Text style={styles.addResidentTitle}>+ Add resident</Text>

          {addSelectedMember ? (
            <View>
              <View style={styles.selectedMemberRow}>
                <Text style={styles.selectedMemberName}>{addSelectedMember.name || addSelectedMember.email}</Text>
                <TouchableOpacity onPress={resetAddForm} disabled={addBusy}>
                  <Text style={styles.changeSelectionText}>Change</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.roleRow}>
                {RELATIONSHIP_TYPES.map((type) => (
                  <TouchableOpacity
                    key={type}
                    style={[styles.roleChip, addRelationshipType === type && styles.roleChipActive]}
                    onPress={() => setAddRelationshipType(type)}
                    disabled={addBusy}
                  >
                    <Text style={[styles.roleChipText, addRelationshipType === type && styles.roleChipTextActive]}>{type}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {addError ? <Text style={styles.rowError}>{addError}</Text> : null}

              <TouchableOpacity
                style={[styles.addButton, addBusy && styles.addButtonDisabled]}
                onPress={confirmAddResident}
                disabled={addBusy}
              >
                <Text style={styles.addButtonText}>{addBusy ? 'Adding…' : `Add as ${addRelationshipType}`}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View>
              <TextInput
                style={styles.searchInput}
                placeholder="Search by name or mobile number"
                placeholderTextColor="#999"
                value={addQuery}
                onChangeText={setAddQuery}
                autoCapitalize="none"
                autoCorrect={false}
              />

              {addSearching ? (
                <View style={styles.searchingRow}>
                  <ActivityIndicator size="small" />
                  <Text style={styles.searchingText}>Searching...</Text>
                </View>
              ) : null}

              {addSearchError ? <Text style={styles.rowError}>{addSearchError}</Text> : null}

              {addQuery.trim() && !addSearching && !addSearchError && addResults.length === 0 ? (
                <Text style={styles.hint}>No members match "{addQuery.trim()}".</Text>
              ) : null}

              {addResults.map((candidate) => (
                <TouchableOpacity
                  key={candidate.id}
                  style={styles.candidateRow}
                  onPress={() => setAddSelectedMember(candidate)}
                >
                  <Text style={styles.candidateName}>{candidate.name || 'Unnamed member'}</Text>
                  <Text style={styles.candidateMeta}>{candidate.phoneNumber || candidate.email || '\u2014'}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      ) : null}

      <Text style={styles.sectionHeader}>More</Text>
      <View style={styles.grid}>
        <TouchableOpacity style={styles.tile} onPress={onViewTransactions}>
          <Text style={styles.tileTitle}>Transactions</Text>
          <Text style={styles.tileSummary}>Payments for this house</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tile} onPress={onViewHistory}>
          <Text style={styles.tileTitle}>Billing Periods</Text>
          <Text style={styles.tileSummary}>All months & status</Text>
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
    padding: 24,
    gap: 16,
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
    marginBottom: 10,
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
  residentName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1c1c1e',
    flex: 1,
    marginRight: 8,
  },
  viewMemberHint: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1a73e8',
    marginTop: 6,
    textAlign: 'right',
  },
  removeButton: {
    borderWidth: 1,
    borderColor: '#c0392b',
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
    marginTop: 4,
  },
  removeButtonText: {
    color: '#c0392b',
    fontWeight: '600',
    fontSize: 13,
  },
  rowError: {
    color: '#c0392b',
    fontSize: 13,
    marginBottom: 8,
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
  hint: {
    fontSize: 13,
    color: '#6e6e73',
    marginBottom: 16,
  },
  paidUp: {
    fontSize: 14,
    color: '#2e7d32',
    marginBottom: 16,
  },
  cashButton: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 16,
  },
  cashButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: '#8a8a8e',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 4,
    marginBottom: 8,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  editToggleText: {
    color: '#1a73e8',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 8,
  },
  addResidentTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1c1c1e',
    marginBottom: 12,
  },
  searchInput: {
    backgroundColor: '#f5f6f8',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 10,
  },
  searchingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  searchingText: {
    fontSize: 13,
    color: '#6e6e73',
  },
  candidateRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  candidateName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1c1c1e',
  },
  candidateMeta: {
    fontSize: 13,
    color: '#6e6e73',
  },
  selectedMemberRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  selectedMemberName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1c1c1e',
  },
  changeSelectionText: {
    color: '#1a73e8',
    fontSize: 13,
    fontWeight: '600',
  },
  roleRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
  roleChip: {
    borderWidth: 1,
    borderColor: '#d0d0d0',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  roleChipActive: {
    backgroundColor: '#e8f0fe',
    borderColor: '#1a73e8',
  },
  roleChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6e6e73',
  },
  roleChipTextActive: {
    color: '#1a73e8',
  },
  addButton: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  addButtonDisabled: {
    backgroundColor: '#a8c5ef',
  },
  addButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
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
