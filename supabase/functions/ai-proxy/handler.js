/**
 * handler.js — the ai-proxy Edge Function's request handling.
 * ----------------------------------------------------------------------------
 * Purpose: The server side of "AI keys saved to your account":
 *            - verifies and stores provider credentials ENCRYPTED, bound to
 *              the caller's verified user id (never one from the request);
 *            - completes OpenRouter's OAuth PKCE exchange server-side, so
 *              that key never reaches browser JavaScript;
 *            - proxies chat requests to the provider and records token
 *              usage (no prompts, no responses) as server telemetry;
 *            - revokes (deletes) a stored connection.
 *          Credentials are never returned, logged, or put in error messages.
 *
 *          Written against injected dependencies (auth, db, fetch, key) so
 *          the exact same code runs in Deno (index.ts) and under Node tests
 *          (mobile/tests/ai-proxy-handler.test.js). Provider logic comes from
 *          ../_shared/ai — a generated copy of js/ai, the same code the web
 *          and Android apps run.
 * ----------------------------------------------------------------------------
 */

import { AIError, AI_ERROR_CODES as C, CREDENTIAL_FAILURE_CODES, toAIError, redactSecrets } from '../_shared/ai/errors.js';
import { AUTH_METHODS, keyHint, requireProvider, resolveModel, supportsAuthMethod, validateChatRequest, validateConnectionInput } from '../_shared/ai/providers.js';
import { runProviderChat, verifyProviderKey } from '../_shared/ai/chat.js';
import { buildUsageRecord } from '../_shared/ai/usage.js';
import { exchangeOpenRouterCode } from '../_shared/ai/oauth.js';
import { PROXY_ACTIONS, toPublicConnection, usageRecordToRow } from '../_shared/ai/contract.js';
import { credentialAad, decryptCredential, encryptCredential } from './credentials.js';

const MAX_BODY_BYTES = 256 * 1024;

const STATUS_BY_CODE = {
  [C.APP_AUTH_REQUIRED]: 401,
  [C.GUEST_RESTRICTED]: 403,
  [C.NOT_CONNECTED]: 404,
  [C.RATE_LIMITED]: 429,
  [C.SERVER_MISCONFIGURED]: 503,
  [C.INVALID_INPUT]: 400,
  [C.UNSUPPORTED_MODEL]: 400,
  [C.UNSUPPORTED_PROVIDER]: 400,
  [C.OAUTH_FAILED]: 400,
  [C.OAUTH_STATE_MISMATCH]: 400,
};
/** Everything else is an upstream (provider) failure. */
const statusFor = (code) => STATUS_BY_CODE[code] || (code === C.UNKNOWN ? 500 : 502);

/**
 * @param {object} deps
 * @param {(req: Request) => Promise<{id:string, isAnonymous?:boolean}|null>} deps.authenticate
 * @param {{
 *   getConnection(userId:string, provider:string): Promise<object|null>,
 *   upsertConnection(row:object): Promise<object>,
 *   updateConnectionStatus(userId:string, provider:string, patch:object): Promise<void>,
 *   deleteConnection(userId:string, provider:string): Promise<number>,
 *   insertUsage(row:object): Promise<void>,
 * }} deps.db
 * @param {() => Promise<CryptoKey|null>} deps.getEncryptionKey
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {string[]} [deps.allowedOrigins]  ['*'] or exact origins
 * @param {(event:string, data?:object) => void} [deps.log] receives redacted, secret-free data only
 * @param {() => number} [deps.now]
 */
