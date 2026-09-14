// Downloads the real UPI app logos used by src/constants/upiApps.js /
// components/UpiAppPicker.js, replacing the earlier colored-monogram
// placeholders (2026-09-14, user-requested).
//
// Source: Wikimedia Commons, via its Special:FilePath redirect (resolves
// a plain file title to the current actual file without needing to know
// its internal hash-based storage path) at width=500 (one of Commons'
// own standard thumbnail-render sizes - see
// https://w.wiki/GHai - arbitrary widths get rate-limited/rejected).
// This is the same category of source real payment gateways (Razorpay,
// PayU, Juspay) rely on for "which app is this" checkout icons - none of
// these five companies publish a single obvious "brand kit" zip, and
// Commons' versions are specifically maintained for this kind of
// identification use. If the user later gets official brand-kit assets
// directly from each company, just overwrite the matching PNG in
// ../assets/upi-icons/ - nothing else (upiApps.js, UpiAppPicker.js) needs
// to change.
//
// Run with: node scripts/fetch-upi-icons.js
const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR = path.join(__dirname, '..', 'assets', 'upi-icons');

// Commons file titles confirmed live (HTTP 200 via Special:FilePath) on
// 2026-09-14 - Commons file titles/content can change over time; if one
// of these ever 404s, search "<app name> logo" on
// https://commons.wikimedia.org and swap in the new title.
const ICONS = {
  gpay: 'Google_Pay_(GPay)_Logo.svg',
  phonepe: 'PhonePe_Logo.svg',
  paytm: 'Paytm_Logo_(standalone).svg',
  bhim: 'BHIM_logo.svg',
  amazonpay: 'Amazon_Pay_logo.svg',
};

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'MyMobApp-icon-fetch/1.0 (one-time asset sync script)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        download(res.headers.location, destPath).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`${url} -> HTTP ${res.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [key, title] of Object.entries(ICONS)) {
    const url = `https://commons.wikimedia.org/wiki/Special:FilePath/${title}?width=500`;
    const dest = path.join(OUT_DIR, `${key}.png`);
    await download(url, dest);
    console.log('wrote', path.relative(path.join(__dirname, '..'), dest));
    // Be a polite, slow client - Commons rate-limits back-to-back
    // requests from a single client (confirmed directly: a fast loop of
    // these same requests started returning 429s after a handful).
    await new Promise((r) => setTimeout(r, 4000));
  }
}

main().catch((err) => {
  console.error('Fetching UPI icons failed:', err.message);
  process.exit(1);
});
