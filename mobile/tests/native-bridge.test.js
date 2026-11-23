// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' } }));
vi.mock('@capacitor/app', () => ({ App: {} }));
vi.mock('@capacitor/browser', () => ({ Browser: {} }));
vi.mock('@capacitor/filesystem', () => ({ Filesystem: {}, Directory: { Cache: 'CACHE' } }));
vi.mock('@capacitor/share', () => ({ Share: {} }));

const { authCallbackTarget, handleBackButton, installNativeBridge, safeFilename, blobToBase64 } = await import('../src/native-bridge.js');

const REDIRECT = 'com.ch2digital.mealplannerai://auth-callback';

function fakePlugins({ launchUrl = null } = {}) {
  const listeners = {};
  return {
    listeners,
    App: {
      addListener: vi.fn((event, cb) => { listeners[event] = cb; return Promise.resolve({ remove() {} }); }),
      getLaunchUrl: vi.fn(() => Promise.resolve(launchUrl ? { url: launchUrl } : undefined)),
      minimizeApp: vi.fn(),
    },
    Browser: { open: vi.fn(() => Promise.resolve()), close: vi.fn(() => Promise.resolve()) },
    Filesystem: { writeFile: vi.fn(() => Promise.resolve({ uri: 'file:///cache/exports/x' })) },
    Share: { share: vi.fn(() => Promise.resolve({})) },
  };
}

function fakeWin(extra = {}) {
  return {
    document,
    navigator: {},
    sessionStorage: window.sessionStorage,
    location: { replace: vi.fn() },
    KeyboardEvent: window.KeyboardEvent,
    __HMPA_CONFIG__: { REDIRECT_URL: REDIRECT },
    ...extra,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.className = '';
  window.sessionStorage.clear();
});

describe('authCallbackTarget', () => {
  it('routes the PKCE code to index.html like the web redirect', () => {
    expect(authCallbackTarget(`${REDIRECT}?code=abc123`, REDIRECT)).toBe('./index.html?code=abc123');
  });
  it('keeps error fragments/queries so supabase-js can surface them', () => {
    expect(authCallbackTarget(`${REDIRECT}#error=access_denied&error_description=x`, REDIRECT)).toBe('./index.html#error=access_denied&error_description=x');
    expect(authCallbackTarget(`${REDIRECT}/?error=server_error`, REDIRECT)).toBe('./index.html?error=server_error');
  });
  it('ignores other URLs', () => {
    expect(authCallbackTarget('https://evil.example/auth-callback?code=1', REDIRECT)).toBeNull();
    expect(authCallbackTarget('com.ch2digital.mealplannerai://other?code=1', REDIRECT)).toBeNull();
    expect(authCallbackTarget('', REDIRECT)).toBeNull();
    expect(authCallbackTarget(`${REDIRECT}?code=1`, undefined)).toBeNull();
  });
});

describe('handleBackButton', () => {
  const app = () => ({ minimizeApp: vi.fn() });

  it('closes an open modal first (via Escape, so onClose runs)', () => {
    document.body.innerHTML = '<div id="active-modal"></div><div id="user-menu-dropdown"></div>';
    const onEsc = vi.fn();
    document.addEventListener('keydown', onEsc, { once: true });
    expect(handleBackButton(window, app())).toBe('close-modal');
    expect(onEsc.mock.calls[0][0].key).toBe('Escape');
  });

  it('then the user menu, then the drawer', () => {
    document.body.innerHTML = '<div id="user-menu-dropdown"></div><div id="sidebar-scrim"></div>';
    expect(handleBackButton(window, app())).toBe('close-menu');
    expect(document.getElementById('user-menu-dropdown')).toBeNull();
    const scrim = document.getElementById('sidebar-scrim');
    const click = vi.fn(); scrim.addEventListener('click', click);
    expect(handleBackButton(window, app())).toBe('close-drawer');
    expect(click).toHaveBeenCalled();
  });

  it('returns to the Dashboard from any other view', () => {
    document.body.innerHTML = `<div id="app">
      <section class="view" data-view="dashboard" hidden></section>
      <section class="view" data-view="recipes"></section>
      <nav class="tabbar"><button data-nav="dashboard"></button></nav></div>`;
    const click = vi.fn();
    document.querySelector('.tabbar [data-nav="dashboard"]').addEventListener('click', click);
    expect(handleBackButton(window, app())).toBe('go-home');
    expect(click).toHaveBeenCalled();
  });

  it('backgrounds the app on the Dashboard and on the login page', () => {
    document.body.innerHTML = '<div id="app"><section class="view" data-view="dashboard"></section></div>';
    const a = app();
    expect(handleBackButton(window, a)).toBe('minimize');
    expect(a.minimizeApp).toHaveBeenCalledTimes(1);
    document.body.innerHTML = '<div id="auth-screen"></div>';
    expect(handleBackButton(window, a)).toBe('minimize');
  });
});

