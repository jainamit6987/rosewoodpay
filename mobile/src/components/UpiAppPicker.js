import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { UPI_APPS } from '../constants/upiApps';

// Shared "choose your UPI app" grid - used by both SubmitPaymentScreen and
// WaterChargeScreen's 'waiting' state (see usePaysharpPayment.js's own
// comment for why start() no longer auto-opens anything: this picker is
// the primary interaction now, not a fallback shown after a failed
// auto-open). `transaction` is the PaySharp create-order response (has
// gpayUrl/phonepeUrl/paytmUrl/bhimUrl/amazonPayUrl/intentUrl - see
// constants/upiApps.js and backend/src/services/paysharp.js for where each
// one comes from); `onOpenApp` is usePaysharpPayment's own openSpecificApp.
export default function UpiAppPicker({ transaction, onOpenApp }) {
  return (
    <View style={styles.container}>
      <View style={styles.grid}>
        {UPI_APPS.map((app) => (
          <TouchableOpacity
            key={app.key}
            style={styles.tile}
            onPress={() => onOpenApp(transaction?.[app.urlField])}
          >
            <View style={[styles.iconCircle, { backgroundColor: app.color }]}>
              <Text style={styles.iconText}>{app.monogram}</Text>
            </View>
            <Text style={styles.tileLabel} numberOfLines={1}>
              {app.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity style={styles.otherButton} onPress={() => onOpenApp(transaction?.intentUrl)}>
        <Text style={styles.otherButtonText}>Other UPI app</Text>
      </TouchableOpacity>
      <Text style={styles.otherHint}>
        Known limitation: reliably opens Android's own app picker. On iPhone it may not open
        anything - use one of the named apps above instead.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    gap: 4,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 14,
    marginBottom: 12,
  },
  tile: {
    width: 76,
    alignItems: 'center',
    gap: 6,
  },
  iconCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  tileLabel: {
    fontSize: 12,
    color: '#333',
    fontWeight: '600',
    textAlign: 'center',
  },
  otherButton: {
    borderWidth: 1,
    borderColor: '#c7c7cc',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  otherButtonText: {
    color: '#555',
    fontWeight: '600',
    fontSize: 13,
  },
  otherHint: {
    fontSize: 11,
    color: '#8a8a8e',
    textAlign: 'center',
  },
});
