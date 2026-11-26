/**
 * aiConnections.js
 * ----------------------------------------------------------------------------
 * Purpose: Owns the user's AI provider connection state — which provider and
 *          model are active, where the credential lives, and the
 *          connect / disconnect / OAuth flows. Keeps three identities apart:
 *
 *            App account   Supabase sign-in (auth.js) — who you are here.
 *            AI provider   the OpenAI/Anthropic/… credential — what pays for AI.
 *            Guest         no app account; everything is session-scoped.
 *
 *          Credential stores (rules in ai/policy.js):
 *            'account'  encrypted server-side by the ai-proxy Edge Function;
 *                       the browser only ever sees a key hint.
 *            'device'   this device's localStorage (signed-in users).
 *            'session'  this tab's sessionStorage (guests).
 *          A device/session key is bound to its owner ('guest' or
 *          'user:<id>') and its provider: it is never sent to another
 *          provider or used by another user who signs in on this device.
 * Inputs:  Storage settings, auth state, cloudStorage (ai-proxy + tables).
 * Outputs: Connection state for the UI and ai.js; side effects on Storage.
 * Depends on: storage.js, auth.js, cloudStorage.js, platform.js, config.js, ai/*.
 * ----------------------------------------------------------------------------
 */

import Storage from './storage.js';
import CONFIG from './config.js';
import { isAuthenticated, getCurrentUser, isCloudConfigured } from './auth.js';
import { invokeAIProxy, loadAIConnections, deleteAIConnection } from './cloudStorage.js';
import { isNativeApp } from './platform.js';
import { getAIEntitlements, ownerIdFor, CREDENTIAL_STORES } from './ai/policy.js';
import { AUTH_METHODS, DEFAULT_PROVIDER, getProvider, keyHint, requireProvider, resolveModel, validateConnectionInput } from './ai/providers.js';
import { verifyProviderKey } from './ai/chat.js';
import { AIError, AI_ERROR_CODES as C } from './ai/errors.js';
import { PROXY_ACTIONS } from './ai/contract.js';
import { buildOpenRouterAuthorizeUrl, createPkcePair, createState, exchangeOpenRouterCode, validateOAuthCallback } from './ai/oauth.js';

/** sessionStorage key for an OAuth attempt in progress (one-time; removed when the callback is handled). */
const OAUTH_PENDING_KEY = 'hmpa:aiOAuthPending';

let proxyHealth = { checked: false, available: false };
const listeners = new Set();

export function onAIConnectionChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify() { listeners.forEach(fn => { try { fn(getActiveConnection()); } catch (e) { console.error('[ai] listener error', e); } }); }

export function isGuestUser() { return !isAuthenticated(); }
export function currentOwnerId() { return ownerIdFor(isAuthenticated() ? getCurrentUser() : null); }

/** Whether the ai-proxy Edge Function is deployed and has its encryption key (cached per page load). */
export async function checkProxyHealth({ force = false } = {}) {
  if (isGuestUser() || !isCloudConfigured()) return false;
  if (proxyHealth.checked && !force) return proxyHealth.available;
  try {
    const r = await invokeAIProxy(PROXY_ACTIONS.HEALTH, {}, { timeoutMs: 8000 });
    proxyHealth = { checked: true, available: !!(r?.ok && r.encryptionConfigured) };
  } catch {
    proxyHealth = { checked: true, available: false };
  }
  return proxyHealth.available;
}

export function getEntitlements() {
  return getAIEntitlements({ isGuest: isGuestUser(), cloudConfigured: isCloudConfigured(), proxyAvailable: proxyHealth.available, isNative: isNativeApp() });
}

function cachedAccountConnections() {
  const cache = Storage.getAIConnectionCache();
  return cache.ownerId === currentOwnerId() ? cache.connections || [] : [];
}

function saveAccountConnections(connections) {
  Storage.saveAIConnectionCache({ ownerId: currentOwnerId(), connections, fetchedAt: new Date().toISOString() });
}

