/**
 * ai/errors.js
 * ----------------------------------------------------------------------------
 * Purpose: One error vocabulary for every AI code path — the browser (web and
 *          Android, which package this same file) and the ai-proxy Edge
 *          Function (which receives a generated copy, see
 *          supabase/functions/_shared/ai/README.md). Provider HTTP failures
 *          are classified into stable codes so the UI never has to know a
 *          provider's error format, and user-facing messages never contain a
 *          provider's raw response body (which can echo request content).
 * Inputs:  HTTP status + parsed provider error bodies; arbitrary strings to
 *          redact before logging.
 * Outputs: AIError instances with a .code, friendly messages, redacted text.
 * Depends on: nothing (pure — must stay DOM-free and Storage-free).
 * ----------------------------------------------------------------------------
 */

export const AI_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'not_configured',          // no provider connected for this user/guest
  AUTH_INVALID: 'auth_invalid',              // provider rejected the key (401)
  AUTH_EXPIRED: 'auth_expired',              // provider says the credential expired/was revoked
  PERMISSION_DENIED: 'permission_denied',    // key valid but not allowed this model/action (403)
  RATE_LIMITED: 'rate_limited',              // 429 without a quota signal
  QUOTA_EXCEEDED: 'quota_exceeded',          // out of credits / balance / billing quota
  UNSUPPORTED_MODEL: 'unsupported_model',    // model not in our registry, or provider says it doesn't exist
  PROVIDER_UNAVAILABLE: 'provider_unavailable', // 5xx / 529 overloaded / 408
  BAD_REQUEST: 'bad_request',                // provider 400 for another reason
  BAD_RESPONSE: 'bad_response',              // empty or malformed provider response
  REFUSED: 'refused',                        // model declined the request (stop_reason refusal)
  NETWORK: 'network',                        // fetch failed (offline, DNS, CORS)
  TIMEOUT: 'timeout',
  INVALID_INPUT: 'invalid_input',            // our own validation (bad key format, oversized request)
  UNSUPPORTED_PROVIDER: 'unsupported_provider',
  NOT_CONNECTED: 'not_connected',            // account connection requested but none stored
  APP_AUTH_REQUIRED: 'app_auth_required',    // ai-proxy call without a valid app (Supabase) session
  GUEST_RESTRICTED: 'guest_restricted',      // the action is not available in a guest session
  PROXY_UNAVAILABLE: 'proxy_unavailable',    // ai-proxy Edge Function not deployed / unreachable
  SERVER_MISCONFIGURED: 'server_misconfigured', // e.g. encryption key secret missing
  USAGE_UNAVAILABLE: 'usage_unavailable',    // usage history could not be loaded
  OAUTH_STATE_MISMATCH: 'oauth_state_mismatch',
  OAUTH_FAILED: 'oauth_failed',
  UNKNOWN: 'unknown',
});

const C = AI_ERROR_CODES;

/** Codes that mean "the stored credential is no longer usable — ask the user to reconnect". @type {readonly string[]} */
export const CREDENTIAL_FAILURE_CODES = Object.freeze([C.AUTH_INVALID, C.AUTH_EXPIRED]);

/** Codes worth retrying later without changing anything. @type {readonly string[]} */
export const RETRYABLE_CODES = Object.freeze([C.RATE_LIMITED, C.PROVIDER_UNAVAILABLE, C.NETWORK, C.TIMEOUT]);

export class AIError extends Error {
  /**
   * @param {string} code one of AI_ERROR_CODES
   * @param {string} [message] user-facing text (defaults to messageFor(code))
   * @param {{status?:number, provider?:string, providerLabel?:string}} [meta] non-sensitive context only
   */
  constructor(code, message, meta = {}) {
    super(message || messageFor(code, meta.providerLabel));
    this.name = 'AIError';
    this.code = code;
    this.status = meta.status ?? null;
    this.provider = meta.provider ?? null;
    this.retryable = RETRYABLE_CODES.includes(code);
    this.needsReconnect = CREDENTIAL_FAILURE_CODES.includes(code);
  }
}

/** Friendly, secret-free message for each code. `who` is the provider's display name. */
export function messageFor(code, who = 'the AI provider') {
  switch (code) {
    case C.NOT_CONFIGURED: return 'No AI provider is connected yet. Connect one in Settings → AI Provider.';
    case C.AUTH_INVALID: return `${who} rejected the saved credentials. Reconnect it in Settings → AI Provider.`;
    case C.AUTH_EXPIRED: return `Your ${who} connection has expired or was revoked. Reconnect it in Settings → AI Provider.`;
    case C.PERMISSION_DENIED: return `Your ${who} account doesn't have access to this model. Choose another model in Settings.`;
    case C.RATE_LIMITED: return `${who} is rate-limiting requests right now. Wait a moment and try again, or switch models.`;
    case C.QUOTA_EXCEEDED: return `Your ${who} account is out of credits or quota. Check billing on the provider's website.`;
    case C.UNSUPPORTED_MODEL: return `That model isn't available from ${who}. Choose another model in Settings → AI Provider.`;
    case C.PROVIDER_UNAVAILABLE: return `${who} is temporarily unavailable. Please try again shortly.`;
    case C.BAD_REQUEST: return `${who} could not process this request. Try a shorter message or a different model.`;
    case C.BAD_RESPONSE: return 'The AI response was empty or malformed. Please try again.';
    case C.REFUSED: return 'The AI model declined to answer this request. Try rephrasing it.';
    case C.NETWORK: return `Network error reaching ${who}. Check your internet connection.`;
    case C.TIMEOUT: return 'The AI request timed out. Check your connection and try again.';
    case C.INVALID_INPUT: return 'Some of the AI settings are invalid. Check them and try again.';
    case C.UNSUPPORTED_PROVIDER: return 'That AI provider is not supported.';
    case C.NOT_CONNECTED: return 'This provider is not connected to your account. Connect it in Settings → AI Provider.';
    case C.APP_AUTH_REQUIRED: return 'Your sign-in session has ended. Sign in again to use AI features saved to your account.';
    case C.GUEST_RESTRICTED: return 'This option needs a signed-in account. Guests can keep a key for this browser session only.';
    case C.PROXY_UNAVAILABLE: return 'Secure account storage for AI keys is not available on this deployment. Keep the key on this device instead.';
    case C.SERVER_MISCONFIGURED: return 'The AI service is not fully configured on the server yet. Please contact the app administrator.';
    case C.USAGE_UNAVAILABLE: return 'AI usage history could not be loaded right now.';
    case C.OAUTH_STATE_MISMATCH: return 'The sign-in response did not match the request this app started, so it was ignored for your safety. Please try connecting again.';
    case C.OAUTH_FAILED: return `Connecting ${who} did not complete. Please try again.`;
    default: return 'Something went wrong with the AI request. Please try again.';
  }
}

