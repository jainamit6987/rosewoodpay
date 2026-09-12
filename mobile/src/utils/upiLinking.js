import { Linking, Platform } from 'react-native';

// react-native-web's Linking.openURL(url) - called with no second argument,
// exactly how native React Native's own signature works - defaults to
// `window.open(url, '_blank', 'noopener')` under the hood. Mobile browsers
// (iOS Safari in particular) are unreliable at handing a custom scheme
// (upi://, tez://, phonepe://) opened via window.open - the reliable,
// widely-documented way to trigger one from a webpage is a top-level
// navigation instead. Passing '_self' explicitly makes react-native-web do
// that (`window.open(url, '_self', ...)` is equivalent to
// `location.href = url`); on native iOS/Android this second argument is
// simply ignored by RN's own Linking.openURL (its real signature only ever
// reads the first argument there), so this is a safe no-op there.
//
// Shared by usePaysharpPayment.js (the Instant UPI Payment flow) and both
// screens' own self-report "Pay via UPI app" button - every place in this
// app that opens a upi://-style link should go through this, not
// Linking.openURL directly.
export function openPaymentUrl(url) {
  return Platform.OS === 'web' ? Linking.openURL(url, '_self') : Linking.openURL(url);
}
