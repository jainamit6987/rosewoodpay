import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { apiGet } from '../api/client';
import { useAuth } from '../context/AuthContext';

// Reached from ResidentHomeScreen's "More" section. Backed by the new
// GET /houses/listings?society_id=... (routes/houses.js) - every house in
// the caller's own society currently marked available_to_rent, each with
// its Owner's own name/mobile/email shown directly. This is a wider trust
// boundary than HouseProfileScreen's own owner/tenant contact visibility
// (that one is scoped to just the two people sharing one house; this one
// is society-wide) - discussed directly with the user, who confirmed it's
// intentional: an Owner opts a house into this list themselves via the
// Available-to-Rent toggle, precisely so other members can contact them
// about it.
export default function SocietyListingsScreen({ societyId, onBack }) {
  const { accessToken } = useAuth();
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await apiGet(`/houses/listings?society_id=${encodeURIComponent(societyId)}`, accessToken);
      setListings(data);
    } catch (err) {
      setError(err.message);
    }
  }, [accessToken, societyId]);

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
        <Text style={styles.title}>Society Listings</Text>
        <Text style={styles.subtitle}>Houses currently available to rent</Text>
      </View>

      {onBack ? (
        <TouchableOpacity style={styles.backLink} onPress={onBack}>
          <Text style={styles.backLinkText}>← Back</Text>
        </TouchableOpacity>
      ) : null}

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" />
        </View>
      ) : error ? (
        <View style={styles.errorBox}>
          <Text style={styles.error}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={handleRefresh}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : listings.length === 0 ? (
        <Text style={styles.hint}>No houses are currently marked available to rent.</Text>
      ) : (
        listings.map((listing) => (
          <View key={listing.id} style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.houseNumber}>{listing.house_number}</Text>
              <Text style={styles.houseType}>{listing.type}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Owner Name</Text>
              <Text style={styles.detailValue}>{listing.owner?.name || '\u2014'}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Owner Mobile No</Text>
              <Text style={styles.detailValue}>{listing.owner?.phoneNumber || '\u2014'}</Text>
            </View>
            <View style={[styles.detailRow, styles.detailRowLast]}>
              <Text style={styles.detailLabel}>Owner Email</Text>
              <Text style={styles.detailValue}>{listing.owner?.email || '\u2014'}</Text>
            </View>
          </View>
        ))
      )}
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
  header: {
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
  centered: {
    paddingVertical: 40,
    alignItems: 'center',
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
  hint: {
    fontSize: 13,
    color: '#6e6e73',
    marginTop: 8,
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
  houseType: {
    fontSize: 13,
    color: '#6e6e73',
    fontWeight: '600',
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
});
