// @vitest-environment jsdom
/**
 * The app-side AI flow in the shared web code (js/ai.js, aiConnections.js,
 * aiUsage.js, storage.js) — the same files the Android app packages.
 * Supabase and provider HTTP are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AI_ERROR_CODES as C } from '../../js/ai/errors.js';

const OPENAI_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';
const ANTHROPIC_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';

/** Minimal chainable stand-in for supabase-js's query builder. */
function queryBuilder(result, calls) {
  const q = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'gte', 'lte', 'delete']) q[m] = vi.fn((...a) => { calls.push([m, ...a]); return q; });
  q.insert = vi.fn((row) => { calls.push(['insert', row]); return Promise.resolve({ error: null }); });
  q.then = (resolve) => resolve(result());
  return q;
}

function mockSupabase({ user = null, invoke, tables = {} } = {}) {
  const calls = [];
  const client = {
    auth: {
      getSession: vi.fn(() => Promise.resolve({ data: { session: user ? { user } : null }, error: null })),
      onAuthStateChange: vi.fn(),
    },
    functions: { invoke: invoke || vi.fn(() => Promise.resolve({ data: { ok: true, encryptionConfigured: true }, error: null })) },
    from: vi.fn((table) => { calls.push(['from', table]); return queryBuilder(() => ({ data: tables[table] || [], error: null }), calls); }),
  };
  window.supabase = { createClient: vi.fn(() => client) };
  return { client, calls };
}

async function boot({ guest = false } = {}) {
  vi.resetModules();
  const auth = await import('../../js/auth.js');
  await auth.initializeAuth();
  const Storage = (await import('../../js/storage.js')).default;
  if (guest) Storage.enterGuestSession();
  return {
    auth, Storage,
    conn: await import('../../js/aiConnections.js'),
    ai: await import('../../js/ai.js'),
    usage: await import('../../js/aiUsage.js'),
  };
}

const okOpenAI = (text = 'Hi from GPT') => ({ ok: true, status: 200, json: () => Promise.resolve({ model: 'gpt-4.1-mini', choices: [{ message: { content: text } }], usage: { prompt_tokens: 21, completion_tokens: 6 } }) });

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  delete window.HMPANative;
});
afterEach(() => { delete window.supabase; vi.unstubAllGlobals(); });

describe('guest', () => {
  it('can connect a key for this session, chat with the selected provider/model, and see usage', async () => {
    mockSupabase();
    const fetchMock = vi.fn((url) => Promise.resolve(url.endsWith('/models') ? { ok: true, status: 200, json: () => Promise.resolve({}) } : okOpenAI()));
    vi.stubGlobal('fetch', fetchMock);
    const { conn, ai, usage } = await boot({ guest: true });

    expect(ai.hasAPIKey()).toBe(false);
    await expect(ai.chatComplete([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({ code: C.NOT_CONFIGURED });

    const { verified } = await conn.connectWithApiKey({ provider: 'openai', model: 'gpt-4.1-nano', apiKey: OPENAI_KEY, store: 'session' });
    expect(verified).toBe(true);
    expect(conn.getActiveConnection()).toMatchObject({ provider: 'openai', model: 'gpt-4.1-nano', store: 'session', configured: true, keyHint: '••••3456' });
    // Guest data (including the key) lives in sessionStorage only.
    expect(window.localStorage.getItem('hmpa:settings')).toBeNull();
    expect(window.sessionStorage.getItem('hmpa:settings')).toContain('sk-proj');

    const reply = await ai.coachReply('What should I eat?', {}, []);
    expect(reply).toBe('Hi from GPT');
    const [url, init] = fetchMock.mock.calls.at(-1);
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.parse(init.body).model).toBe('gpt-4.1-nano');

    const { records, scope } = await usage.listUsage();
    expect(scope).toBe('session');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ provider: 'openai', inputTokens: 21, outputTokens: 6, totalTokens: 27, tokenSource: 'provider', recordedBy: 'client', feature: 'coach' });
  });

  it('cannot use account storage', async () => {
    mockSupabase();
    const { conn } = await boot({ guest: true });
    await expect(conn.connectWithApiKey({ provider: 'openai', apiKey: OPENAI_KEY, store: 'account' })).rejects.toMatchObject({ code: C.GUEST_RESTRICTED });
    expect(conn.getEntitlements().credentialStores).toEqual(['session']);
  });

  it('a guest\'s key and usage do not follow them into an account on sign-in', async () => {
    mockSupabase();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okOpenAI())));
    const { conn, ai, Storage } = await boot({ guest: true });
    await conn.connectWithApiKey({ provider: 'openai', apiKey: OPENAI_KEY, store: 'session' });
    await ai.chatComplete([{ role: 'user', content: 'hi' }]);
    Storage.saveProfile({ name: 'Guest', weight: 60 });

    Storage.claimGuestSessionForAccount();
    expect(JSON.parse(window.localStorage.getItem('hmpa:profile')).name).toBe('Guest'); // existing behaviour kept
    expect(Storage.getSettings().apiKey).toBe('');
    expect(window.localStorage.getItem('hmpa:aiUsage')).toBeNull();
    expect(window.sessionStorage.getItem('hmpa:aiUsage')).toBeNull();
  });

  it('invalid key: rejected by the provider, not saved', async () => {
    mockSupabase();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: { message: 'Incorrect API key' } }) })));
    const { conn } = await boot({ guest: true });
    await expect(conn.connectWithApiKey({ provider: 'openai', apiKey: OPENAI_KEY, store: 'session' })).rejects.toMatchObject({ code: C.AUTH_INVALID });
    expect(conn.getActiveConnection().connected).toBe(false);
  });
});

