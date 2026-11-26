/**
 * The shared AI core (js/ai/*): provider registry, AIProvider adapters, error
 * classification and validation. The web app, the Android app and the
 * ai-proxy Edge Function all run this exact code.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  PROVIDERS, getProvider, getAdapter, resolveModel, validateConnectionInput, validateChatRequest,
  keyHint, supportsAuthMethod, AUTH_METHODS, CHAT_LIMITS,
} from '../../js/ai/providers.js';
import { classifyProviderError, AIError, AI_ERROR_CODES as C, redactSecrets, providerHttpError } from '../../js/ai/errors.js';
import { runProviderChat, verifyProviderKey } from '../../js/ai/chat.js';
import { getAIEntitlements, ownerIdFor } from '../../js/ai/policy.js';

const KEYS = {
  openai: 'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
  anthropic: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
  openrouter: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz',
  groq: 'gsk_abcdefghijklmnopqrstuvwxyz',
};
const msgs = [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }];
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

describe('provider registry', () => {
  it('includes OpenAI, Anthropic and the existing open-model providers, each with a valid default model', () => {
    for (const id of ['openai', 'anthropic', 'openrouter', 'groq', 'together', 'huggingface']) {
      const p = getProvider(id);
      expect(p, id).toBeTruthy();
      expect(p.models.some(m => m.id === p.defaultModel), id).toBe(true);
      expect(getAdapter(p), id).toBeTruthy();
    }
    expect(getProvider('__proto__')).toBeNull();
    expect(getProvider('nope')).toBeNull();
  });

  it('only OpenRouter offers OAuth; OpenAI and Anthropic use their official API-key flow', () => {
    expect(supportsAuthMethod('openrouter', AUTH_METHODS.OAUTH_PKCE)).toBe(true);
    expect(supportsAuthMethod('openai', AUTH_METHODS.OAUTH_PKCE)).toBe(false);
    expect(supportsAuthMethod('anthropic', AUTH_METHODS.OAUTH_PKCE)).toBe(false);
    expect(PROVIDERS.anthropic.authMethods).toEqual([AUTH_METHODS.API_KEY]);
  });

  it('resolves unknown models to the provider default', () => {
    expect(resolveModel('anthropic', 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(resolveModel('anthropic', 'gpt-4.1-mini')).toBe(PROVIDERS.anthropic.defaultModel);
  });

  it('key hints never reveal more than the last 4 characters', () => {
    expect(keyHint(KEYS.openai)).toBe('••••3456');
    expect(keyHint('short')).toBe('••••');
  });
});

describe('validation (same rules on client and server)', () => {
  it('accepts a well-formed key and rejects wrong-provider keys, whitespace, unsupported models', () => {
    expect(validateConnectionInput({ provider: 'openai', model: 'gpt-4.1-mini', apiKey: ` ${KEYS.openai} ` }).apiKey).toBe(KEYS.openai);
    expect(() => validateConnectionInput({ provider: 'anthropic', apiKey: KEYS.openai })).toThrow(/doesn't look like/);
    expect(() => validateConnectionInput({ provider: 'openai', apiKey: 'sk-abc def' })).toThrow(AIError);
    expect(() => validateConnectionInput({ provider: 'openai', apiKey: '' })).toThrow(/Enter an API key/);
    try { validateConnectionInput({ provider: 'openai', model: 'gpt-99', apiKey: KEYS.openai }); }
    catch (e) { expect(e.code).toBe(C.UNSUPPORTED_MODEL); }
    try { validateConnectionInput({ provider: 'evil', apiKey: KEYS.openai }); }
    catch (e) { expect(e.code).toBe(C.UNSUPPORTED_PROVIDER); }
  });

  it('chat requests: unsupported model, bad roles, oversize input rejected; maxTokens clamped', () => {
    const ok = validateChatRequest({ provider: 'openai', model: 'gpt-4.1-mini', messages: msgs, maxTokens: 99999, feature: 'coach' });
    expect(ok.maxTokens).toBe(CHAT_LIMITS.maxTokens);
    expect(ok.feature).toBe('coach');
    expect(validateChatRequest({ provider: 'openai', model: 'gpt-4.1-mini', messages: msgs, feature: 'hack' }).feature).toBe('other');
    const bad = (req) => { try { validateChatRequest(req); return null; } catch (e) { return e.code; } };
    expect(bad({ provider: 'openai', model: 'claude-opus-5-5', messages: msgs })).toBe(C.UNSUPPORTED_MODEL);
    expect(bad({ provider: 'openai', model: 'gpt-4.1-mini', messages: [{ role: 'tool', content: 'x' }] })).toBe(C.INVALID_INPUT);
    expect(bad({ provider: 'openai', model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'x'.repeat(CHAT_LIMITS.maxMessageChars + 1) }] })).toBe(C.INVALID_INPUT);
    expect(bad({ provider: 'openai', model: 'gpt-4.1-mini', messages: [] })).toBe(C.INVALID_INPUT);
    expect(bad({ provider: 'openai', model: 'gpt-4.1-mini', messages: msgs, temperature: 5 })).toBe(C.INVALID_INPUT);
  });
});

describe('AIProvider adapters', () => {
  it('OpenAI: bearer auth, max_completion_tokens, model + temperature passed through', () => {
    const { url, init } = getAdapter('openai').buildChatRequest({ provider: PROVIDERS.openai, model: 'gpt-4.1-mini', apiKey: KEYS.openai, messages: msgs, temperature: 0.6, maxTokens: 500 });
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe(`Bearer ${KEYS.openai}`);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: 'gpt-4.1-mini', temperature: 0.6, max_completion_tokens: 500 });
    expect(body.max_tokens).toBeUndefined();
  });

  it('OpenRouter asks for provider-reported cost; Groq uses max_tokens', () => {
    const or = JSON.parse(getAdapter('openrouter').buildChatRequest({ provider: PROVIDERS.openrouter, model: PROVIDERS.openrouter.defaultModel, apiKey: KEYS.openrouter, messages: msgs, temperature: 0.7, maxTokens: 10 }).init.body);
    expect(or.usage).toEqual({ include: true });
    const gq = JSON.parse(getAdapter('groq').buildChatRequest({ provider: PROVIDERS.groq, model: 'llama-3.1-8b-instant', apiKey: KEYS.groq, messages: msgs, temperature: 0.7, maxTokens: 10 }).init.body);
    expect(gq.max_tokens).toBe(10);
  });

  it('Anthropic: x-api-key + version headers, system top-level, no temperature, browser opt-in header only in the browser', () => {
    const history = [{ role: 'system', content: 'Sys' }, { role: 'assistant', content: 'orphan' }, { role: 'user', content: 'Q' }];
    const browser = getAdapter('anthropic').buildChatRequest({ provider: PROVIDERS.anthropic, model: 'claude-haiku-5-5', apiKey: KEYS.anthropic, messages: history, temperature: 0.6, maxTokens: 500, context: 'browser' });
    expect(browser.url).toBe('https://api.anthropic.com/v1/messages');
    expect(browser.init.headers['x-api-key']).toBe(KEYS.anthropic);
    expect(browser.init.headers['anthropic-version']).toBe('2023-06-01');
    expect(browser.init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(browser.init.headers.Authorization).toBeUndefined();
    const body = JSON.parse(browser.init.body);
    expect(body.system).toBe('Sys');
    expect(body.messages).toEqual([{ role: 'user', content: 'Q' }]); // must start with a user turn
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBe(PROVIDERS.anthropic.maxTokensFloor);
    expect(body.output_config).toEqual({ effort: 'low' });

    const server = getAdapter('anthropic').buildChatRequest({ provider: PROVIDERS.anthropic, model: 'claude-opus-5-5', apiKey: KEYS.anthropic, messages: msgs, maxTokens: 500, context: 'server' });
    expect(server.init.headers['anthropic-dangerous-direct-browser-access']).toBeUndefined();
    expect(server.init.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(JSON.parse(server.init.body).fallbacks).toBe('default');
  });

  it('parses provider-reported usage (OpenAI-compatible and Anthropic incl. cache tokens)', () => {
    const oa = getAdapter('openrouter').parseChatResponse({ model: 'x', choices: [{ message: { content: ' Hello ' } }], usage: { prompt_tokens: 12, completion_tokens: 5, cost: 0.0001 } }, { model: 'x' });
    expect(oa).toMatchObject({ text: 'Hello', usage: { inputTokens: 12, outputTokens: 5, providerCostUsd: 0.0001 } });
    const an = getAdapter('anthropic').parseChatResponse({
      model: 'claude-opus-5-5',
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Hi ' }, { type: 'text', text: 'there' }],
      usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 1, output_tokens: 7 },
    }, { model: 'claude-opus-5-5' });
    expect(an).toMatchObject({ text: 'Hi there', usage: { inputTokens: 15, outputTokens: 7, providerCostUsd: null } });
    expect(() => getAdapter('anthropic').parseChatResponse({ stop_reason: 'refusal', content: [] }, {})).toThrow(expect.objectContaining({ code: C.REFUSED }));
  });
});

describe('provider error classification', () => {
  it.each([
    [401, { error: { message: 'Incorrect API key provided' } }, C.AUTH_INVALID],
    [401, { error: { message: 'API key expired' } }, C.AUTH_EXPIRED],
    [401, { type: 'error', error: { type: 'authentication_error', message: 'This key has been revoked' } }, C.AUTH_EXPIRED],
    [402, { error: { message: 'Insufficient credits' } }, C.QUOTA_EXCEEDED],
    [403, { error: { type: 'permission_error', message: 'not allowed' } }, C.PERMISSION_DENIED],
    [429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }, C.QUOTA_EXCEEDED],
    [429, { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' } }, C.RATE_LIMITED],
    [400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }, C.QUOTA_EXCEEDED],
    [404, { error: { code: 'model_not_found', message: 'The model does not exist' } }, C.UNSUPPORTED_MODEL],
    [400, { error: { message: 'invalid model ID' } }, C.UNSUPPORTED_MODEL],
    [400, { error: { message: 'messages: field required' } }, C.BAD_REQUEST],
    [529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, C.PROVIDER_UNAVAILABLE],
    [503, null, C.PROVIDER_UNAVAILABLE],
  ])('HTTP %i %j -> %s', (status, body, code) => {
    expect(classifyProviderError(status, body)).toBe(code);
  });

  it('error messages never include the provider body, which can echo request content', () => {
    const err = providerHttpError(400, { error: { message: `bad request containing ${KEYS.openai} and my medical notes` } }, PROVIDERS.openai);
    expect(err.message).not.toContain('sk-proj');
    expect(err.message).not.toContain('medical');
    expect(err.message).toContain('HTTP 400');
  });

  it('redactSecrets strips provider keys, bearer tokens, JWTs and OAuth codes', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
    const s = redactSecrets(`k=${KEYS.anthropic} ${KEYS.openrouter} ${KEYS.groq} hf_abcdefghijklmnopqrst Bearer abc.def.ghi12345 ${jwt} https://x/cb?ai_oauth=openrouter&code=SECRET123&state=s`);
    for (const secret of [KEYS.anthropic, KEYS.openrouter, KEYS.groq, 'hf_abc', 'abc.def.ghi12345', jwt, 'SECRET123']) expect(s).not.toContain(secret);
    expect(s).toContain('state=s');
  });
});

describe('runProviderChat / verifyProviderKey', () => {
  it('sends the request for the selected provider + model and returns text and usage', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(200, { model: 'gpt-4.1-mini', choices: [{ message: { content: 'Eat greens.' } }], usage: { prompt_tokens: 20, completion_tokens: 4 } })));
    const r = await runProviderChat({ provider: 'openai', model: 'gpt-4.1-mini', apiKey: KEYS.openai, messages: msgs, temperature: 0.5, maxTokens: 100, context: 'browser', fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe(PROVIDERS.openai.endpoint);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model).toBe('gpt-4.1-mini');
    expect(r).toMatchObject({ text: 'Eat greens.', usage: { inputTokens: 20, outputTokens: 4 } });
  });

  it('maps provider failures, network errors, timeouts and empty replies to AIError codes', async () => {
    const run = (fetchImpl, timeoutMs) => runProviderChat({ provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: KEYS.anthropic, messages: msgs, temperature: 0.7, maxTokens: 10, fetchImpl, timeoutMs }).catch(e => e);
    expect((await run(() => Promise.resolve(jsonResponse(401, { error: { message: 'invalid x-api-key' } })))).code).toBe(C.AUTH_INVALID);
    expect((await run(() => Promise.resolve(jsonResponse(429, { error: { type: 'rate_limit_error', message: 'slow down' } })))).code).toBe(C.RATE_LIMITED);
    expect((await run(() => Promise.reject(new TypeError('Failed to fetch')))).code).toBe(C.NETWORK);
    expect((await run(() => Promise.resolve(jsonResponse(200, { content: [] })))).code).toBe(C.BAD_RESPONSE);
    const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    expect((await run(hang, 20)).code).toBe(C.TIMEOUT);
  });

  it('verifies keys with an authenticated GET and reports invalid ones', async () => {
    const ok = vi.fn(() => Promise.resolve(jsonResponse(200, {})));
    await expect(verifyProviderKey({ provider: 'openrouter', apiKey: KEYS.openrouter, fetchImpl: ok })).resolves.toBe(true);
    expect(ok.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/key');
    expect(ok.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${KEYS.openrouter}`);
    const bad = () => Promise.resolve(jsonResponse(401, { error: { message: 'Invalid API key' } }));
    await expect(verifyProviderKey({ provider: 'anthropic', apiKey: KEYS.anthropic, fetchImpl: bad })).rejects.toMatchObject({ code: C.AUTH_INVALID, needsReconnect: true });
  });
});

describe('entitlements and guest rules', () => {
  it('guests: session storage only, no account storage, usage kept in the session', () => {
    const e = getAIEntitlements({ isGuest: true, cloudConfigured: true, proxyAvailable: true });
    expect(e.credentialStores).toEqual(['session']);
    expect(e.accountStorageReason).toBe('guest');
    expect(e.usageHistory).toBe('session');
    expect(e.canSyncUsageToCloud).toBe(false);
  });

  it('signed-in users get account storage only when ai-proxy is available', () => {
    expect(getAIEntitlements({ isGuest: false, cloudConfigured: true, proxyAvailable: true }).credentialStores).toEqual(['account', 'device']);
    const down = getAIEntitlements({ isGuest: false, cloudConfigured: true, proxyAvailable: false });
    expect(down.credentialStores).toEqual(['device']);
    expect(down.accountStorageReason).toBe('proxy_unavailable');
  });

  it('OAuth is offered on the web but not in the Android app (no https callback there)', () => {
    expect(getAIEntitlements({ isGuest: false }).authMethodsFor('openrouter')).toContain('oauth_pkce');
    expect(getAIEntitlements({ isGuest: false, isNative: true }).authMethodsFor('openrouter')).toEqual(['api_key']);
  });

  it('owner ids keep guests and users apart', () => {
    expect(ownerIdFor(null)).toBe('guest');
    expect(ownerIdFor({ id: 'u1' })).toBe('user:u1');
  });
});