describe('installNativeBridge', () => {
  it('exposes HMPANative, tags <html>, and opens OAuth in the system browser', async () => {
    const plugins = fakePlugins();
    const win = fakeWin();
    const native = installNativeBridge({ win, plugins, platform: 'android' });
    expect(win.HMPANative).toBe(native);
    expect(native.isNative).toBe(true);
    expect(document.documentElement.classList.contains('native-app')).toBe(true);
    await native.openAuthUrl('https://x.supabase.co/auth/v1/authorize?provider=google');
    expect(plugins.Browser.open).toHaveBeenCalledWith({ url: 'https://x.supabase.co/auth/v1/authorize?provider=google' });
  });

  it('routes the OAuth deep link and closes the Custom Tab', () => {
    const plugins = fakePlugins();
    const win = fakeWin();
    installNativeBridge({ win, plugins, platform: 'android' });
    plugins.listeners.appUrlOpen({ url: `${REDIRECT}?code=xyz` });
    expect(plugins.Browser.close).toHaveBeenCalled();
    expect(win.location.replace).toHaveBeenCalledWith('./index.html?code=xyz');
  });

  it('ignores unrelated deep links', () => {
    const plugins = fakePlugins();
    const win = fakeWin();
    installNativeBridge({ win, plugins, platform: 'android' });
    plugins.listeners.appUrlOpen({ url: 'https://example.com' });
    expect(win.location.replace).not.toHaveBeenCalled();
  });

  it('handles a cold-start launch URL exactly once', async () => {
    const url = `${REDIRECT}?code=cold`;
    const win = fakeWin();
    installNativeBridge({ win, plugins: fakePlugins({ launchUrl: url }), platform: 'android' });
    await vi.waitFor(() => expect(win.location.replace).toHaveBeenCalledWith('./index.html?code=cold'));
    // Same activity, page reloaded: getLaunchUrl() still returns it — must not loop.
    const win2 = fakeWin();
    installNativeBridge({ win: win2, plugins: fakePlugins({ launchUrl: url }), platform: 'android' });
    await new Promise(r => setTimeout(r, 0));
    expect(win2.location.replace).not.toHaveBeenCalled();
  });

  it('saveFile writes to the private cache and opens the share sheet', async () => {
    const plugins = fakePlugins();
    const win = fakeWin();
    installNativeBridge({ win, plugins, platform: 'android' });
    await win.HMPANative.saveFile(new Blob(['{"a":1}'], { type: 'application/json' }), 'data.json');
    expect(plugins.Filesystem.writeFile).toHaveBeenCalledWith({ path: 'exports/data.json', data: btoa('{"a":1}'), directory: 'CACHE', recursive: true });
    expect(plugins.Share.share).toHaveBeenCalledWith(expect.objectContaining({ files: ['file:///cache/exports/x'] }));
  });

  it('polyfills navigator.share only when missing', async () => {
    const plugins = fakePlugins();
    const win = fakeWin();
    installNativeBridge({ win, plugins, platform: 'android' });
    await win.navigator.share({ title: 'T', text: 'hello', url: 'https://example.com' });
    expect(plugins.Share.share).toHaveBeenCalledWith({ title: 'T', text: 'hello', url: 'https://example.com', dialogTitle: 'T' });

    const existing = vi.fn();
    const win2 = fakeWin({ navigator: { share: existing } });
    installNativeBridge({ win: win2, plugins: fakePlugins(), platform: 'android' });
    expect(win2.navigator.share).toBe(existing);
  });

  it('registers the Android back button handler', () => {
    const plugins = fakePlugins();
    installNativeBridge({ win: fakeWin(), plugins, platform: 'android' });
    document.body.innerHTML = '<div id="auth-screen"></div>';
    plugins.listeners.backButton();
    expect(plugins.App.minimizeApp).toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('safeFilename strips path separators and control characters', () => {
    expect(safeFilename('../../etc/passwd')).toBe('..-..-etc-passwd');
    expect(safeFilename('recipe: nasi lemak?.pdf')).toBe('recipe- nasi lemak-.pdf');
    expect(safeFilename('')).toBe('export');
  });
  it('blobToBase64 returns raw base64', async () => {
    expect(await blobToBase64(new Blob(['hi']))).toBe(btoa('hi'));
  });
});
