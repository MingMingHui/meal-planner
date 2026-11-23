// @vitest-environment jsdom
/** js/platform.js (file saving) and js/config.js runtime overrides. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  delete window.HMPANative;
  delete window.__HMPA_CONFIG__;
  document.body.innerHTML = '<div id="toast-region"></div>';
});

describe('saveFile', () => {
  it('in a browser, downloads via a temporary <a download> exactly as before', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      expect(this.download).toBe('data.json');
      expect(this.href).toBe('blob:mock');
    });
    const { saveFile, isNativeApp } = await import('../../js/platform.js');
    expect(isNativeApp()).toBe(false);
    await saveFile(new Blob(['x']), 'data.json');
    expect(click).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    expect(document.querySelector('a')).toBeNull();
  });

  it('in the app, hands the blob to the native bridge', async () => {
    window.HMPANative = { isNative: true, saveFile: vi.fn(() => Promise.resolve()) };
    const { saveFile, isNativeApp } = await import('../../js/platform.js');
    expect(isNativeApp()).toBe(true);
    const blob = new Blob(['x']);
    await saveFile(blob, 'report.pdf');
    expect(window.HMPANative.saveFile).toHaveBeenCalledWith(blob, 'report.pdf');
  });

  it('in the app, ignores a dismissed share sheet but reports real failures', async () => {
    window.HMPANative = { isNative: true, saveFile: vi.fn().mockRejectedValueOnce(new Error('Share canceled')).mockRejectedValueOnce(new Error('disk full')) };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { saveFile } = await import('../../js/platform.js');
    await saveFile(new Blob(['x']), 'a.csv');
    expect(document.querySelector('.toast')).toBeNull();
    await saveFile(new Blob(['x']), 'a.csv');
    expect(document.querySelector('.toast.error').textContent).toBe('Could not save a.csv.');
  });
});

describe('config.js', () => {
  it('without runtime overrides keeps the committed web values', async () => {
    const { default: CONFIG } = await import('../../js/config.js');
    expect(CONFIG.SUPABASE_URL).toBe('https://bkrgxmjsyghzrostfvrt.supabase.co');
    expect(CONFIG.SUPABASE_ANON_KEY).toMatch(/^sb_publishable_/);
    expect(CONFIG.REDIRECT_URL).toBe(`${window.location.origin}/`);
    expect(CONFIG.PUBLIC_URL).toBeNull();
    expect(CONFIG.CLOUD_ENABLED).toBe(true);
  });

  it('applies the mobile runtime config', async () => {
    window.__HMPA_CONFIG__ = {
      SUPABASE_URL: 'https://staging.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_staging',
      REDIRECT_URL: 'com.ch2digital.mealplannerai://auth-callback', PUBLIC_URL: 'https://example.com/app/',
    };
    const { default: CONFIG } = await import('../../js/config.js');
    expect(CONFIG).toMatchObject({
      SUPABASE_URL: 'https://staging.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_staging',
      REDIRECT_URL: 'com.ch2digital.mealplannerai://auth-callback', PUBLIC_URL: 'https://example.com/app/',
    });
  });

  it('an empty runtime backend disables cloud features (guest-only build)', async () => {
    window.__HMPA_CONFIG__ = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '' };
    const { default: CONFIG } = await import('../../js/config.js');
    expect(CONFIG.CLOUD_ENABLED).toBe(false);
  });
});
