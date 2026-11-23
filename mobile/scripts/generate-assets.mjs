#!/usr/bin/env node
/**
 * Renders the app icon / adaptive icon / splash source images from the web
 * app's existing brand mark (the leaf in index.html, colours from
 * css/variables.css), then runs @capacitor/assets to produce every Android
 * density. Re-run after changing the brand: `npm run assets`.
 *
 * Outputs (committed): mobile/assets/*.png, mobile/assets/store/*.png (Play
 * listing icon + feature graphic) and android/app/src/main/res/mipmap-* / drawable-*.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

const mobileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(mobileDir, 'assets');

const PRIMARY = '#2F5233'; // --primary
const ACCENT = '#E08A1E';  // --accent
const LEAF = 'M20 9c-6 5-6 14 0 19 6-5 6-14 0-19z'; // brand-mark leaf, 40×40 viewBox

/** The leaf scaled so its height is `leafFraction` of a `size`-px square. */
function leafSvg(size, leafFraction, background) {
  const leafHeight = 19; // path spans y 9 → 28
  const scale = (size * leafFraction) / leafHeight;
  const tx = size / 2 - 20 * scale;
  const ty = size / 2 - 18.5 * scale;
  const bg = background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : '';
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${bg}<path d="${LEAF}" fill="${ACCENT}" transform="translate(${tx} ${ty}) scale(${scale})"/></svg>`);
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const write = (name, svg) => sharp(svg).png().toFile(path.join(outDir, name));

  await write('icon-only.png', leafSvg(1024, 0.56, PRIMARY));
  // Adaptive icon: @capacitor/assets wraps this in a 16.7% inset, which already keeps it inside the 66% safe zone.
  await write('icon-foreground.png', leafSvg(1024, 0.60, null));
  await write('icon-background.png', Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${PRIMARY}"/></svg>`));
  await write('splash.png', leafSvg(2732, 0.16, PRIMARY));
  await write('splash-dark.png', leafSvg(2732, 0.16, PRIMARY));

  // Google Play listing graphics (uploaded manually in Play Console).
  fs.mkdirSync(path.join(outDir, 'store'), { recursive: true });
  await sharp(leafSvg(512, 0.56, PRIMARY)).png().toFile(path.join(outDir, 'store', 'icon-512.png'));
  const leaf = await sharp(leafSvg(300, 0.8, null)).png().toBuffer();
  await sharp({ create: { width: 1024, height: 500, channels: 3, background: PRIMARY } })
    .composite([{ input: leaf, left: 362, top: 100 }])
    .png().toFile(path.join(outDir, 'store', 'feature-graphic-1024x500.png'));

  const res = spawnSync('npx', ['capacitor-assets', 'generate', '--android',
    '--iconBackgroundColor', PRIMARY, '--iconBackgroundColorDark', PRIMARY,
    '--splashBackgroundColor', PRIMARY, '--splashBackgroundColorDark', PRIMARY],
  { cwd: mobileDir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) process.exit(res.status ?? 1);

  // Android 13+ themed icons: reuse the leaf foreground as the monochrome layer
  // (@capacitor/assets does not emit one).
  for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    const file = path.join(mobileDir, 'android/app/src/main/res/mipmap-anydpi-v26', name);
    const xml = fs.readFileSync(file, 'utf8');
    if (xml.includes('<monochrome>')) continue;
    fs.writeFileSync(file, xml.replace('</adaptive-icon>',
      '    <monochrome>\n        <inset android:drawable="@mipmap/ic_launcher_foreground" android:inset="16.7%" />\n    </monochrome>\n</adaptive-icon>'));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
