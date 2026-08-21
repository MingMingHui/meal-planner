/**
 * auth.js
 * ----------------------------------------------------------------------------
 * Purpose: Owns all authentication concerns — initializing the Supabase
 *          client, starting OAuth sign-in (branded as "Continue with Gmail"
 *          / "Continue with Outlook" in the UI, backed by the Google and
 *          Microsoft/Azure AD OAuth providers respectively — Gmail and
 *          Outlook are not themselves OAuth providers, so the underlying
 *          `provider:` values passed to Supabase stay 'google' / 'azure'),
 *          signing out, and exposing the current session/user plus an
 *          auth-state change subscription. Contains NO database/table logic
 *          — see cloudStorage.js for that.
 * Inputs:  CONFIG (config.js) for Supabase URL/anon key.
 * Outputs: A small public API used by app.js and syncManager.js.
 * Depends on: config.js, the Supabase JS UMD build loaded globally via CDN
 *             in index.html (window.supabase.createClient).
 * ----------------------------------------------------------------------------
 */

import CONFIG from './config.js';

let client = null;
let currentUser = null;
let currentSession = null;
const listeners = new Set();

/** True once Supabase credentials are present in config.js. Guest-only otherwise. */
export function isCloudConfigured() {
  return CONFIG.CLOUD_ENABLED && typeof window.supabase?.createClient === 'function';
}

/**
 * Creates the Supabase client (once) and restores any existing session.
 * Safe to call even when the app is deployed with no Supabase credentials —
 * in that case the app simply runs in guest-only mode.
 */
export async function initializeAuth() {
  if (!isCloudConfigured()) {
    console.info('[auth] No Supabase credentials configured — running in guest-only mode.');
    return { ok: false, reason: 'not_configured' };
  }

  try {
    client = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });

    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    currentSession = data.session;
    currentUser = data.session?.user || null;

    client.auth.onAuthStateChange((event, session) => {
      currentSession = session;
      currentUser = session?.user || null;
      listeners.forEach(fn => {
        try { fn(event, session); } catch (e) { console.error('[auth] listener error', e); }
      });
    });

    return { ok: true };
  } catch (err) {
    console.error('[auth] initialization failed', err);
    return { ok: false, reason: 'init_error', error: err };
  }
}

function requireClient() {
  if (!client) throw new Error('Cloud sign-in is not configured for this deployment. See README → Authentication Setup.');
}

/** Starts the "Continue with Gmail" flow — Google OAuth under the hood. Redirects the browser away and back. */
export async function signInWithGmail() {
  requireClient();
  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: CONFIG.REDIRECT_URL },
  });
  if (error) throw new Error(humanizeAuthError(error));
}

/** Starts the "Continue with Outlook" flow — Microsoft/Azure AD OAuth under the hood. */
export async function signInWithOutlook() {
  requireClient();
  const { error } = await client.auth.signInWithOAuth({
    provider: 'azure',
    options: { redirectTo: CONFIG.REDIRECT_URL, scopes: 'email' },
  });
  if (error) throw new Error(humanizeAuthError(error));
}

/** Signs the user out. Local and cloud data are left untouched. */
export async function signOut() {
  if (!client) { currentUser = null; currentSession = null; return; }
  const { error } = await client.auth.signOut();
  if (error) throw new Error(humanizeAuthError(error));
  currentUser = null;
  currentSession = null;
}

export function getCurrentUser() { return currentUser; }
export function getSession() { return currentSession; }
export function isAuthenticated() { return !!currentUser; }
export function getSupabaseClient() { return client; }

/** Registers a callback for auth state changes (SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED, etc). */
export function listenToAuthChanges(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** Maps the raw Supabase OAuth provider id to the branded name shown in the UI. */
const PROVIDER_DISPLAY_NAMES = { google: 'Gmail', azure: 'Outlook' };

/** Extracts a friendly display profile from the Supabase user object. */
export function getUserProfile() {
  if (!currentUser) return null;
  const meta = currentUser.user_metadata || {};
  const provider = currentUser.app_metadata?.provider || 'unknown';
  return {
    id: currentUser.id,
    name: meta.full_name || meta.name || currentUser.email?.split('@')[0] || 'User',
    email: currentUser.email || '',
    avatarUrl: meta.avatar_url || meta.picture || '',
    provider,
    providerLabel: PROVIDER_DISPLAY_NAMES[provider] || provider,
  };
}

function humanizeAuthError(error) {
  const msg = (error?.message || '').toLowerCase();
  if (msg.includes('popup') || msg.includes('closed')) return 'The sign-in window was closed before finishing. Please try again.';
  if (msg.includes('network')) return 'A network error occurred while signing in. Check your connection and try again.';
  if (msg.includes('provider is not enabled')) return 'This sign-in provider is not enabled for this app yet.';
  return error?.message || 'Sign-in failed. Please try again.';
}
