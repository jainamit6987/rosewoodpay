// Regenerates every square app-icon asset this project needs from ONE
// source image - assets/CustomAppLogo.jpeg (the user's own "RW Pay" logo,
// 2026-09-14) - resized to whatever each use case needs. Unlike the
// original version of this script (see git history if curious), this
// source is already a complete, finished icon (gradient background +
// centered white badge + wordmark), not a transparent foreground-only
// mark that needed compositing onto a plain background - so this version
// just resizes, it doesn't composite.
//
// History: this script originally fixed the PWA "black icon on Add to
// Home Screen" bug by generating a manifest-ready icon set from the
// then-current blue-chevron placeholder mark (assets/android-icon-
// foreground.png), after confirming Metro's web export never generates a
// PWA manifest/apple-touch-icon on its own. That fix (the manifest.json +
// index.html link tags + the file names/sizes below) is unchanged - only
// the source artwork swapped, from the placeholder chevron to the user's
// real logo.
//
// Uses `jimp-compact` - not a new dependency, already installed as
// @expo/image-utils's own runtime image library (Expo CLI's icon-related
// commands use it internally), so this needed nothing extra in
// package.json.
//
// Run with: node scripts/generate-pwa-icons.js
// (regenerates everything below; re-run any time SOURCE_LOGO changes)
const path = require('path');
const Jimp = require('jimp-compact');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SOURCE_LOGO = path.join(ASSETS_DIR, 'CustomAppLogo.jpeg');

const WHITE = 0xffffffff; // jimp hex colors are 0xRRGGBBAA

// Plain edge-to-edge resize - correct for every "any"-purpose icon slot,
// since the source is already a complete square icon design (a gradient
// background with a centered white circular badge), not a mark that
// needs padding added around it.
async function makeIcon(outPath, size) {
  const img = await Jimp.read(SOURCE_LOGO);
  img.resize(size, size);
  await img.writeAsync(outPath);
  console.log('wrote', path.relative(path.join(__dirname, '..'), outPath), `${size}x${size}`);
}

// Maskable icons get aggressively cropped by the OS (Android may cut a
// circle/squircle out of the middle ~80% of the canvas) - shrinking the
// logo onto a plain white canvas first keeps the readable white badge +
// "RW PAY" wordmark safely inside that crop zone, at the cost of losing
// some of the outer gradient corners on devices that mask this way.
async function makeMaskableIcon(outPath, size, scale) {
  const canvas = new Jimp(size, size, WHITE);
  const img = await Jimp.read(SOURCE_LOGO);
  const inset = Math.round(size * scale);
  img.resize(inset, inset);
  const offset = Math.round((size - inset) / 2);
  canvas.composite(img, offset, offset);
  await canvas.writeAsync(outPath);
  console.log('wrote', path.relative(path.join(__dirname, '..'), outPath), `${size}x${size} (maskable, scale=${scale})`);
}

async function main() {
  // --- Native/generic app icon ---
  await makeIcon(path.join(ASSETS_DIR, 'icon.png'), 1024);

  // --- Android adaptive icon. The source has no transparency and is a
  // complete design (not a "foreground mark over a separate background"
  // split like a real Android adaptive icon expects) - using it as the
  // foreground layer at full size means it completely covers whatever
  // the background layer is, so the background layer's own content is
  // irrelevant; kept as a plain white fill for simplicity/predictability
  // rather than duplicating the same image into both layers. ---
  await makeIcon(path.join(ASSETS_DIR, 'android-icon-foreground.png'), 512);
  const solidBg = new Jimp(512, 512, WHITE);
  await solidBg.writeAsync(path.join(ASSETS_DIR, 'android-icon-background.png'));
  console.log('wrote assets/android-icon-background.png 512x512 (solid, no mark)');

  // --- Web/PWA icon set, referenced from public/manifest.json and
  // public/index.html's <link rel="apple-touch-icon">. Written straight
  // into public/ (Expo's web export copies this directory's contents to
  // dist/ verbatim) rather than assets/, since none of these are used by
  // any native build. ---
  await makeIcon(path.join(PUBLIC_DIR, 'apple-touch-icon.png'), 180);
  await makeIcon(path.join(PUBLIC_DIR, 'icon-192.png'), 192);
  await makeIcon(path.join(PUBLIC_DIR, 'icon-512.png'), 512);
  await makeMaskableIcon(path.join(PUBLIC_DIR, 'maskable-icon-512.png'), 512, 0.8);
}

main().catch((err) => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
