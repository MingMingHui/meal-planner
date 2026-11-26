/**
 * The ai-proxy Edge Function's handler (supabase/functions/ai-proxy/handler.js),
 * run under Node with an in-memory database, fake auth and a fake provider.
 * Covers authorization, encrypted storage, provider/model routing, usage
 * recording, error handling and cross-user isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAIProxyHandler } from '../../supabase/functions/ai-proxy/handler.js';
import { importEncryptionKey, encryptCredential, decryptCredential, credentialAad } from '../../supabase/functions/ai-proxy/credentials.js';
import { AI_ERROR_CODES as C } from '../../js/ai/errors.js';

const SECRET = Buffer.alloc(32, 7).toString('base64');
const OPENAI_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';
const ANTHROPIC_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
const USERS = { 'tok-alice': { id: 'alice' }, 'tok-bob': { id: 'bob' }, 'tok-anon': { id: 'anon', isAnonymous: true } };

function memoryDb() {
  const connections = new Map(); // `${user}:${provider}` -> row
  const usage = [];
  return {
    connections, usage,
    async getConnection(u, p) { return connections.get(`${u}:${p}`) || null; },
    async upsertConnection(row) { const saved = { ...connections.get(`${row.user_id}:${row.provider}`), ...row, updated_at: '2026-11-23T00:00:00Z' }; connections.set(`${row.user_id}:${row.provider}`, saved); return saved; },
    async updateConnectionStatus(u, p, patch) { const k = `${u}:${p}`; if (connections.has(k)) connections.set(k, { ...connections.get(k), ...patch }); },
    async deleteConnection(u, p) { return connections.delete(`${u}:${p}`) ? 1 : 0; },
    async insertUsage(row) { usage.push(row); },
  };
}

const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let db; let providerFetch; let handler; let logs;
beforeEach(async () => {
  db = memoryDb();
  logs = [];
  providerFetch = vi.fn(async (url) => {
    if (url.endsWith('/models') || url.endsWith('/key')) return res(200, { data: [] });
    if (url.includes('anthropic')) return res(200, { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Claude says hi' }], usage: { input_tokens: 40, output_tokens: 12 } });
    return res(200, { model: 'gpt-4.1-mini', choices: [{ message: { content: 'GPT says hi' } }], usage: { prompt_tokens: 30, completion_tokens: 9 } });
  });
  const key = await importEncryptionKey(SECRET);
  handler = createAIProxyHandler({
    authenticate: async (req) => USERS[(req.headers.get('authorization') || '').replace('Bearer ', '')] || null,
    db,
    getEncryptionKey: async () => key,
    fetchImpl: providerFetch,
    log: (event, data) => logs.push(JSON.stringify({ event, ...data })),
  });
});

async function call(token, body) {
  const r = await handler(new Request('https://x.supabase.co/functions/v1/ai-proxy', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }));
  return { status: r.status, body: await r.json(), headers: r.headers };
}

const chat = (over = {}) => ({ action: 'chat', provider: 'openai', model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'Hi' }], feature: 'coach', ...over });

describe('authorization', () => {
  it('rejects calls without a valid app session', async () => {
    const r = await call(null, { action: 'save_key', provider: 'openai', apiKey: OPENAI_KEY });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe(C.APP_AUTH_REQUIRED);
    expect((await call('tok-forged', chat())).status).toBe(401);
  });

  it('anonymous (guest) sessions cannot store credentials server-side', async () => {
    const r = await call('tok-anon', { action: 'save_key', provider: 'openai', apiKey: OPENAI_KEY });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe(C.GUEST_RESTRICTED);
    expect(db.connections.size).toBe(0);
  });

  it('health needs no session and reports whether encryption is configured', async () => {
    expect((await call(null, { action: 'health' })).body).toEqual({ ok: true, encryptionConfigured: true });
  });

  it('rejects unknown actions and prototype keys', async () => {
    expect((await call('tok-alice', { action: 'constructor' })).status).toBe(400);
    expect((await call('tok-alice', { action: 'drop_tables' })).body.error.code).toBe(C.INVALID_INPUT);
  });
});

describe('provider connection', () => {
  it('verifies, encrypts and stores the key; only a hint ever comes back', async () => {
    const r = await call('tok-alice', { action: 'save_key', provider: 'openai', model: 'gpt-4.1-mini', apiKey: OPENAI_KEY });
    expect(r.status).toBe(200);
    expect(r.body.connection).toMatchObject({ provider: 'openai', authMethod: 'api_key', keyHint: '••••3456', status: 'active' });
    expect(JSON.stringify(r.body)).not.toContain(OPENAI_KEY);
    const row = db.connections.get('alice:openai');
    expect(row.credential_ciphertext).toMatch(/^v1:/);
    expect(row.credential_ciphertext).not.toContain(OPENAI_KEY);
    expect(providerFetch).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.anything());
    expect(logs.join('\n')).not.toContain(OPENAI_KEY);
  });

  it('does not store a key the provider rejects (invalid authentication)', async () => {
    providerFetch.mockResolvedValueOnce(res(401, { error: { message: 'Incorrect API key provided: sk-proj-abc***' } }));
    const r = await call('tok-alice', { action: 'save_key', provider: 'openai', apiKey: OPENAI_KEY });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe(C.AUTH_INVALID);
    expect(r.body.error.message).not.toContain('sk-proj');
    expect(db.connections.size).toBe(0);
  });

  it('rejects malformed keys and unsupported models before contacting the provider', async () => {
    expect((await call('tok-alice', { action: 'save_key', provider: 'anthropic', apiKey: OPENAI_KEY })).body.error.code).toBe(C.INVALID_INPUT);
    expect((await call('tok-alice', { action: 'save_key', provider: 'openai', model: 'gpt-99', apiKey: OPENAI_KEY })).body.error.code).toBe(C.UNSUPPORTED_MODEL);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('fails clearly when the encryption secret is not configured', async () => {
    const h = createAIProxyHandler({ authenticate: async () => ({ id: 'alice' }), db, getEncryptionKey: async () => null, fetchImpl: providerFetch });
    const r = await h(new Request('https://x/ai-proxy', { method: 'POST', body: JSON.stringify({ action: 'save_key', provider: 'openai', apiKey: OPENAI_KEY }) }));
    expect(r.status).toBe(503);
    expect((await r.json()).error.code).toBe(C.SERVER_MISCONFIGURED);
    expect(db.connections.size).toBe(0);
  });

  it('disconnect deletes only the caller\'s own connection', async () => {
    await call('tok-alice', { action: 'save_key', provider: 'openai', apiKey: OPENAI_KEY });
    await call('tok-bob', { action: 'save_key', provider: 'openai', apiKey: OPENAI_KEY });
    expect((await call('tok-bob', { action: 'disconnect', provider: 'openai' })).body).toEqual({ disconnected: true });
    expect(db.connections.has('alice:openai')).toBe(true);
    expect(db.connections.has('bob:openai')).toBe(false);
    expect((await call('tok-bob', chat())).body.error.code).toBe(C.NOT_CONNECTED);
  });

  it('OpenRouter OAuth: exchanges code + verifier server-side and stores the issued key', async () => {
    providerFetch.mockImplementationOnce(async (url, init) => {
      expect(url).toBe('https://openrouter.ai/api/v1/auth/keys');
      expect(JSON.parse(init.body)).toMatchObject({ code: 'abc', code_verifier: 'v'.repeat(43), code_challenge_method: 'S256' });
      return res(200, { key: 'sk-or-v1-issuedkeyabcdefghijklmnop' });
    });
    const r = await call('tok-alice', { action: 'oauth_exchange', provider: 'openrouter', code: 'abc', codeVerifier: 'v'.repeat(43) });
    expect(r.body.connection).toMatchObject({ provider: 'openrouter', authMethod: 'oauth_pkce', keyHint: '••••mnop' });
    expect(JSON.stringify(r.body)).not.toContain('issuedkey');
    // OAuth is not offered for providers that don't support it
    expect((await call('tok-alice', { action: 'oauth_exchange', provider: 'openai', code: 'abc', codeVerifier: 'v'.repeat(43) })).body.error.code).toBe(C.UNSUPPORTED_PROVIDER);
  });
});

describe('chat through the proxy', () => {
  beforeEach(async () => {
    await call('tok-alice', { action: 'save_key', provider: 'openai', apiKey: OPENAI_KEY });
    await call('tok-alice', { action: 'save_key', provider: 'anthropic', apiKey: ANTHROPIC_KEY });
    providerFetch.mockClear();
  });

  it('routes to the selected provider and model with the decrypted key', async () => {
    const r = await call('tok-alice', chat({ provider: 'anthropic', model: 'claude-sonnet-5-5' }));
    expect(r.status).toBe(200);
    expect(r.body.text).toBe('Claude says hi');
    const [url, init] = providerFetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe(ANTHROPIC_KEY);
    expect(init.headers['anthropic-dangerous-direct-browser-access']).toBeUndefined();
    expect(JSON.parse(init.body).model).toBe('claude-sonnet-5-5');
  });

  it('records server usage with provider-reported tokens, bound to the caller, without prompt text', async () => {
    const r = await call('tok-alice', chat({ messages: [{ role: 'user', content: 'my private health question' }] }));
    expect(r.body.usageRecorded).toBe(true);
    expect(db.usage).toHaveLength(1);
    expect(db.usage[0]).toMatchObject({ user_id: 'alice', provider: 'openai', model: 'gpt-4.1-mini', input_tokens: 30, output_tokens: 9, token_source: 'provider', recorded_by: 'server', status: 'success', feature: 'coach' });
    expect(JSON.stringify(db.usage)).not.toContain('private health');
    expect(r.body.usage.totalTokens).toBe(39);
  });

  it('ignores any user id in the request body — another user cannot use Alice\'s credential', async () => {
    const r = await call('tok-bob', { ...chat(), user_id: 'alice', userId: 'alice' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe(C.NOT_CONNECTED);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('a credential copied to another user\'s row cannot be decrypted (bound by AAD)', async () => {
    db.connections.set('bob:openai', { ...db.connections.get('alice:openai'), user_id: 'bob' });
    const r = await call('tok-bob', chat());
    expect(r.body.error.code).toBe(C.AUTH_INVALID);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(db.connections.get('bob:openai').status).toBe('invalid');
  });

  it('expired provider credentials mark the connection and block further calls until reconnected', async () => {
    providerFetch.mockResolvedValueOnce(res(401, { error: { message: 'API key expired' } }));
    const r = await call('tok-alice', chat());
    expect(r.body.error.code).toBe(C.AUTH_EXPIRED);
    expect(db.connections.get('alice:openai')).toMatchObject({ status: 'expired', last_error_code: C.AUTH_EXPIRED });
    expect(db.usage.at(-1)).toMatchObject({ status: 'error', error_code: C.AUTH_EXPIRED, input_tokens: 0 });
    providerFetch.mockClear();
    expect((await call('tok-alice', chat())).body.error.code).toBe(C.AUTH_EXPIRED);
    expect(providerFetch).not.toHaveBeenCalled();
    // reconnecting resets the status
    await call('tok-alice', { action: 'save_key', provider: 'openai', apiKey: OPENAI_KEY });
    expect(db.connections.get('alice:openai').status).toBe('active');
  });

  it('maps rate limits, quota and outages to codes and HTTP statuses', async () => {
    providerFetch.mockResolvedValueOnce(res(429, { error: { code: 'rate_limit_exceeded', message: 'slow' } }));
    let r = await call('tok-alice', chat());
    expect([r.status, r.body.error.code]).toEqual([429, C.RATE_LIMITED]);
    providerFetch.mockResolvedValueOnce(res(429, { error: { code: 'insufficient_quota', message: 'quota' } }));
    r = await call('tok-alice', chat());
    expect(r.body.error.code).toBe(C.QUOTA_EXCEEDED);
    providerFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    r = await call('tok-alice', chat());
    expect([r.status, r.body.error.code]).toEqual([502, C.NETWORK]);
    expect(db.connections.get('alice:openai').status).toBe('active'); // not a credential problem
  });

  it('rejects unsupported models and oversize requests without calling the provider', async () => {
    expect((await call('tok-alice', chat({ model: 'gpt-5-pro-max' }))).body.error.code).toBe(C.UNSUPPORTED_MODEL);
    expect((await call('tok-alice', chat({ messages: Array(41).fill({ role: 'user', content: 'x' }) }))).body.error.code).toBe(C.INVALID_INPUT);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('still answers if usage recording fails, and says so', async () => {
    db.insertUsage = async () => { throw new Error('db down'); };
    const r = await call('tok-alice', chat());
    expect(r.body).toMatchObject({ text: 'GPT says hi', usageRecorded: false });
  });
});

describe('CORS', () => {
  it('answers preflight and restricts origins when configured', async () => {
    const h = createAIProxyHandler({ authenticate: async () => null, db, getEncryptionKey: async () => null, allowedOrigins: ['https://app.example'] });
    const pre = await h(new Request('https://x/ai-proxy', { method: 'OPTIONS', headers: { origin: 'https://app.example' } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://app.example');
    const other = await h(new Request('https://x/ai-proxy', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('credential encryption', () => {
  it('round-trips, uses a fresh IV each time, and fails with the wrong owner binding', async () => {
    const key = await importEncryptionKey(SECRET);
    const a = await encryptCredential(key, OPENAI_KEY, credentialAad('alice', 'openai'));
    const b = await encryptCredential(key, OPENAI_KEY, credentialAad('alice', 'openai'));
    expect(a).not.toBe(b);
    expect(await decryptCredential(key, a, credentialAad('alice', 'openai'))).toBe(OPENAI_KEY);
    await expect(decryptCredential(key, a, credentialAad('bob', 'openai'))).rejects.toThrow();
    await expect(decryptCredential(key, a, credentialAad('alice', 'anthropic'))).rejects.toThrow();
  });
  it('refuses secrets that are not 32 bytes', async () => {
    expect(await importEncryptionKey('')).toBeNull();
    expect(await importEncryptionKey(Buffer.alloc(16).toString('base64'))).toBeNull();
  });
});