/** Pulls the human-readable message + machine code out of the common provider error envelopes. */
function readErrorBody(body) {
  if (!body || typeof body !== 'object') return { message: typeof body === 'string' ? body : '', type: '' };
  const err = body.error;
  if (err && typeof err === 'object') {
    return { message: String(err.message || ''), type: String(err.code || err.type || '') };
  }
  return { message: String(body.message || (typeof err === 'string' ? err : '') || ''), type: String(body.type || body.code || '') };
}

const QUOTA_RE = /quota|billing|credit|balance|insufficient[_\s]?funds|payment|spend limit/i;
const EXPIRED_RE = /expired|revoked|disabled|deactivated/i;
const MODEL_RE = /model/i;
const MODEL_MISSING_RE = /not[_\s]found|does not exist|invalid model|not a valid model|unknown model|not supported|no endpoints|decommissioned|deprecated/i;

/**
 * Maps a provider HTTP failure to an AI_ERROR_CODES value. Works for every
 * provider in providers.js (OpenAI-compatible envelopes and Anthropic's
 * {type:"error", error:{type, message}}).
 */
export function classifyProviderError(status, body) {
  const { message, type } = readErrorBody(body);
  const text = `${type} ${message}`;
  if (status === 401) return EXPIRED_RE.test(text) ? C.AUTH_EXPIRED : C.AUTH_INVALID;
  if (status === 402) return C.QUOTA_EXCEEDED;
  if (status === 403) return QUOTA_RE.test(text) ? C.QUOTA_EXCEEDED : C.PERMISSION_DENIED;
  if (status === 404) return MODEL_RE.test(text) ? C.UNSUPPORTED_MODEL : C.BAD_REQUEST;
  if (status === 429) return /insufficient_quota/i.test(type) || QUOTA_RE.test(message) ? C.QUOTA_EXCEEDED : C.RATE_LIMITED;
  if (status === 400 || status === 422) {
    if (QUOTA_RE.test(text)) return C.QUOTA_EXCEEDED;
    if (MODEL_RE.test(text) && MODEL_MISSING_RE.test(text)) return C.UNSUPPORTED_MODEL;
    return C.BAD_REQUEST;
  }
  if (status === 408 || status === 529 || status >= 500) return C.PROVIDER_UNAVAILABLE;
  return C.UNKNOWN;
}

/** Builds the AIError for a failed provider HTTP response. Never includes the raw body. */
export function providerHttpError(status, body, provider) {
  const code = classifyProviderError(status, body);
  return new AIError(code, `${messageFor(code, provider?.label)} (HTTP ${status})`, { status, provider: provider?.id, providerLabel: provider?.label });
}

/** Turns anything thrown during fetch into an AIError (timeouts, network, unknown). */
export function toAIError(err, provider) {
  if (err instanceof AIError) return err;
  const meta = { provider: provider?.id, providerLabel: provider?.label };
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return new AIError(C.TIMEOUT, undefined, meta);
  if (err instanceof TypeError) return new AIError(C.NETWORK, undefined, meta);
  return new AIError(C.UNKNOWN, undefined, meta);
}

/**
 * Patterns for credentials that must never reach logs, URLs, analytics or
 * error messages: provider API keys (OpenAI sk-/sk-proj-, Anthropic
 * sk-ant-, OpenRouter sk-or-, Groq gsk_, Hugging Face hf_), bearer headers,
 * JWTs (Supabase access tokens) and OAuth code/verifier query parameters.
 */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bgsk_[A-Za-z0-9]{8,}/g,
  /\bhf_[A-Za-z0-9]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
const SECRET_QUERY_PARAM = /([?&](?:code|code_verifier|key|api_key|access_token|refresh_token)=)[^&#\s]+/gi;

/** Replaces anything that looks like a credential with "[redacted]". Use before logging. */
export function redactSecrets(value) {
  let text;
  if (typeof value === 'string') text = value;
  else { try { text = JSON.stringify(value); } catch { text = String(value); } }
  for (const re of SECRET_PATTERNS) text = text.replace(re, '[redacted]');
  return text.replace(SECRET_QUERY_PARAM, '$1[redacted]');
}