describe('signed-in user, key on this device', () => {
  it('device keys are bound to their owner and provider', async () => {
    mockSupabase({ user: { id: 'alice' } });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })));
    let env = await boot();
    await env.conn.connectWithApiKey({ provider: 'anthropic', apiKey: ANTHROPIC_KEY, store: 'device' });
    expect(env.conn.getActiveConnection()).toMatchObject({ provider: 'anthropic', store: 'device', configured: true });

    // Switching provider never sends the Anthropic key to OpenAI.
    env.conn.selectProviderModel({ provider: 'openai', model: 'gpt-4.1-mini' });
    expect(env.ai.hasAPIKey()).toBe(false);
    env.conn.selectProviderModel({ provider: 'anthropic' });
    expect(env.ai.hasAPIKey()).toBe(true);

    // Another user signing in on this device does not get Alice's key.
    mockSupabase({ user: { id: 'bob' } });
    env = await boot();
    expect(env.ai.hasAPIKey()).toBe(false);
    expect(env.conn.getDeviceApiKey('anthropic')).toBeNull();
  });

  it('records client usage to the account table and marks expired credentials', async () => {
    const { calls } = mockSupabase({ user: { id: 'alice' } });
    const fetchMock = vi.fn(() => Promise.resolve(okOpenAI('ok')));
    vi.stubGlobal('fetch', fetchMock);
    const { conn, ai } = await boot();
    await conn.connectWithApiKey({ provider: 'openai', apiKey: OPENAI_KEY, store: 'device' });
    await ai.chatComplete([{ role: 'user', content: 'hi' }], { feature: 'recipe' });
    const insert = calls.find(c => c[0] === 'insert');
    expect(insert[1]).toMatchObject({ user_id: 'alice', provider: 'openai', recorded_by: 'client', input_tokens: 21, output_tokens: 6, feature: 'recipe' });
    expect(insert[1]).not.toHaveProperty('total_tokens');

    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({ error: { message: 'key expired' } }) });
    const err = await ai.chatComplete([{ role: 'user', content: 'hi' }]).catch(e => e);
    expect(err).toMatchObject({ code: C.AUTH_EXPIRED, needsReconnect: true });
    expect(err.message).not.toContain('sk-proj');
    expect(conn.getActiveConnection().status).toBe('expired');
  });

  it('disconnect removes the device credential', async () => {
    mockSupabase({ user: { id: 'alice' } });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })));
    const { conn, Storage } = await boot();
    await conn.connectWithApiKey({ provider: 'openai', apiKey: OPENAI_KEY, store: 'device' });
    await conn.disconnectProvider('openai', 'device');
    expect(Storage.getSettings().apiKey).toBe('');
    expect(conn.isAIConfigured()).toBe(false);
  });

  it('the device key is never exported or synced', async () => {
    mockSupabase({ user: { id: 'alice' } });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })));
    const { conn, Storage } = await boot();
    await conn.connectWithApiKey({ provider: 'openai', apiKey: OPENAI_KEY, store: 'device' });
    const exported = JSON.stringify(Storage.exportAll());
    expect(exported).not.toContain('sk-proj');
    expect(exported).not.toContain('aiKeyOwner');
  });
});

