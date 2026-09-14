// Regenerates every square app-icon asset this project needs from ONE
// clean source mark (assets/android-icon-foreground.png - the blue
// chevron, already alpha-transparent and already correctly used as the
// Android adaptive icon's foreground layer) composited onto a plain white
// background at whatever size/padding each use case needs.
//
// Why this exists (2026-09-14): the user reported the PWA gets a plain
// BLACK icon when saved to the Home Screen on both iPhone and Android.
// Root cause, confirmed directly (not guessed): Metro's web export never
// generates a PWA manifest.json or an apple-touch-icon link on its own
// (unlike the old, now-removed @expo/webpack-config PWA plugin - see
// Expo's own "Migrate from Expo Webpack" doc) - `mobile/dist/index.html`
// had NEITHER before this change, so both iOS Safari and Android Chrome
// had no real icon to use for "Add to Home Screen" and fell back to a
// blank/black placeholder. Separately (found while investigating, not the
// direct cause of the black icon): `assets/icon.png` and
// `assets/android-icon-background.png` turned out to still be the RAW,
// unedited Expo default-template placeholder art - the design tool's own
// guide grid/circles were baked directly into the exported pixels rather
// than a finished asset. Both problems are fixed together here.
//
// Uses `jimp-compact` - not a new dependency, already installed as
// @expo/image-utils's own runtime image library (Expo CLI's icon-related
// commands use it internally), so this needed nothing extra in
// package.json.
//
// Run with: node scripts/generate-pwa-icons.js
// (regenerates everything below; re-run any time SOURCE_MARK changes)
const path = require('path');
const Jimp = require('jimp-compact');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SOURCE_MARK = path.join(ASSETS_DIR, 'android-icon-foreground.png');

const WHITE = 0xffffffff; // jimp hex colors are 0xRRGGBBAA

// scale: the mark's width as a fraction of the full canvas. Plain "any"
// icons can safely use most of the frame; a "maskable" icon needs to stay
// well inside Android's ~80%-of-canvas mask safe zone, and Android's own
// adaptive-icon spec (which this mark's padding already targets) uses a
// similar ~66% safe zone - 0.44 leaves comfortable headroom either way.
async function makeIcon(outPath, size, scale) {
  const canvas = new Jimp(size, size, WHITE);
  const mark = await Jimp.read(SOURCE_MARK);
  const markWidth = Math.round(size * scale);
  mark.resize(markWidth, Jimp.AUTO);
  const x = Math.round((size - mark.bitmap.width) / 2);
  const y = Math.round((size - mark.bitmap.height) / 2);
  canvas.composite(mark, x, y);
  await canvas.writeAsync(outPath);
  console.log('wrote', path.relative(path.join(__dirname, '..'), outPath), `${size}x${size}`);
}

async function makeSolidCanvas(outPath, size) {
  const canvas = new Jimp(size, size, WHITE);
  await canvas.writeAsync(outPath);
  console.log('wrote', path.relative(path.join(__dirname, '..'), outPath), `${size}x${size} (solid, no mark)`);
}

async function main() {
  // --- Native/generic app icon - replaces the grid-contaminated default ---
  await makeIcon(path.join(ASSETS_DIR, 'icon.png'), 1024, 0.58);

  // --- Android adaptive icon background layer - the mark itself lives in
  // the separate, already-correct android-icon-foreground.png layer; this
  // layer must stay a plain fill, or Android would render the mark twice
  // (once from this layer, once from the foreground layer on top). ---
  await makeSolidCanvas(path.join(ASSETS_DIR, 'android-icon-background.png'), 512);

  // --- New web/PWA icon set, referenced from public/manifest.json and
  // public/index.html's <link rel="apple-touch-icon">. Written straight
  // into public/ (Expo's web export copies this directory's contents to
  // dist/ verbatim) rather than assets/, since none of these are used by
  // any native build. ---
  await makeIcon(path.join(PUBLIC_DIR, 'apple-touch-icon.png'), 180, 0.6);
  await makeIcon(path.join(PUBLIC_DIR, 'icon-192.png'), 192, 0.62);
  await makeIcon(path.join(PUBLIC_DIR, 'icon-512.png'), 512, 0.62);
  await makeIcon(path.join(PUBLIC_DIR, 'maskable-icon-512.png'), 512, 0.44);
}

main().catch((err) => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