function upsertCachedConnection(connection) {
  saveAccountConnections([...cachedAccountConnections().filter(c => c.provider !== connection.provider), connection]);
}

/** Reloads the account's connection list (non-secret columns) from the cloud. */
export async function refreshAccountConnections() {
  if (isGuestUser() || !isCloudConfigured()) return [];
  const connections = await loadAIConnections();
  saveAccountConnections(connections);
  notify();
  return connections;
}

export function getAccountConnections() { return isGuestUser() ? [] : cachedAccountConnections(); }

/** The device/session key, only if it belongs to the current owner AND the given provider. */
function deviceCredential(provider) {
  const s = Storage.getSettings();
  if (!s.apiKey || s.aiKeyOwner !== currentOwnerId() || s.aiKeyProvider !== provider) return null;
  return { apiKey: s.apiKey, status: s.aiKeyStatus || 'active', authMethod: s.aiKeyAuthMethod || AUTH_METHODS.API_KEY };
}

/**
 * The active provider/model and whether it can be used right now. Sync and
 * secret-free (keyHint only) — safe to call from any render function.
 */
export function getActiveConnection() {
  const s = Storage.getSettings();
  const provider = getProvider(s.aiProvider) ? s.aiProvider : DEFAULT_PROVIDER;
  const providerInfo = getProvider(provider);
  const model = resolveModel(provider, s.aiModel);
  const base = { provider, providerInfo, model };

  if (!isGuestUser() && s.aiCredentialStore === CREDENTIAL_STORES.ACCOUNT) {
    const conn = cachedAccountConnections().find(c => c.provider === provider);
    return { ...base, store: CREDENTIAL_STORES.ACCOUNT, connected: !!conn, configured: !!conn, status: conn?.status || 'none', keyHint: conn?.keyHint || null, authMethod: conn?.authMethod || null };
  }
  const cred = deviceCredential(provider);
  return {
    ...base,
    store: isGuestUser() ? CREDENTIAL_STORES.SESSION : CREDENTIAL_STORES.DEVICE,
    connected: !!cred,
    configured: !!cred,
    status: cred?.status || 'none',
    keyHint: cred ? keyHint(cred.apiKey) : null,
    authMethod: cred?.authMethod || null,
  };
}

export function isAIConfigured() { return getActiveConnection().configured; }

/** Secret-free status of `provider` in `store` (not necessarily the active one) — for the settings UI. */
export function getConnectionStatus(provider, store) {
  if (store === CREDENTIAL_STORES.ACCOUNT) {
    const conn = getAccountConnections().find(c => c.provider === provider);
    return conn ? { connected: true, status: conn.status, keyHint: conn.keyHint, authMethod: conn.authMethod, model: conn.model } : { connected: false, status: 'none' };
  }
  const cred = deviceCredential(provider);
  return cred ? { connected: true, status: cred.status, keyHint: keyHint(cred.apiKey), authMethod: cred.authMethod, model: null } : { connected: false, status: 'none' };
}

/** For ai.js only: the plaintext key for a device/session connection. Never log or render it. */
export function getDeviceApiKey(provider) { return deviceCredential(provider)?.apiKey || null; }

/** Switches the active provider/model (and store) without touching any credential. */
export function selectProviderModel({ provider, model, store }) {
  requireProvider(provider);
  const patch = { aiProvider: provider, aiModel: resolveModel(provider, model) };
  if (store) patch.aiCredentialStore = store === CREDENTIAL_STORES.ACCOUNT ? CREDENTIAL_STORES.ACCOUNT : CREDENTIAL_STORES.DEVICE;
  Storage.saveSettings(patch);
  notify();
  return getActiveConnection();
}