describe('signed-in user, key saved to the account (ai-proxy)', () => {
  it('connects through ai-proxy, chats through ai-proxy, and never holds the key', async () => {
    const invoke = vi.fn((_fn, { body }) => {
      if (body.action === 'health') return Promise.resolve({ data: { ok: true, encryptionConfigured: true }, error: null });
      if (body.action === 'save_key') return Promise.resolve({ data: { connection: { provider: body.provider, authMethod: 'api_key', model: body.model, keyHint: '••••wxyz', status: 'active' } }, error: null });
      if (body.action === 'chat') return Promise.resolve({ data: { text: 'from proxy', usage: { totalTokens: 9 } }, error: null });
      return Promise.resolve({ data: null, error: new Error('unexpected') });
    });
    mockSupabase({ user: { id: 'alice' }, invoke });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { conn, ai, Storage } = await boot();

    expect(await conn.checkProxyHealth()).toBe(true);
    expect(conn.getEntitlements().credentialStores).toEqual(['account', 'device']);
    await conn.connectWithApiKey({ provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: ANTHROPIC_KEY, store: 'account' });
    expect(conn.getActiveConnection()).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', store: 'account', configured: true, keyHint: '••••wxyz' });
    expect(JSON.stringify(window.localStorage)).not.toContain('sk-ant');

    expect(await ai.chatComplete([{ role: 'user', content: 'hi' }], { feature: 'coach' })).toBe('from proxy');
    const chatBody = invoke.mock.calls.find(c => c[1].body.action === 'chat')[1].body;
    expect(chatBody).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', feature: 'coach' });
    expect(chatBody).not.toHaveProperty('apiKey');
    expect(fetchMock).not.toHaveBeenCalled(); // no direct provider call from the browser
    expect(Storage.getAIUsage()).toEqual([]); // usage was recorded server-side
  });

  it('when ai-proxy is not deployed, account storage is unavailable and the app explains why', async () => {
    const invoke = vi.fn(() => Promise.resolve({ data: null, error: Object.assign(new Error('Failed to send a request'), { name: 'FunctionsFetchError' }) }));
    mockSupabase({ user: { id: 'alice' }, invoke });
    const { conn } = await boot();
    expect(await conn.checkProxyHealth()).toBe(false);
    expect(conn.getEntitlements()).toMatchObject({ credentialStores: ['device'], accountStorageReason: 'proxy_unavailable' });
    await expect(conn.connectWithApiKey({ provider: 'openai', apiKey: OPENAI_KEY, store: 'account' })).rejects.toMatchObject({ code: C.PROXY_UNAVAILABLE });
  });

  it('surfaces the server\'s error code (e.g. rate limit) with a safe message', async () => {
    const response = new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'Slow down please.' } }), { status: 429 });
    const invoke = vi.fn((_fn, { body }) => body.action === 'chat'
      ? Promise.resolve({ data: null, error: Object.assign(new Error('non-2xx'), { context: response }) })
      : Promise.resolve({ data: { ok: true, encryptionConfigured: true }, error: null }));
    mockSupabase({ user: { id: 'alice' }, invoke });
    const { conn, ai, Storage } = await boot();
    Storage.saveAIConnectionCache({ ownerId: 'user:alice', connections: [{ provider: 'openai', status: 'active', keyHint: '••••1234' }] });
    conn.selectProviderModel({ provider: 'openai', model: 'gpt-4.1-mini', store: 'account' });
    await expect(ai.chatComplete([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({ code: C.RATE_LIMITED, message: 'Slow down please.', retryable: true });
  });

  it('another user\'s cached account connections are ignored', async () => {
    mockSupabase({ user: { id: 'bob' } });
    const { conn, Storage } = await boot();
    Storage.saveAIConnectionCache({ ownerId: 'user:alice', connections: [{ provider: 'openai', status: 'active' }] });
    conn.selectProviderModel({ provider: 'openai', store: 'account' });
    expect(conn.isAIConfigured()).toBe(false);
  });

  it('usage list shows only this user\'s rows: cloud rows plus their own pending local rows', async () => {
    const { calls } = mockSupabase({ user: { id: 'alice' }, tables: { ai_usage_records: [
      { id: 'c1', provider: 'openai', model: 'gpt-4.1-mini', feature: 'coach', status: 'success', input_tokens: 5, output_tokens: 5, total_tokens: 10, token_source: 'provider', estimated_cost_usd: '0.000010', cost_source: 'estimated', recorded_by: 'server', created_at: new Date().toISOString() },
    ] } });
    const { usage, Storage } = await boot();
    Storage.saveAIUsage([
      { id: 'mine', ownerId: 'user:alice', pending: false, provider: 'openai', model: 'gpt-4.1-mini', status: 'success', inputTokens: 1, outputTokens: 1, createdAt: new Date().toISOString() },
      { id: 'theirs', ownerId: 'user:bob', provider: 'openai', model: 'gpt-4.1-mini', status: 'success', inputTokens: 99, outputTokens: 99, createdAt: new Date().toISOString() },
      { id: 'guest', ownerId: 'guest', provider: 'openai', model: 'gpt-4.1-mini', status: 'success', inputTokens: 50, outputTokens: 50, createdAt: new Date().toISOString() },
    ]);
    const { records, scope } = await usage.listUsage({ provider: 'openai' });
    expect(scope).toBe('account');
    expect(records.map(r => r.id).sort()).toEqual(['c1', 'mine']);
    // The cloud query is always scoped to the signed-in user (RLS enforces it server-side too).
    expect(calls).toContainEqual(['eq', 'user_id', 'alice']);
    expect(calls).toContainEqual(['eq', 'provider', 'openai']);
  });
});

