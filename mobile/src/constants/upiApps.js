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
// `icon` (2026-09-14) - real logos, replacing the earlier colored-
// monogram placeholders. Each PNG in ../../assets/upi-icons/ was fetched
// directly from Wikimedia Commons (a standard source for exactly this
// "identify the payment app in a picker" use case - the same practice
// real gateways like Razorpay/PayU/Juspay follow on their own checkout
// pages) at scripts/fetch-upi-icons.js's own recorded source URLs. They
// are wide wordmark logos (not square glyphs - none of these apps have a
// clean separate square icon on Commons), which is why UpiAppPicker.js
// renders them as wide rounded-rect cards, not circular monogram tiles.
// If the user later obtains official brand-kit assets directly from each
// company (Google Pay for Business / PhonePe partner kit / Paytm / NPCI's
// BHIM / Amazon Pay), just overwrite the matching PNG in that folder -
// nothing else needs to change.
export const UPI_APPS = [
  { key: 'gpay', label: 'Google Pay', icon: require('../../assets/upi-icons/gpay.png'), urlField: 'gpayUrl' },
  { key: 'phonepe', label: 'PhonePe', icon: require('../../assets/upi-icons/phonepe.png'), urlField: 'phonepeUrl' },
  { key: 'paytm', label: 'Paytm', icon: require('../../assets/upi-icons/paytm.png'), urlField: 'paytmUrl' },
  { key: 'amazonpay', label: 'Amazon Pay', icon: require('../../assets/upi-icons/amazonpay.png'), urlField: 'amazonPayUrl' },
  { key: 'bhim', label: 'BHIM', icon: require('../../assets/upi-icons/bhim.png'), urlField: 'bhimUrl' },
];