function assertStoreAllowed(store) {
  const ent = getEntitlements();
  const allowed = ent.credentialStores.includes(store)
    // 'device' and 'session' are the same thing from the caller's point of view.
    || (store === CREDENTIAL_STORES.DEVICE && ent.credentialStores.includes(CREDENTIAL_STORES.SESSION));
  if (allowed) return;
  if (store === CREDENTIAL_STORES.ACCOUNT && isGuestUser()) throw new AIError(C.GUEST_RESTRICTED);
  throw new AIError(C.PROXY_UNAVAILABLE);
}

function saveDeviceCredential({ provider, model, apiKey, status, authMethod }) {
  Storage.saveSettings({
    aiProvider: provider, aiModel: model, aiCredentialStore: CREDENTIAL_STORES.DEVICE,
    apiKey, aiKeyOwner: currentOwnerId(), aiKeyProvider: provider, aiKeyStatus: status, aiKeyAuthMethod: authMethod,
  });
}

/** Removes the device key if it belongs to `provider` (one copy of a credential at a time). */
function clearDeviceCredential(provider) {
  const s = Storage.getSettings();
  if (s.aiKeyProvider === provider || s.aiKeyOwner !== currentOwnerId()) {
    Storage.saveSettings({ apiKey: '', aiKeyOwner: null, aiKeyProvider: null, aiKeyStatus: 'active', aiKeyAuthMethod: AUTH_METHODS.API_KEY });
  }
}

/**
 * Connects with an API key. Account storage: ai-proxy verifies the key with
 * the provider, encrypts and stores it. Device/session storage: the browser
 * verifies it directly with the provider and keeps it locally.
 * @returns {Promise<{connection: object, verified: boolean}>}
 */
export async function connectWithApiKey({ provider, model, apiKey, store }) {
  assertStoreAllowed(store);
  const input = validateConnectionInput({ provider, model, apiKey });

  if (store === CREDENTIAL_STORES.ACCOUNT) {
    const { connection } = await invokeAIProxy(PROXY_ACTIONS.SAVE_KEY, input);
    upsertCachedConnection(connection);
    clearDeviceCredential(input.provider);
    selectProviderModel({ provider: input.provider, model: input.model, store: CREDENTIAL_STORES.ACCOUNT });
    return { connection: getActiveConnection(), verified: true };
  }

  let status = 'active';
  try {
    await verifyProviderKey({ provider: input.provider, apiKey: input.apiKey, context: 'browser' });
  } catch (err) {
    // A rejected key is never saved. If we simply couldn't reach the
    // provider (offline, or its verify endpoint blocks browsers), save it as
    // unverified — the first real request will verify it.
    if (!(err instanceof AIError) || ![C.NETWORK, C.TIMEOUT, C.PROVIDER_UNAVAILABLE].includes(err.code)) throw err;
    status = 'unverified';
  }
  saveDeviceCredential({ ...input, status, authMethod: AUTH_METHODS.API_KEY });
  notify();
  return { connection: getActiveConnection(), verified: status === 'active' };
}

/** Disconnects (revokes) a provider in the active store. */
export async function disconnectProvider(provider, store = getActiveConnection().store) {
  requireProvider(provider);
  if (store === CREDENTIAL_STORES.ACCOUNT) {
    try {
      await invokeAIProxy(PROXY_ACTIONS.DISCONNECT, { provider });
    } catch (err) {
      if (err?.code !== C.PROXY_UNAVAILABLE) throw err;
      await deleteAIConnection(provider); // RLS allows deleting your own row directly
    }
    saveAccountConnections(cachedAccountConnections().filter(c => c.provider !== provider));
  } else {
    clearDeviceCredential(provider);
  }
  notify();
}

/** Called by ai.js when a provider rejects the credential mid-use, so the UI can ask to reconnect. */
export function markCredentialFailure(provider, store, code) {
  const status = code === C.AUTH_EXPIRED ? 'expired' : 'invalid';
  if (store === CREDENTIAL_STORES.ACCOUNT) {
    const conn = cachedAccountConnections().find(c => c.provider === provider);
    if (conn) upsertCachedConnection({ ...conn, status, lastErrorCode: code });
  } else if (deviceCredential(provider)) {
    Storage.saveSettings({ aiKeyStatus: status });
  }
  notify();
}

