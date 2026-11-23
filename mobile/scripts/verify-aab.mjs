#!/usr/bin/env node
/**
 * verify-aab.mjs — checks a release Android App Bundle before upload.
 * ----------------------------------------------------------------------------
 *   1. bundletool validate                     (bundle is structurally valid)
 *   2. applicationId / versionName / versionCode match capacitor.config.json
 *      and version.json (or ANDROID_VERSION_CODE)
 *   3. targetSdk ≥ REQUIRED_TARGET_SDK, not debuggable
 *   4. Permissions are exactly the allowlist below
 *   5. Packaged runtime-config.js is a production build with an https
 *      backend, and no remote scripts / source maps / secret keys shipped
 *   6. jarsigner: bundle is signed (and not with the throwaway test key)
 *
 * Usage: npm run verify:aab [-- path/to/app.aab]
 * Needs a JDK (jar, jarsigner, java on PATH or JAVA_HOME). Downloads
 * bundletool-all once into node_modules/.cache unless BUNDLETOOL_JAR is set.
 * ----------------------------------------------------------------------------
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REQUIRED_TARGET_SDK = 36;
const BUNDLETOOL_VERSION = '1.18.1';
const ALLOWED_PERMISSIONS = new Set([
  'android.permission.INTERNET',
  // Added by androidx.core for runtime-registered receivers; not user-facing.
  '{appId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
]);

const mobileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aabPath = path.resolve(process.argv[2] || path.join(mobileDir, 'android/app/build/outputs/bundle/release/app-release.aab'));
const javaBin = (tool) => (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', tool) : tool);

const results = [];
const check = (ok, label, detail = '') => { results.push({ ok, label, detail }); };

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  return r;
}

async function bundletoolJar() {
  if (process.env.BUNDLETOOL_JAR) return process.env.BUNDLETOOL_JAR;
  const cached = path.join(mobileDir, 'node_modules', '.cache', `bundletool-all-${BUNDLETOOL_VERSION}.jar`);
  if (!fs.existsSync(cached)) {
    const url = `https://github.com/google/bundletool/releases/download/${BUNDLETOOL_VERSION}/bundletool-all-${BUNDLETOOL_VERSION}.jar`;
    console.log(`Downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`bundletool download failed: HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
  }
  return cached;
}

function attr(xml, name) {
  const m = xml.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

async function main() {
  if (!fs.existsSync(aabPath)) throw new Error(`AAB not found: ${aabPath}. Run npm run android:release first.`);
  const appId = JSON.parse(fs.readFileSync(path.join(mobileDir, 'capacitor.config.json'), 'utf8')).appId;
  const version = JSON.parse(fs.readFileSync(path.join(mobileDir, 'version.json'), 'utf8'));
  const expectedCode = process.env.ANDROID_VERSION_CODE ? Number(process.env.ANDROID_VERSION_CODE) : version.versionCode;
  const jar = await bundletoolJar();

  const validate = run(javaBin('java'), ['-jar', jar, 'validate', `--bundle=${aabPath}`]);
  check(validate.status === 0, 'bundletool validate', validate.status === 0 ? '' : validate.stderr.trim().split('\n').pop());

  const dump = run(javaBin('java'), ['-jar', jar, 'dump', 'manifest', `--bundle=${aabPath}`]);
  const manifest = dump.stdout;
  check(attr(manifest, 'package') === appId, 'applicationId', `${attr(manifest, 'package')} (expected ${appId})`);
  check(attr(manifest, 'android:versionName') === version.versionName, 'versionName', attr(manifest, 'android:versionName'));
  check(Number(attr(manifest, 'android:versionCode')) === expectedCode, 'versionCode', `${attr(manifest, 'android:versionCode')} (expected ${expectedCode})`);
  const target = Number(attr(manifest, 'android:targetSdkVersion'));
  check(target >= REQUIRED_TARGET_SDK, `targetSdkVersion ≥ ${REQUIRED_TARGET_SDK}`, String(target));
  check(!/android:debuggable="true"/.test(manifest), 'not debuggable');
  check(/android:allowBackup="false"/.test(manifest), 'allowBackup disabled');
  check(/android:usesCleartextTraffic="false"/.test(manifest), 'cleartext traffic disabled');

  const permissions = [...manifest.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map(m => m[1]);
  const allowed = new Set([...ALLOWED_PERMISSIONS].map(p => p.replace('{appId}', appId)));
  const unexpected = permissions.filter(p => !allowed.has(p));
  check(unexpected.length === 0, 'permissions allowlist', unexpected.length ? `unexpected: ${unexpected.join(', ')}` : permissions.join(', '));

  // Inspect the packaged web assets.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-'));
  try {
    run(javaBin('jar'), ['xf', aabPath, 'base/assets/public/'], { cwd: tmp });
    const pub = path.join(tmp, 'base', 'assets', 'public');
    const runtime = fs.existsSync(path.join(pub, 'runtime-config.js')) ? fs.readFileSync(path.join(pub, 'runtime-config.js'), 'utf8') : '';
    const configJson = runtime.slice(runtime.indexOf('{'), runtime.lastIndexOf('}') + 1);
    let cfg = {};
    try { cfg = JSON.parse(configJson); } catch { /* reported below */ }
    check(cfg.APP_ENV === 'production', 'web bundle built for production', cfg.APP_ENV || 'missing runtime-config.js');
    check(/^https:\/\//.test(cfg.SUPABASE_URL || ''), 'production backend is https', cfg.SUPABASE_URL || 'missing');
    check(cfg.REDIRECT_URL === `${appId}://auth-callback`, 'OAuth redirect matches applicationId', cfg.REDIRECT_URL || 'missing');

    const files = fs.readdirSync(pub, { recursive: true }).map(String).filter(f => fs.statSync(path.join(pub, f)).isFile());
    const maps = files.filter(f => f.endsWith('.map'));
    check(maps.length === 0, 'no source maps shipped', maps.join(', '));
    const html = ['index.html', 'dashboard.html'].map(f => fs.readFileSync(path.join(pub, f), 'utf8')).join('\n');
    check(!/<script[^>]+src="https?:\/\//i.test(html), 'no remote <script> tags');
    const allText = files.filter(f => /\.(js|html|json)$/.test(f)).map(f => fs.readFileSync(path.join(pub, f), 'utf8')).join('\n');
    // Look for actual key VALUES (the SDK and comments mention the names).
    const secretKeys = allText.match(/sb_secret_[A-Za-z0-9_-]{16,}/g) || [];
    const serviceJwts = (allText.match(/eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/g) || []).filter((jwt) => {
      try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')).role === 'service_role'; } catch { return false; }
    });
    check(secretKeys.length + serviceJwts.length === 0, 'no Supabase secret/service_role keys in web assets');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const signed = run(javaBin('jarsigner'), ['-verify', '-verbose', '-certs', aabPath]);
  const isSigned = signed.status === 0 && /jar verified/.test(signed.stdout) && !/unsigned/i.test(signed.stdout);
  const subject = (signed.stdout.match(/Signed by "([^"]+)"/) || signed.stdout.match(/X\.509, ([^\n]+)/) || [])[1] || '';
  check(isSigned, 'signed with an upload key', isSigned ? subject : 'UNSIGNED — set ANDROID_KEYSTORE_* (see docs)');
  if (isSigned && /TEST ONLY/.test(signed.stdout)) {
    check(false, 'not signed with the throwaway test key', 'rebuild with your real upload key before uploading');
  }

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
  const failed = results.filter(r => !r.ok).length;
  console.log(failed ? `\n${failed} check(s) failed for ${aabPath}` : `\nAll ${results.length} checks passed for ${aabPath}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(`[verify-aab] ${err.message}`); process.exit(1); });
