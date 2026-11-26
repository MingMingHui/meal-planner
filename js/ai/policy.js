/**
 * ai/policy.js
 * ----------------------------------------------------------------------------
 * Purpose: The AI entitlement and guest rules, in one pure function so the
 *          web app, the Android app and the ai-proxy Edge Function apply the
 *          same rules. Mirrors the app's existing guest model (storage.js):
 *          guests keep everything in this browser tab's session only and
 *          never write to the cloud.
 *
 *            Where can a credential live?
 *              guest                      -> 'session' (this tab, cleared on close)
 *              signed in, ai-proxy up     -> 'account' (encrypted server-side) or 'device'
 *              signed in, ai-proxy down   -> 'device'  (this device's localStorage)
 *            Where is usage history kept?
 *              guest   -> this tab's session only
 *              account -> the user's own rows in ai_usage_records (RLS)
 *            Which auth methods are offered?
 *              OAuth PKCE only where the provider supports it AND the
 *              platform can receive its https callback (not the Android
 *              app — its return path is a custom-scheme deep link, which
 *              OpenRouter does not accept as a callback_url).
 * Inputs:  { isGuest, cloudConfigured, proxyAvailable, isNative }
 * Outputs: An entitlements object.
 * Depends on: ./providers.js
 * ----------------------------------------------------------------------------
 */

import { AUTH_METHODS, getProvider } from './providers.js';

export const CREDENTIAL_STORES = Object.freeze({
  ACCOUNT: 'account', // encrypted in ai_provider_connections, only ai-proxy can decrypt
  DEVICE: 'device',   // this device's localStorage, bound to the signed-in user id
  SESSION: 'session', // guest: this browser tab's sessionStorage
});

/** @param {{isGuest?: boolean, cloudConfigured?: boolean, proxyAvailable?: boolean, isNative?: boolean}} [opts] */
export function getAIEntitlements({ isGuest = false, cloudConfigured = false, proxyAvailable = false, isNative = false } = {}) {
  const canUseAccount = !isGuest && cloudConfigured && proxyAvailable;
  const credentialStores = isGuest
    ? [CREDENTIAL_STORES.SESSION]
    : canUseAccount ? [CREDENTIAL_STORES.ACCOUNT, CREDENTIAL_STORES.DEVICE] : [CREDENTIAL_STORES.DEVICE];
  return {
    isGuest: !!isGuest,
    credentialStores,
    defaultCredentialStore: credentialStores[0],
    accountStorageReason: isGuest ? 'guest' : !cloudConfigured ? 'cloud_not_configured' : !proxyAvailable ? 'proxy_unavailable' : null,
    usageHistory: isGuest ? 'session' : 'account',
    canSyncUsageToCloud: !isGuest && cloudConfigured,
    /** Auth methods to offer for a provider on this platform. */
    authMethodsFor(providerId) {
      const p = getProvider(providerId);
      if (!p) return [];
      return p.authMethods.filter(m => m !== AUTH_METHODS.OAUTH_PKCE || !isNative);
    },
  };
}

/**
 * Who a device-stored credential or locally kept usage record belongs to.
 * Guests are 'guest'; signed-in users are their Supabase user id. A device
 * key saved by one user is never used for another (see aiConnections.js).
 */
export function ownerIdFor(user) {
  return user?.id ? `user:${user.id}` : 'guest';
}
