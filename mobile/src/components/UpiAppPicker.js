import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { UPI_APPS } from '../constants/upiApps';

// Shared "choose your UPI app" grid - used by both SubmitPaymentScreen and
// WaterChargeScreen's 'waiting' state (see usePaysharpPayment.js's own
// comment for why start() no longer auto-opens anything: this picker is
// the primary interaction now, not a fallback shown after a failed
// auto-open). `transaction` is the PaySharp create-order response (has
// gpayUrl/phonepeUrl/paytmUrl/bhimUrl/amazonPayUrl/intentUrl - see
// constants/upiApps.js and backend/src/services/paysharp.js for where each
// one comes from); `onOpenApp` is usePaysharpPayment's own openSpecificApp.
//
// Renders each app's real logo (2026-09-14 - see upiApps.js's own comment
// for where these come from) as a white rounded-rect card, NOT a circular
// monogram tile like the earlier placeholder version - every one of these
// five logos is a wide wordmark (nobody's Commons page has a clean square
// glyph-only icon for all five), so a card that lets each logo's own
// aspect ratio show through via resizeMode="contain" looks right for all
// of them at once, matching how real gateway checkout pages (Razorpay,
// PayU) show payment-method logos.
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
            <View style={styles.logoCard}>
              <Image source={app.icon} style={styles.logoImage} resizeMode="contain" accessibilityLabel={app.label} />
            </View>
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
    gap: 10,
    marginBottom: 12,
  },
  tile: {
    width: 104,
    alignItems: 'center',
  },
  logoCard: {
    width: 104,
    height: 56,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e2e6',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  logoImage: {
    width: '100%',
    height: '100%',
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
