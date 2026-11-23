// @vitest-environment jsdom
/**
 * The OAuth sign-in path in the shared js/auth.js: unchanged in a browser,
 * system-browser + PKCE inside the app.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function mockSupabase() {
  const auth = {
    getSession: vi.fn(() => Promise.resolve({ data: { session: null }, error: null })),
    onAuthStateChange: vi.fn(),
    signInWithOAuth: vi.fn(() => Promise.resolve({ data: { url: 'https://proj.supabase.co/auth/v1/authorize?provider=google' }, error: null })),
    signOut: vi.fn(() => Promise.resolve({ error: null })),
  };
  const createClient = vi.fn(() => ({ auth }));
  window.supabase = { createClient };
  return { auth, createClient };
}

async function loadAuth() {
  vi.resetModules();
  return import('../../js/auth.js');
}

beforeEach(() => {
  delete window.HMPANative;
  delete window.__HMPA_CONFIG__;
});
afterEach(() => { delete window.supabase; });

describe('js/auth.js in a browser (web behaviour unchanged)', () => {
  it('uses the default flow and lets supabase-js redirect the page', async () => {
    const { auth, createClient } = mockSupabase();
    const mod = await loadAuth();
    await mod.initializeAuth();
    expect(createClient.mock.calls[0][2].auth).toEqual({ persistSession: true, autoRefreshToken: true, detectSessionInUrl: true });

    await mod.signInWithGmail();
    expect(auth.signInWithOAuth).toHaveBeenCalledWith({ provider: 'google', options: { redirectTo: `${window.location.origin}/` } });

    await mod.signInWithOutlook();
    expect(auth.signInWithOAuth).toHaveBeenLastCalledWith({ provider: 'azure', options: { redirectTo: `${window.location.origin}/`, scopes: 'email' } });
  });

  it('surfaces provider errors with friendly text', async () => {
    const { auth } = mockSupabase();
    auth.signInWithOAuth.mockResolvedValueOnce({ data: {}, error: { message: 'Unsupported provider: provider is not enabled' } });
    const mod = await loadAuth();
    await mod.initializeAuth();
    await expect(mod.signInWithGmail()).rejects.toThrow('This sign-in provider is not enabled for this app yet.');
  });
});

describe('js/auth.js inside the Android app', () => {
  it('uses PKCE, the deep-link redirect, and opens the provider in the system browser', async () => {
    window.__HMPA_CONFIG__ = { REDIRECT_URL: 'com.ch2digital.mealplannerai://auth-callback' };
    window.HMPANative = { isNative: true, openAuthUrl: vi.fn(() => Promise.resolve()) };
    const { auth, createClient } = mockSupabase();
    const mod = await loadAuth();
    await mod.initializeAuth();
    expect(createClient.mock.calls[0][2].auth.flowType).toBe('pkce');

    await mod.signInWithOutlook();
    expect(auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'azure',
      options: { redirectTo: 'com.ch2digital.mealplannerai://auth-callback', scopes: 'email', skipBrowserRedirect: true },
    });
    expect(window.HMPANative.openAuthUrl).toHaveBeenCalledWith('https://proj.supabase.co/auth/v1/authorize?provider=google');
  });
});

describe('signOutLocally', () => {
  it('drops only the local session (used after account deletion)', async () => {
    const { auth } = mockSupabase();
    const mod = await loadAuth();
    await mod.initializeAuth();
    await mod.signOutLocally();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mod.isAuthenticated()).toBe(false);
  });
});
