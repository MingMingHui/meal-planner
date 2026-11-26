// @vitest-environment jsdom
/**
 * Renders the shared AI screens (js/aiViews.js) — Settings → AI Provider and
 * the AI Usage page — the same DOM the web app and the Android app show.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const OPENAI_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';

function mockSupabase({ user = null, usageRows = [] } = {}) {
  const q = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'gte', 'lte']) q[m] = () => q;
  q.then = (resolve) => resolve({ data: usageRows, error: null });
  const client = {
    auth: { getSession: () => Promise.resolve({ data: { session: user ? { user } : null }, error: null }), onAuthStateChange: () => {} },
    functions: { invoke: vi.fn(() => Promise.resolve({ data: { ok: true, encryptionConfigured: true }, error: null })) },
    from: () => q,
  };
  window.supabase = { createClient: () => client };
}

async function boot({ guest = false } = {}) {
  vi.resetModules();
  await (await import('../../js/auth.js')).initializeAuth();
  const Storage = (await import('../../js/storage.js')).default;
  if (guest) Storage.enterGuestSession();
  return { Storage, views: await import('../../js/aiViews.js'), conn: await import('../../js/aiConnections.js') };
}

const tick = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.body.innerHTML = '<div id="toast-region"></div><div class="card" id="card"></div><section id="view-usage"></section>';
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })));
});
afterEach(() => { delete window.supabase; vi.unstubAllGlobals(); });

describe('AI Provider card', () => {
  it('guest: explains guest scope, offers no account storage, never pre-fills the key', async () => {
    mockSupabase();
    const { views, conn } = await boot({ guest: true });
    await conn.connectWithApiKey({ provider: 'openai', apiKey: OPENAI_KEY, store: 'session' });
    const card = document.getElementById('card');
    views.renderAIProviderCard(card);
    const text = card.textContent;
    expect(text).toContain('Guest session — no app account');
    expect(text).toContain('This browser session only (guest)');
    expect(card.querySelector('input[name="ai-store"]')).toBeNull();
    expect(card.querySelector('#ai-apikey').value).toBe('');
    expect(card.innerHTML).not.toContain('sk-proj');
    expect(card.innerHTML).toContain('••••3456');
    // Provider + model selectors come from the registry
    const providers = [...card.querySelectorAll('#ai-provider option')].map(o => o.value);
    expect(providers).toEqual(expect.arrayContaining(['openai', 'anthropic', 'openrouter']));
    expect(card.querySelector('#ai-oauth-btn')).toBeNull(); // OpenAI: no OAuth
  });

  it('switching provider updates models and shows OpenRouter sign-in on the web', async () => {
    mockSupabase();
    const { views } = await boot({ guest: true });
    const card = document.getElementById('card');
    views.renderAIProviderCard(card);
    const sel = card.querySelector('#ai-provider');
    sel.value = 'anthropic';
    sel.dispatchEvent(new Event('change'));
    expect([...card.querySelectorAll('#ai-model option')].map(o => o.value)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    card.querySelector('#ai-provider').value = 'openrouter';
    card.querySelector('#ai-provider').dispatchEvent(new Event('change'));
    expect(card.querySelector('#ai-oauth-btn')).not.toBeNull();
  });

  it('signed in: separates the app account from the AI provider and offers account storage once ai-proxy responds', async () => {
    mockSupabase({ user: { id: 'alice', email: 'a@example.com', user_metadata: { full_name: 'Alice <b>' }, app_metadata: { provider: 'google' } } });
    const { views } = await boot();
    const card = document.getElementById('card');
    views.renderAIProviderCard(card);
    expect(card.textContent).toContain('Signed in as Alice <b> with Gmail'); // escaped, rendered as text
    expect(card.querySelector('dd b').textContent).toBe('Alice <b>');
    await tick(); await tick();
    const stores = [...card.querySelectorAll('input[name="ai-store"]')];
    expect(stores.map(s => [s.value, s.disabled])).toEqual([['account', false], ['device', false]]);
  });
});

describe('AI Usage view', () => {
  it('shows summaries, labelled sources and history for the user\'s records', async () => {
    const now = new Date().toISOString();
    mockSupabase({ user: { id: 'alice' }, usageRows: [
      { id: 'a', provider: 'anthropic', model: 'claude-opus-5-5', feature: 'coach', status: 'success', input_tokens: 1000, output_tokens: 200, total_tokens: 1200, token_source: 'provider', estimated_cost_usd: '0.008', cost_source: 'estimated', recorded_by: 'server', created_at: now },
      { id: 'b', provider: 'groq', model: 'llama-3.1-8b-instant', feature: 'recipe', status: 'success', input_tokens: 10, output_tokens: 5, total_tokens: 15, token_source: 'estimated', estimated_cost_usd: null, cost_source: 'unavailable', recorded_by: 'client', created_at: now },
    ] });
    const { views } = await boot();
    await views.renderUsageView();
    const view = document.getElementById('view-usage');
    const text = view.textContent;
    expect(text).toContain('Current period');
    expect(text).toContain('1,215'); // total tokens
    expect(text).toContain('Provider-reported');
    expect(text).toContain('App-estimated');
    expect(text).toContain('Estimated cost');
    expect(text).toContain('Excludes models without pricing');
    expect(view.querySelectorAll('.usage-table').length).toBe(2);
    expect(view.querySelector('td[data-label="Model"]')).not.toBeNull(); // mobile card layout labels
  });

  it('guest with nothing connected gets a pointer to settings and the session-scope note', async () => {
    mockSupabase();
    const { views } = await boot({ guest: true });
    await views.renderUsageView();
    const text = document.getElementById('view-usage').textContent;
    expect(text).toContain('No AI provider is connected');
    expect(text).toContain('kept in this browser tab only');
    expect(text).toContain('No AI requests in this range.');
  });

  it('formats money sensibly', async () => {
    mockSupabase();
    const { views } = await boot({ guest: true });
    expect(views.formatUsd(null)).toBe('—');
    expect(views.formatUsd(0)).toBe('$0.00');
    expect(views.formatUsd(0.00123)).toBe('$0.0012');
    expect(views.formatUsd(1.5)).toBe('$1.50');
  });
});
