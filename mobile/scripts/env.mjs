/**
 * env.mjs
 * ----------------------------------------------------------------------------
 * Loads mobile/.env.<mode> files and turns them into the runtime config the
 * packaged app receives as window.__HMPA_CONFIG__ (read by js/config.js).
 * Pure functions are exported separately so they can be unit-tested.
 * ----------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';

export const MODES = ['development', 'staging', 'production'];

/** Minimal KEY=VALUE parser (comments, blank lines, optional quotes). */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** .env.<mode> then .env.<mode>.local, then real environment variables win. */
export function loadEnv(mode, dir, processEnv = process.env) {
  const merged = {};
  for (const file of [`.env.${mode}`, `.env.${mode}.local`]) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) Object.assign(merged, parseEnvFile(fs.readFileSync(p, 'utf8')));
  }
  for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'PUBLIC_URL']) {
    if (processEnv[key] !== undefined && processEnv[key] !== '') merged[key] = processEnv[key];
  }
  return merged;
}

function decodeJwtRole(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role || null;
  } catch {
    return null;
  }
}

/** Refuses Supabase keys that bypass Row Level Security. */
export function assertPublishableKey(key) {
  if (!key) return;
  if (key.startsWith('sb_secret_') || /service_role/i.test(key) || decodeJwtRole(key) === 'service_role') {
    throw new Error('SUPABASE_ANON_KEY looks like a service_role/secret key. Only the anon/publishable key may ship in the app.');
  }
}

function assertHttps(name, value) {
  let u;
  try { u = new URL(value); } catch { throw new Error(`${name} is not a valid URL: ${value}`); }
  if (u.protocol !== 'https:') throw new Error(`${name} must use https:// (got ${value}).`);
}

/**
 * Builds window.__HMPA_CONFIG__ for a mode. In development, missing Supabase
 * values fall back to the defaults in js/config.js (the existing project);
 * staging and production must name their backend explicitly so a release
 * can never silently ship pointing at the wrong environment.
 */
export function resolveRuntimeConfig(env, { mode, appId }) {
  if (!MODES.includes(mode)) throw new Error(`Unknown mode "${mode}". Use one of: ${MODES.join(', ')}.`);
  if (!appId) throw new Error('appId is required.');

  const config = {
    APP_ENV: mode,
    REDIRECT_URL: `${appId}://auth-callback`,
  };

  const hasUrl = !!env.SUPABASE_URL;
  const hasKey = !!env.SUPABASE_ANON_KEY;
  if (hasUrl !== hasKey) throw new Error('Set both SUPABASE_URL and SUPABASE_ANON_KEY, or neither.');

  if (mode !== 'development' && !hasUrl) {
    throw new Error(`SUPABASE_URL and SUPABASE_ANON_KEY are required for ${mode} builds. Copy mobile/.env.example to mobile/.env.${mode} or set them as environment variables.`);
  }

  if (hasUrl) {
    if (mode !== 'development') assertHttps('SUPABASE_URL', env.SUPABASE_URL);
    assertPublishableKey(env.SUPABASE_ANON_KEY);
    config.SUPABASE_URL = env.SUPABASE_URL;
    config.SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY;
  }

  if (env.PUBLIC_URL) {
    assertHttps('PUBLIC_URL', env.PUBLIC_URL);
    config.PUBLIC_URL = env.PUBLIC_URL;
  }

  return config;
}