describe('OpenRouter OAuth callback', () => {
  async function startAndReturn({ tamperState = false, ownerChange = false } = {}) {
    mockSupabase();
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ key: 'sk-or-v1-issuedkeyabcdefghijklmnop' }) }));
    vi.stubGlobal('fetch', fetchMock);
    const env = await boot({ guest: true });
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, origin: 'https://app.example', pathname: '/dashboard.html', search: '', assign } });
    await env.conn.startOAuthConnection({ provider: 'openrouter', model: 'google/gemma-2-9b-it:free', store: 'session' });
    const authUrl = new URL(assign.mock.calls[0][0]);
    expect(authUrl.origin + authUrl.pathname).toBe('https://openrouter.ai/auth');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const callback = new URL(authUrl.searchParams.get('callback_url'));
    if (tamperState) callback.searchParams.set('state', 'forged');
    if (ownerChange) { const p = JSON.parse(window.sessionStorage.getItem('hmpa:aiOAuthPending')); window.sessionStorage.setItem('hmpa:aiOAuthPending', JSON.stringify({ ...p, ownerId: 'user:someone' })); }
    callback.searchParams.set('code', 'onetimecode');
    window.location.search = callback.search;
    window.history.replaceState = vi.fn();
    const result = await env.conn.completeOAuthFromUrl();
    return { env, result, fetchMock };
  }

  it('exchanges the code with the PKCE verifier and stores the issued key', async () => {
    const { env, result, fetchMock } = await startAndReturn();
    expect(result).toEqual({ ok: true, provider: 'openrouter' });
    const exchange = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(exchange.code).toBe('onetimecode');
    expect(exchange.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(env.conn.getActiveConnection()).toMatchObject({ provider: 'openrouter', authMethod: 'oauth_pkce', configured: true, model: 'google/gemma-2-9b-it:free' });
    expect(window.history.replaceState).toHaveBeenCalledWith(null, '', '/dashboard.html#settings'); // code removed from the URL
    expect(window.sessionStorage.getItem('hmpa:aiOAuthPending')).toBeNull(); // one-time
  });

  it('rejects a callback whose state does not match', async () => {
    const { result, fetchMock } = await startAndReturn({ tamperState: true });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(C.OAUTH_STATE_MISMATCH);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a callback for an attempt started by a different owner', async () => {
    const { result } = await startAndReturn({ ownerChange: true });
    expect(result.error.code).toBe(C.OAUTH_STATE_MISMATCH);
  });

  it('account storage: the code + verifier go to ai-proxy, the browser never receives the key', async () => {
    const invoke = vi.fn((_fn, { body }) => Promise.resolve(body.action === 'health'
      ? { data: { ok: true, encryptionConfigured: true }, error: null }
      : { data: { connection: { provider: 'openrouter', authMethod: 'oauth_pkce', model: body.model, keyHint: '••••mnop', status: 'active' } }, error: null }));
    mockSupabase({ user: { id: 'alice' }, invoke });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = await boot();
    await env.conn.checkProxyHealth();
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, origin: 'https://app.example', pathname: '/dashboard.html', search: '', assign } });
    await env.conn.startOAuthConnection({ provider: 'openrouter', store: 'account' });
    const callback = new URL(new URL(assign.mock.calls[0][0]).searchParams.get('callback_url'));
    callback.searchParams.set('code', 'onetimecode');

    // Simulate the fresh page load after the redirect: new module instances, health not yet known.
    const fresh = await boot();
    window.location.search = callback.search;
    window.history.replaceState = vi.fn();
    const result = await fresh.conn.completeOAuthFromUrl();
    expect(result).toEqual({ ok: true, provider: 'openrouter' });
    const exchange = invoke.mock.calls.find(c => c[1].body.action === 'oauth_exchange')[1].body;
    expect(exchange).toMatchObject({ provider: 'openrouter', code: 'onetimecode' });
    expect(exchange.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fresh.conn.getActiveConnection()).toMatchObject({ store: 'account', configured: true, authMethod: 'oauth_pkce' });
    expect(JSON.stringify(window.localStorage)).not.toContain('sk-or');
  });

  it('Supabase does not try to treat the provider\'s ?code= as its own sign-in', async () => {
    window.history.replaceState(null, '', '/dashboard.html?ai_oauth=openrouter&state=s&code=c');
    const { client } = mockSupabase();
    vi.resetModules();
    await (await import('../../js/auth.js')).initializeAuth();
    expect(window.supabase.createClient.mock.calls[0][2].auth.detectSessionInUrl).toBe(false);
    expect(client).toBeTruthy();
    window.history.replaceState(null, '', '/');
  });

  it('is not offered inside the Android app', async () => {
    mockSupabase();
    window.HMPANative = { isNative: true };
    const { conn } = await boot({ guest: true });
    expect(conn.canUseOAuth('openrouter')).toBe(false);
    await expect(conn.startOAuthConnection({ provider: 'openrouter', store: 'session' })).rejects.toMatchObject({ code: C.UNSUPPORTED_PROVIDER });
  });
});

describe('storage migration v2 -> v3', () => {
  it('binds an existing device key to its owner and provider', async () => {
    window.localStorage.setItem('hmpa:meta', JSON.stringify({ schemaVersion: 2, userId: 'alice' }));
    window.localStorage.setItem('hmpa:settings', JSON.stringify({ aiProvider: 'groq', apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz' }));
    vi.resetModules();
    const Storage = (await import('../../js/storage.js')).default;
    Storage.runMigrations();
    expect(Storage.getSettings()).toMatchObject({ aiKeyOwner: 'user:alice', aiKeyProvider: 'groq', aiKeyStatus: 'active' });
    expect(Storage.getMeta().schemaVersion).toBe(3);
  });
});