/** After a successful request with an unverified device key, mark it verified. */
export function markCredentialVerified(provider, store) {
  if (store !== CREDENTIAL_STORES.ACCOUNT && deviceCredential(provider)?.status === 'unverified') {
    Storage.saveSettings({ aiKeyStatus: 'active' });
    notify();
  }
}

/* --------------------------------- OAuth PKCE --------------------------------- */

/** Where OpenRouter sends the user back: the app shell page, over https (or http://localhost in dev). */
export function oauthCallbackUrl() {
  return `${window.location.origin}${CONFIG.BASE_PATH}dashboard.html`;
}

export function canUseOAuth(provider) {
  return getEntitlements().authMethodsFor(provider).includes(AUTH_METHODS.OAUTH_PKCE);
}

/** Starts OpenRouter's official OAuth PKCE flow. Navigates the page away. */
export async function startOAuthConnection({ provider, model, store }) {
  if (!canUseOAuth(provider)) throw new AIError(C.UNSUPPORTED_PROVIDER, 'Signing in with this provider is not available here. Paste an API key instead.');
  assertStoreAllowed(store);
  const pkce = await createPkcePair();
  const state = createState();
  const pending = { provider, model: resolveModel(provider, model), store, state, verifier: pkce.verifier, createdAt: Date.now(), ownerId: currentOwnerId() };
  window.sessionStorage.setItem(OAUTH_PENDING_KEY, JSON.stringify(pending));
  window.location.assign(buildOpenRouterAuthorizeUrl({ callbackUrl: oauthCallbackUrl(), challenge: pkce.challenge, state }));
}

function takePendingOAuth() {
  try {
    const raw = window.sessionStorage.getItem(OAUTH_PENDING_KEY);
    window.sessionStorage.removeItem(OAUTH_PENDING_KEY); // one-time: a replayed callback finds nothing
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * If this page load is an OAuth callback (?ai_oauth=…), finishes it.
 * Removes code/state from the address bar first so they never linger in
 * history, bookmarks or shared links. Returns null when this isn't a
 * callback, else { ok, provider?, error? }.
 */
export async function completeOAuthFromUrl() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('ai_oauth')) return null;
  const pending = takePendingOAuth();
  window.history.replaceState(null, '', `${window.location.pathname}#settings`);
  try {
    const code = validateOAuthCallback({ params, pending });
    // Started by someone else on this browser (e.g. a guest who then signed in): ignore.
    if (pending.ownerId !== currentOwnerId()) throw new AIError(C.OAUTH_STATE_MISMATCH);
    // Fresh page load: learn whether ai-proxy is available before checking the store.
    if (pending.store === CREDENTIAL_STORES.ACCOUNT) await checkProxyHealth();
    assertStoreAllowed(pending.store);
    if (pending.store === CREDENTIAL_STORES.ACCOUNT) {
      const { connection } = await invokeAIProxy(PROXY_ACTIONS.OAUTH_EXCHANGE, { provider: pending.provider, model: pending.model, code, codeVerifier: pending.verifier });
      upsertCachedConnection(connection);
      clearDeviceCredential(pending.provider);
      selectProviderModel({ provider: pending.provider, model: pending.model, store: CREDENTIAL_STORES.ACCOUNT });
    } else {
      const apiKey = await exchangeOpenRouterCode({ code, codeVerifier: pending.verifier });
      saveDeviceCredential({ provider: pending.provider, model: pending.model, apiKey, status: 'active', authMethod: AUTH_METHODS.OAUTH_PKCE });
      notify();
    }
    return { ok: true, provider: pending.provider };
  } catch (err) {
    return { ok: false, error: err instanceof AIError ? err : new AIError(C.OAUTH_FAILED) };
  }
}
