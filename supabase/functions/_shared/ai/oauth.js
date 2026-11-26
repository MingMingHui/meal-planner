/**
 * ai/oauth.js
 * ----------------------------------------------------------------------------
 * Purpose: OpenRouter's official OAuth PKCE flow
 *          (https://openrouter.ai/docs/guides/overview/auth/oauth), which lets
 *          a user approve this app on openrouter.ai and get back a
 *          user-controlled API key — no password ever touches this app.
 *          OpenAI and Anthropic offer no end-user OAuth for API access, so
 *          they use their official API-key flow instead (providers.js).
 *
 *          Flow: createPkcePair() + createState() -> buildAuthorizeUrl() ->
 *          user approves on openrouter.ai -> redirect to our callback with
 *          ?code=… -> state checked against the one we stored -> code +
 *          verifier exchanged for a key (in the browser for guest/device
 *          storage, or inside ai-proxy for account storage so the key never
 *          touches browser JavaScript).
 * Inputs:  A Web Crypto implementation (globalThis.crypto in browsers, Deno
 *          and Node 20+) and an injected fetch for the exchange.
 * Outputs: PKCE values, the authorize URL, the exchanged key.
 * Depends on: ./errors.js
 * ----------------------------------------------------------------------------
 */

import { AIError, AI_ERROR_CODES as C } from './errors.js';

export const OPENROUTER_AUTHORIZE_URL = 'https://openrouter.ai/auth';
export const OPENROUTER_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
/** How long a started-but-unfinished OAuth attempt stays valid. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function base64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(cryptoImpl, byteLength) {
  const bytes = new Uint8Array(byteLength);
  cryptoImpl.getRandomValues(bytes);
  return base64Url(bytes);
}

/** RFC 7636 verifier (43 chars) and its S256 challenge. */
export async function createPkcePair(cryptoImpl = globalThis.crypto) {
  const verifier = randomString(cryptoImpl, 32);
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)), method: 'S256' };
}

export function createState(cryptoImpl = globalThis.crypto) {
  return randomString(cryptoImpl, 24);
}

/**
 * OpenRouter has no separate `state` parameter, so our state travels inside
 * callback_url's own query string and comes back untouched alongside `code`.
 */
export function buildOpenRouterAuthorizeUrl({ callbackUrl, challenge, state }) {
  const cb = new URL(callbackUrl);
  cb.searchParams.set('ai_oauth', 'openrouter');
  cb.searchParams.set('state', state);
  const u = new URL(OPENROUTER_AUTHORIZE_URL);
  u.searchParams.set('callback_url', cb.toString());
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

/**
 * Validates a callback against the pending attempt this app stored. Returns
 * the code on success; throws OAUTH_STATE_MISMATCH for anything unexpected
 * (missing/forged/replayed state, expired attempt, wrong provider).
 */
export function validateOAuthCallback({ params, pending, now = Date.now() }) {
  const code = params.get('code');
  const state = params.get('state');
  const provider = params.get('ai_oauth');
  if (!pending || !state || !code || provider !== pending.provider) throw new AIError(C.OAUTH_STATE_MISMATCH);
  if (!timingSafeEqual(state, pending.state)) throw new AIError(C.OAUTH_STATE_MISMATCH);
  if (!(now - pending.createdAt >= 0 && now - pending.createdAt <= OAUTH_STATE_TTL_MS)) throw new AIError(C.OAUTH_STATE_MISMATCH);
  if (!/^[A-Za-z0-9._~-]{1,512}$/.test(code)) throw new AIError(C.OAUTH_STATE_MISMATCH);
  return code;
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Exchanges the one-time code + verifier for the user's OpenRouter key. */
export async function exchangeOpenRouterCode({ code, codeVerifier, fetchImpl = globalThis.fetch }) {
  if (!code || !codeVerifier) throw new AIError(C.OAUTH_FAILED);
  let res;
  try {
    res = await fetchImpl(OPENROUTER_EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: codeVerifier, code_challenge_method: 'S256' }),
    });
  } catch {
    throw new AIError(C.NETWORK, undefined, { provider: 'openrouter', providerLabel: 'OpenRouter' });
  }
  if (!res.ok) {
    throw new AIError(res.status >= 500 ? C.PROVIDER_UNAVAILABLE : C.OAUTH_FAILED, undefined, { status: res.status, provider: 'openrouter', providerLabel: 'OpenRouter' });
  }
  const data = await res.json().catch(() => null);
  if (!data || typeof data.key !== 'string' || !data.key) throw new AIError(C.OAUTH_FAILED, undefined, { provider: 'openrouter', providerLabel: 'OpenRouter' });
  return data.key;
}
