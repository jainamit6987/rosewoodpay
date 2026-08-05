import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { apiGet, apiPatch } from '../api/client';
import { useAuth } from '../context/AuthContext';

// Reached by tapping the circular house-number avatar on ResidentHomeScreen
// (see that screen's own header). Backed by GET /houses/:houseId/profile
// (routes/houses.js), a new resident-facing endpoint - not the existing
// GET /houses/:houseId/dashboard, which is Admin/Committee-only. This is
// the one screen in the app where a resident sees ANOTHER resident's own
// contact info (Owner sees the Tenant's phone/email and vice versa) -
// a deliberate, new trust boundary discussed directly with the user,
// scoped to exactly the two people sharing this one house.
//
// The Available-to-Rent toggle used to live on ResidentHomeScreen's own
// table; it now lives here instead, editable only when the backend says
// this viewer is the house's own Owner (viewerRelationshipType === 'Owner') -
// matching PATCH /houses/:houseId/available-to-rent's own Owner-only
// check, which is the real enforcement boundary regardless of what this
// screen shows or hides.
//
// Change Password also moved here from ResidentHomeScreen's own "More"
// section - it's an account-level action, not specific to this one house,
// but this is now the resident's one detail/settings-style screen, so it
// lives here rather than cluttering the plain billing dashboard.
export default function HouseProfileScreen({ houseId, onBack, onChangePassword }) {
  const { accessToken } = useAuth();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await apiGet(`/houses/${houseId}/profile`, accessToken);
      setProfile(data);
    } catch (err) {
      setError(err.message);
    }
  }, [accessToken, houseId]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const handleToggleAvailability = async (value) => {
    setToggleError(null);
    setToggleBusy(true);
    try {
      await apiPatch(`/houses/${houseId}/available-to-rent`, accessToken, { available_to_rent: value });
      await load();
    } catch (err) {
      setToggleError(err.message);
    } finally {
      setToggleBusy(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (error || !profile) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{error || 'Could not load this house profile.'}</Text>
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

  const isOwner = profile.viewerRelationshipType === 'Owner';

  const rows = [
    { label: 'House No', value: profile.house.house_number || '\u2014' },
    { label: 'Owner Name', value: profile.house.owner_name || '\u2014' },
    { label: 'Owner Mobile No', value: profile.owner?.phoneNumber || '\u2014' },
    { label: 'Owner Email', value: profile.owner?.email || '\u2014' },
    { label: 'Resident Type', value: profile.viewerRelationshipType || '\u2014' },
    { label: 'Tenant Name', value: profile.tenant?.name || '\u2014' },
    { label: 'Tenant Mobile No', value: profile.tenant?.phoneNumber || '\u2014' },
    { label: 'Tenant Email Id', value: profile.tenant?.email || '\u2014' },
  ];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
    >
      <View style={styles.header}>
        <Text style={styles.title}>House Profile</Text>
      </View>

      {onBack ? (
        <TouchableOpacity style={styles.backLink} onPress={onBack}>
          <Text style={styles.backLinkText}>← Back</Text>
        </TouchableOpacity>
      ) : null}

      <View style={styles.card}>
        {rows.map((row, index) => (
          <View key={row.label} style={[styles.detailRow, !isOwner && index === rows.length - 1 && styles.detailRowLast]}>
            <Text style={styles.detailLabel}>{row.label}</Text>
            <Text style={styles.detailValue}>{row.value}</Text>
          </View>
        ))}
        {isOwner ? (
          <View style={[styles.detailRow, styles.detailRowLast]}>
            <Text style={styles.detailLabel}>Available to Rent</Text>
            <Switch
              value={!!profile.house.available_to_rent}
              onValueChange={handleToggleAvailability}
              disabled={toggleBusy}
            />
          </View>
        ) : null}
      </View>
      {isOwner && toggleError ? <Text style={styles.toggleError}>{toggleError}</Text> : null}

      <TouchableOpacity style={styles.tile} onPress={onChangePassword}>
        <Text style={styles.tileTitle}>Change Password</Text>
      </TouchableOpacity>
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
    marginBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1c1c1e',
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
  toggleError: {
    color: '#c0392b',
    fontSize: 12,
    marginTop: -4,
    marginBottom: 16,
  },
  tile: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    minHeight: 56,
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
