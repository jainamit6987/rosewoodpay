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
const MAX_SEARCH_RESULTS = 5; // kept in sync with backend/src/routes/members.js's own cap

// Kept in sync with the chk_society_members_status CHECK constraint
// (Active / Suspended) - same "unrecognized falls back to a neutral gray
// badge" pattern as every other status badge in this codebase.
function statusBadgeStyle(status) {
  if (status === 'Active') return styles.badgeActive;
  if (status === 'Suspended') return styles.badgeInactive;
  return styles.badgeUnknown;
}

function statusTextStyle(status) {
  if (status === 'Active') return styles.badgeTextActive;
  if (status === 'Suspended') return styles.badgeTextInactive;
  return styles.badgeTextUnknown;
}

function roleLabel(member) {
  const roles = [];
  if (member.isAdmin) roles.push('Admin');
  if (member.isCommitteeMember) roles.push('Committee');
  return roles.length > 0 ? roles.join(' \u00b7 ') : 'Resident';
}

// The Members hub - reached from AdminHomeScreen's own tile. Search-first,
// exactly like HousesScreen: nothing renders until the Admin/Committee
// member actually types something, then calls the dedicated GET /members/
// search?q=... endpoint (matches name OR phone_number, capped server-side
// at MAX_SEARCH_RESULTS) with a short debounce. Tapping a result hands the
// whole search-result member object up to onSelectMember, which App.js
// uses to open MemberDetailScreen - the same "search result -> detail
// screen re-fetches its own live data" shape as HousesScreen -> Dashboard.
// "+ New Member" is the one write entry point here, leading to
// CreateMemberScreen.
export default function MembersScreen({ onBack, onSelectMember, onCreateMember }) {
  const { accessToken } = useAuth();
  const [query, setQuery] = useState('');
  const [members, setMembers] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  const latestQueryRef = useRef('');

  const runSearch = useCallback(
    async (searchTerm) => {
      const trimmed = searchTerm.trim();
      latestQueryRef.current = trimmed;

      if (!trimmed) {
        setMembers([]);
        setError(null);
        setSearching(false);
        return;
      }

      setSearching(true);
      try {
        const data = await apiGet(`/members/search?q=${encodeURIComponent(trimmed)}`, accessToken);
        if (latestQueryRef.current === trimmed) {
          setMembers(data);
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
          <Text style={styles.title}>Members</Text>
          <Text style={styles.subtitle}>Search by name or mobile number</Text>
        </View>
      </View>

      {onBack ? (
        <TouchableOpacity style={styles.backLink} onPress={onBack}>
          <Text style={styles.backLinkText}>← Back to dashboard</Text>
        </TouchableOpacity>
      ) : null}

      <TouchableOpacity style={styles.createButton} onPress={onCreateMember}>
        <Text style={styles.createButtonText}>+ New Member</Text>
      </TouchableOpacity>

      <TextInput
        style={styles.searchInput}
        placeholder="e.g. Priya Sharma or 9876543210"
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

      {!hasTyped && !error ? <Text style={styles.hint}>Type a name or mobile number to search.</Text> : null}

      {hasTyped && !searching && !error && members.length === 0 ? (
        <Text style={styles.hint}>No members match "{query.trim()}".</Text>
      ) : null}

      {members.map((member) => (
        <TouchableOpacity
          key={member.id}
          style={styles.card}
          activeOpacity={onSelectMember ? 0.7 : 1}
          disabled={!onSelectMember}
          onPress={() => onSelectMember?.(member)}
        >
          <View style={styles.cardHeader}>
            <Text style={styles.memberName}>{member.name || 'Unnamed member'}</Text>
            <View style={[styles.badge, statusBadgeStyle(member.status)]}>
              <Text style={[styles.badgeText, statusTextStyle(member.status)]}>{member.status}</Text>
            </View>
          </View>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Role</Text>
            <Text style={styles.detailValue}>{roleLabel(member)}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Mobile Number</Text>
            <Text style={styles.detailValue}>{member.phoneNumber || '\u2014'}</Text>
          </View>
          <View style={[styles.detailRow, styles.detailRowLast]}>
            <Text style={styles.detailLabel}>Email</Text>
            <Text style={styles.detailValue}>{member.email || '\u2014'}</Text>
          </View>
          {onSelectMember ? <Text style={styles.viewDetailHint}>Tap to view details →</Text> : null}
        </TouchableOpacity>
      ))}

      {members.length === MAX_SEARCH_RESULTS ? (
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
  createButton: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 16,
  },
  createButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
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
  memberName: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1c1c1e',
    flex: 1,
    marginRight: 8,
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
  viewDetailHint: {
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
