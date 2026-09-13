// Config for the "choose your UPI app" grid shown from usePaysharpPayment's
// 'waiting' state, on both SubmitPaymentScreen and WaterChargeScreen (see
// components/UpiAppPicker.js, the one place that actually renders this).
//
// `urlField` names the property on the PaySharp create-order response
// (POST /transactions/upi-intent) that holds this app's specific intent
// URL - `gpayUrl`/`phonepeUrl` come straight from PaySharp itself;
// `paytmUrl`/`bhimUrl`/`amazonPayUrl` are derived on our own backend
// (services/paysharp.js's deriveAdditionalUpiAppUrls) since PaySharp's API
// does not provide those three - see that function's own comment for the
// (verified, not guessed) URL schemes used.
//
// `color`/`monogram` are a placeholder stand-in for each app's real icon -
// no official logo image assets are in this repo yet. Swap in real image
// assets later by adding an `icon: require('../../assets/upi-icons/....png')`
// field per entry here and rendering an <Image source={app.icon}> instead
// of the monogram circle in UpiAppPicker.js - nothing else needs to change.
export const UPI_APPS = [
  { key: 'gpay', label: 'Google Pay', color: '#1A73E8', monogram: 'G', urlField: 'gpayUrl' },
  { key: 'phonepe', label: 'PhonePe', color: '#5F259F', monogram: 'Pe', urlField: 'phonepeUrl' },
  { key: 'paytm', label: 'Paytm', color: '#00BAF2', monogram: 'P', urlField: 'paytmUrl' },
  { key: 'amazonpay', label: 'Amazon Pay', color: '#232F3E', monogram: 'a', urlField: 'amazonPayUrl' },
  { key: 'bhim', label: 'BHIM', color: '#ED6D24', monogram: 'B', urlField: 'bhimUrl' },
];
