#!/usr/bin/env node
/**
 * build-web.mjs — assembles mobile/www from the existing web app.
 * ----------------------------------------------------------------------------
 * The web app at the repository root stays the single source of truth; this
 * script only COPIES it and adapts the copy for the app:
 *
 *   1. Copies index.html, dashboard.html, css/, js/, data/ into www/.
 *   2. Replaces the CDN <script> tags with locally bundled copies of the
 *      same libraries at the same pinned versions (mobile/package.json), so
 *      the app starts offline and never loads remote code. Fails if a CDN
 *      version and the installed version disagree, or a CDN script remains.
 *   3. Injects runtime-config.js (window.__HMPA_CONFIG__ for this
 *      environment), the native bridge bundle and mobile.css.
 *
 * Usage: node scripts/build-web.mjs --env development|staging|production
 * ----------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { build, transform } from 'esbuild';
import { loadEnv, resolveRuntimeConfig } from './env.mjs';

const MOBILE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(MOBILE_DIR, '..');
const WWW = path.join(MOBILE_DIR, 'www');

const WEB_PAGES = ['index.html', 'dashboard.html'];
const WEB_DIRS = ['css', 'js', 'data'];

/** Matches <script src="https://cdn.jsdelivr.net/npm/<pkg>@<version>/<file>">. */
const CDN_SCRIPT_RE = /<script\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/((?:@[^/@]+\/)?[^/@]+)@([^/]+)\/([^"]+)"([^>]*)><\/script>/g;

export function versionSatisfies(installed, requested) {
  if (requested === installed) return true;
  // "@2" / "@2.5" style ranges on the CDN mean "latest within that prefix".
  return /^\d+(\.\d+)?$/.test(requested) && installed.startsWith(`${requested}.`);
}

/** Rewrites CDN script tags to vendor/ paths; returns the new HTML and files to copy. */
export function vendorCdnScripts(html, readInstalledVersion) {
  const copies = [];
  const out = html.replace(CDN_SCRIPT_RE, (_match, pkg, requested, file, attrs) => {
    const installed = readInstalledVersion(pkg);
    if (!installed) throw new Error(`${pkg} is loaded from the CDN but not installed in mobile/. Add it to mobile/package.json.`);
    if (!versionSatisfies(installed, requested)) {
      throw new Error(`${pkg}: web app loads @${requested} from the CDN but mobile/package.json has ${installed}. Keep them in sync.`);
    }
    const rel = `vendor/${pkg}/${file}`;
    copies.push({ pkg, file, rel });
    return `<script src="./${rel}"${attrs}></script>`;
  });
  if (/<script[^>]+src="https?:\/\//i.test(out)) {
    throw new Error('A remote <script src> remains after vendoring. The app must not load remote code.');
  }
  return { html: out, copies };
}

export function injectMobileTags(html) {
  const headScripts = '<script src="./runtime-config.js"></script>\n<script src="./native/bridge.js"></script>\n';
  if (!html.includes('href="./css/styles.css"')) throw new Error('Expected ./css/styles.css link not found.');
  return html
    .replace('<link rel="stylesheet" href="./css/styles.css" />', '<link rel="stylesheet" href="./css/styles.css" />\n<link rel="stylesheet" href="./native/mobile.css" />')
    .replace('</head>', `${headScripts}</head>`);
}

function readInstalledVersion(pkg) {
  const p = path.join(MOBILE_DIR, 'node_modules', pkg, 'package.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).version : null;
}

function gitSha() {
  try { return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim(); } catch { return 'unknown'; }
}

async function main() {
  const modeArg = process.argv.indexOf('--env');
  const mode = modeArg >= 0 ? process.argv[modeArg + 1] : (process.env.APP_ENV || 'development');
  const capConfig = JSON.parse(fs.readFileSync(path.join(MOBILE_DIR, 'capacitor.config.json'), 'utf8'));
  const runtimeConfig = resolveRuntimeConfig(loadEnv(mode, MOBILE_DIR), { mode, appId: capConfig.appId });
  const pkg = JSON.parse(fs.readFileSync(path.join(MOBILE_DIR, 'package.json'), 'utf8'));

  fs.rmSync(WWW, { recursive: true, force: true });
  fs.mkdirSync(WWW, { recursive: true });

  for (const dir of WEB_DIRS) fs.cpSync(path.join(REPO_ROOT, dir), path.join(WWW, dir), { recursive: true });

  const vendored = new Map();
  for (const page of WEB_PAGES) {
    const source = fs.readFileSync(path.join(REPO_ROOT, page), 'utf8');
    const { html, copies } = vendorCdnScripts(source, readInstalledVersion);
    copies.forEach(c => vendored.set(c.rel, c));
    fs.writeFileSync(path.join(WWW, page), injectMobileTags(html));
  }
  for (const { pkg: name, file, rel } of vendored.values()) {
    const dest = path.join(WWW, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const from = path.join(MOBILE_DIR, 'node_modules', name, file);
    if (fs.existsSync(from)) { fs.copyFileSync(from, dest); continue; }
    // jsDelivr serves an auto-minified "x.min.js" for packages that only
    // publish "x.js" (e.g. chart.js) — reproduce that from the same source.
    const unminified = from.replace(/\.min\.js$/, '.js');
    if (unminified === from || !fs.existsSync(unminified)) throw new Error(`Vendored file missing: ${from}`);
    const { code } = await transform(fs.readFileSync(unminified, 'utf8'), { minify: true, legalComments: 'inline', target: 'chrome89' });
    fs.writeFileSync(dest, code);
  }

  fs.mkdirSync(path.join(WWW, 'native'), { recursive: true });
  fs.copyFileSync(path.join(MOBILE_DIR, 'src', 'mobile.css'), path.join(WWW, 'native', 'mobile.css'));
  await build({
    entryPoints: [path.join(MOBILE_DIR, 'src', 'native-bridge.js')],
    outfile: path.join(WWW, 'native', 'bridge.js'),
    bundle: true,
    format: 'iife',
    target: ['chrome89'],
    minify: mode === 'production',
    sourcemap: mode === 'development' ? 'inline' : false,
    legalComments: 'none',
    logLevel: 'warning',
  });

  fs.writeFileSync(
    path.join(WWW, 'runtime-config.js'),
    `// Generated by mobile/scripts/build-web.mjs (${mode}). Do not edit.\nwindow.__HMPA_CONFIG__ = Object.freeze(${JSON.stringify(runtimeConfig, null, 2)});\n`,
  );
  fs.writeFileSync(path.join(WWW, 'build-info.json'), JSON.stringify({
    env: mode, version: pkg.version, gitSha: gitSha(), builtAt: new Date().toISOString(),
  }, null, 2));

  const target = runtimeConfig.SUPABASE_URL || '(js/config.js default)';
  console.log(`[build-web] ${mode}: www/ ready — backend ${target}, OAuth redirect ${runtimeConfig.REDIRECT_URL}, vendored ${vendored.size} libraries.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`[build-web] ${err.message}`); process.exit(1); });
}