export function createAIProxyHandler(deps) {
  const { authenticate, db, getEncryptionKey } = deps;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const allowedOrigins = deps.allowedOrigins?.length ? deps.allowedOrigins : ['*'];
  const log = deps.log || (() => {});
  const now = deps.now || (() => Date.now());

  function corsHeaders(req) {
    const origin = req.headers.get('origin');
    const allow = allowedOrigins.includes('*') ? '*' : (origin && allowedOrigins.includes(origin) ? origin : null);
    return {
      ...(allow ? { 'Access-Control-Allow-Origin': allow } : {}),
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      Vary: 'Origin',
    };
  }

  function json(req, status, body) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  function errorResponse(req, err) {
    const e = err instanceof AIError ? err : toAIError(err);
    return json(req, statusFor(e.code), { error: { code: e.code, message: e.message } });
  }

  async function requireUser(req) {
    const user = await authenticate(req).catch(() => null);
    if (!user?.id) throw new AIError(C.APP_AUTH_REQUIRED);
    // Supabase anonymous sign-ins are guests: no server-side credential storage.
    if (user.isAnonymous) throw new AIError(C.GUEST_RESTRICTED);
    return user;
  }

  async function requireKey() {
    const key = await getEncryptionKey();
    if (!key) throw new AIError(C.SERVER_MISCONFIGURED);
    return key;
  }

  async function storeCredential(user, { provider, model, apiKey, authMethod }) {
    const key = await requireKey();
    const row = {
      user_id: user.id,
      provider,
      auth_method: authMethod,
      model,
      credential_ciphertext: await encryptCredential(key, apiKey, credentialAad(user.id, provider)),
      key_hint: keyHint(apiKey),
      status: 'active',
      last_error_code: null,
      last_verified_at: new Date(now()).toISOString(),
    };
    const saved = await db.upsertConnection(row);
    log('connection_saved', { provider, authMethod });
    return { connection: toPublicConnection(saved) };
  }

  const actions = {
    async [PROXY_ACTIONS.HEALTH]() {
      return { ok: true, encryptionConfigured: !!(await getEncryptionKey()) };
    },

    async [PROXY_ACTIONS.SAVE_KEY](req, payload) {
      const user = await requireUser(req);
      const input = validateConnectionInput(payload);
      await requireKey(); // fail fast before calling the provider
      await verifyProviderKey({ provider: input.provider, apiKey: input.apiKey, context: 'server', fetchImpl });
      return storeCredential(user, { ...input, authMethod: AUTH_METHODS.API_KEY });
    },

    async [PROXY_ACTIONS.OAUTH_EXCHANGE](req, payload) {
      const user = await requireUser(req);
      const provider = requireProvider(payload.provider);
      if (!supportsAuthMethod(provider.id, AUTH_METHODS.OAUTH_PKCE)) throw new AIError(C.UNSUPPORTED_PROVIDER);
      const { code, codeVerifier } = payload;
      if (typeof code !== 'string' || typeof codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
        throw new AIError(C.OAUTH_FAILED);
      }
      await requireKey();
      const apiKey = await exchangeOpenRouterCode({ code, codeVerifier, fetchImpl });
      return storeCredential(user, { provider: provider.id, model: resolveModel(provider.id, payload.model), apiKey, authMethod: AUTH_METHODS.OAUTH_PKCE });
    },

    async [PROXY_ACTIONS.DISCONNECT](req, payload) {
      const user = await requireUser(req);
      const provider = requireProvider(payload.provider);
      const count = await db.deleteConnection(user.id, provider.id);
      log('connection_deleted', { provider: provider.id });
      return { disconnected: count > 0 };
    },

    async [PROXY_ACTIONS.CHAT](req, payload) {
      const user = await requireUser(req);
      const chat = validateChatRequest(payload);
      const provider = requireProvider(chat.provider);
      const row = await db.getConnection(user.id, provider.id);
      if (!row) throw new AIError(C.NOT_CONNECTED, undefined, { provider: provider.id, providerLabel: provider.label });
      if (row.status === 'expired' || row.status === 'invalid') {
        throw new AIError(row.status === 'expired' ? C.AUTH_EXPIRED : C.AUTH_INVALID, undefined, { provider: provider.id, providerLabel: provider.label });
      }

      const key = await requireKey();
      let apiKey;
      try {
        apiKey = await decryptCredential(key, row.credential_ciphertext, credentialAad(user.id, provider.id));
      } catch {
        // Wrong owner/provider binding or a rotated encryption key: the stored
        // credential is unusable, so ask the user to reconnect.
        await db.updateConnectionStatus(user.id, provider.id, { status: 'invalid', last_error_code: C.AUTH_INVALID }).catch(() => {});
        throw new AIError(C.AUTH_INVALID, undefined, { provider: provider.id, providerLabel: provider.label });
      }

      const started = now();
      const record = async (fields) => {
        const usage = buildUsageRecord({ provider: provider.id, model: chat.model, feature: chat.feature, recordedBy: 'server', messages: chat.messages, ...fields });
        try {
          await db.insertUsage(usageRecordToRow(usage, user.id));
          return { usage, usageRecorded: true };
        } catch (err) {
          log('usage_insert_failed', { message: redactSecrets(err?.message || '') });
          return { usage, usageRecorded: false };
        }
      };

      let result;
      try {
        result = await runProviderChat({ ...chat, apiKey, context: 'server', fetchImpl, now });
      } catch (err) {
        const e = toAIError(err, provider);
        await record({ status: 'error', errorCode: e.code, latencyMs: now() - started });
        if (CREDENTIAL_FAILURE_CODES.includes(e.code)) {
          await db.updateConnectionStatus(user.id, provider.id, { status: e.code === C.AUTH_EXPIRED ? 'expired' : 'invalid', last_error_code: e.code }).catch(() => {});
        }
        log('chat_failed', { provider: provider.id, code: e.code, status: e.status });
        throw e;
      }

      const { usage, usageRecorded } = await record({
        status: 'success', usage: result.usage, servedModel: result.servedModel, responseText: result.text, latencyMs: result.latencyMs,
      });
      return { text: result.text, model: result.servedModel, usage, usageRecorded };
    },
  };

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
    if (req.method !== 'POST') return json(req, 405, { error: { code: C.INVALID_INPUT, message: 'Use POST.' } });
    try {
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) throw new AIError(C.INVALID_INPUT, 'The request is too large.');
      let payload;
      try { payload = JSON.parse(text || '{}'); } catch { throw new AIError(C.INVALID_INPUT, 'The request body is not valid JSON.'); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AIError(C.INVALID_INPUT);
      const action = Object.prototype.hasOwnProperty.call(actions, payload.action) ? actions[payload.action] : null;
      if (!action) throw new AIError(C.INVALID_INPUT, 'Unknown action.');
      return json(req, 200, await action(req, payload));
    } catch (err) {
      if (!(err instanceof AIError)) log('unexpected_error', { message: redactSecrets(err?.message || String(err)) });
      return errorResponse(req, err);
    }
  };
}
