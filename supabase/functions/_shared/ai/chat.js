/**
 * ai/chat.js
 * ----------------------------------------------------------------------------
 * Purpose: Executes one provider call through the AIProvider adapter — used
 *          both by the browser (guest / "this device only" keys) and by the
 *          ai-proxy Edge Function (keys stored in the account), so timeouts,
 *          error classification and response parsing are identical on every
 *          platform. Also verifies a key with a cheap authenticated GET.
 * Inputs:  A validated request (providers.validateChatRequest), the key, and
 *          an injected fetch.
 * Outputs: { text, servedModel, usage, latencyMs } or a thrown AIError.
 * Depends on: ./providers.js, ./errors.js
 * ----------------------------------------------------------------------------
 */

import { getAdapter, requireProvider, CHAT_LIMITS } from './providers.js';
import { AIError, AI_ERROR_CODES as C, providerHttpError, toAIError } from './errors.js';

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} p
 * @param {string} p.provider
 * @param {string} p.model
 * @param {string} p.apiKey
 * @param {Array<{role:string, content:string}>} p.messages
 * @param {number} p.temperature
 * @param {number} p.maxTokens
 * @param {'browser'|'server'} p.context
 * @param {typeof fetch} [p.fetchImpl]
 * @param {number} [p.timeoutMs]
 * @param {() => number} [p.now]
 */
export async function runProviderChat(p) {
  const provider = requireProvider(p.provider);
  const adapter = getAdapter(provider);
  const fetchImpl = p.fetchImpl || globalThis.fetch;
  const now = p.now || (() => Date.now());
  if (!p.apiKey) throw new AIError(C.NOT_CONFIGURED);

  const { url, init } = adapter.buildChatRequest({ ...p, provider });
  const started = now();
  let res;
  try {
    res = await fetchWithTimeout(fetchImpl, url, init, p.timeoutMs || CHAT_LIMITS.timeoutMs);
  } catch (err) {
    throw toAIError(err, provider);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw providerHttpError(res.status, body, provider);
  }
  const json = await res.json().catch(() => null);
  if (!json) throw new AIError(C.BAD_RESPONSE, undefined, { provider: provider.id, providerLabel: provider.label });
  const parsed = adapter.parseChatResponse(json, { provider, model: p.model });
  if (!parsed.text) throw new AIError(C.BAD_RESPONSE, undefined, { provider: provider.id, providerLabel: provider.label });
  return { ...parsed, latencyMs: now() - started };
}

/** Resolves true if the provider accepts the key; throws AIError (auth_invalid etc.) otherwise. */
export async function verifyProviderKey({ provider: providerId, apiKey, context, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  const provider = requireProvider(providerId);
  const req = getAdapter(provider).buildVerifyRequest({ provider, apiKey, context });
  if (!req) return true;
  let res;
  try {
    res = await fetchWithTimeout(fetchImpl, req.url, req.init, timeoutMs);
  } catch (err) {
    throw toAIError(err, provider);
  }
  if (res.ok) return true;
  const body = await res.json().catch(() => null);
  throw providerHttpError(res.status, body, provider);
}
