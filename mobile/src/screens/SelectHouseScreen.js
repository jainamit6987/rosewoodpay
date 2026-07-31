import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

function formatMoney(amount) {
  return `\u20B9${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

// Only shown when a resident has more than one Active house assignment -
// with exactly one, App.js skips straight to ResidentHomeScreen. Each
// tile's due total is computed from the same openBillingPeriods list (GET
// /me) ResidentHomeScreen itself uses, just pre-filtered per house_id here.
export default function SelectHouseScreen({
  houseAssignments,
  openBillingPeriods,
  societyName,
  onSelectHouse,
  onLogout,
  refreshing,
  onRefresh,
}) {
  const duesByHouse = new Map();
  for (const period of openBillingPeriods || []) {
    duesByHouse.set(period.house_id, (duesByHouse.get(period.house_id) || 0) + Number(period.amount_due));
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{societyName || 'My Houses'}</Text>
          <Text style={styles.subtitle}>Choose a house to view its dashboard</Text>
        </View>
        <TouchableOpacity onPress={onLogout}>
          <Text style={styles.signOutLink}>Sign out</Text>
        </TouchableOpacity>
      </View>

      {(houseAssignments || []).length === 0 && (
        <Text style={styles.empty}>No approved house assignments yet - ask an admin to approve one.</Text>
      )}

      <View style={styles.grid}>
        {(houseAssignments || []).map((assignment) => (
          <TouchableOpacity key={assignment.id} style={styles.tile} onPress={() => onSelectHouse(assignment)}>
            <Text style={styles.tileTitle}>{assignment.houses?.house_number}</Text>
            <Text style={styles.tileSubtitle}>{assignment.relationship_type}</Text>
            <Text style={styles.tileSummary}>{formatMoney(duesByHouse.get(assignment.houses?.id) || 0)} due</Text>
          </TouchableOpacity>
        ))}
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
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 20,
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
  signOutLink: {
    color: '#1a73e8',
    fontSize: 14,
    fontWeight: '600',
    paddingTop: 4,
  },
  empty: {
    fontSize: 14,
    color: '#777',
    marginBottom: 16,
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
    minHeight: 90,
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  tileTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1c1c1e',
  },
  tileSubtitle: {
    fontSize: 12,
    color: '#6e6e73',
    marginTop: 2,
  },
  tileSummary: {
    fontSize: 13,
    color: '#1a73e8',
    fontWeight: '600',
    marginTop: 6,
  },
});
