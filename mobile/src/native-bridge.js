/**
 * native-bridge.js
 * ----------------------------------------------------------------------------
 * Purpose: The only mobile-specific JavaScript. Bundled by
 *          scripts/build-web.mjs into www/native/bridge.js and loaded (as a
 *          classic script, before the app's own modules) into both
 *          index.html and dashboard.html of the packaged app. It contains NO
 *          business logic — it adapts the unchanged web app to Android:
 *
 *            - window.HMPANative: OAuth in the system browser and native file
 *              saving, used by js/auth.js and js/platform.js.
 *            - OAuth deep-link return: com.ch2digital.mealplannerai://auth-callback?code=…
 *              is routed to ./index.html?code=…, exactly where the web OAuth
 *              redirect lands, so supabase-js finishes sign-in the same way.
 *            - Android back button: closes the open modal / menu / drawer,
 *              then returns to the Dashboard, then backgrounds the app.
 *            - navigator.share polyfill (Android WebView has no Web Share API).
 *            - Adds the `native-app` class to <html> for mobile-only CSS.
 * ----------------------------------------------------------------------------
 */

import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

const HANDLED_LAUNCH_URL_KEY = 'hmpa:handledLaunchUrl';

/** Reads a Blob as base64 (without the data: prefix) for Filesystem.writeFile. */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(blob);
  });
}

/** Strips anything that could escape the export folder or confuse Android's file providers. */
export function safeFilename(name) {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return String(name || 'export').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').slice(0, 120) || 'export';
}

/**
 * If `url` is this app's OAuth callback deep link, returns the in-app page
 * that should finish sign-in (index.html + the callback's query/hash).
 * Returns null for any other URL.
 */
export function authCallbackTarget(url, redirectUrl) {
  if (!url || !redirectUrl) return null;
  const normalize = (u) => u.replace(/\/+$/, '').toLowerCase();
  const base = url.split(/[?#]/)[0];
  if (normalize(base) !== normalize(redirectUrl)) return null;
  const queryStart = url.indexOf('?');
  const hashStart = url.indexOf('#');
  const query = queryStart >= 0 ? url.slice(queryStart, hashStart > queryStart ? hashStart : undefined) : '';
  const hash = hashStart >= 0 ? url.slice(hashStart) : '';
  return `./index.html${query}${hash}`;
}

/**
 * Android back-button policy. Returns which action was taken, for tests.
 * Order matches user expectation: dismiss the top-most overlay first, then
 * step back to the home view, and only then leave the app.
 */
export function handleBackButton(win, app) {
  const doc = win.document;

  if (doc.getElementById('active-modal')) {
    // ui.js's openModal() closes on Escape — reuse it so onClose callbacks run.
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return 'close-modal';
  }

  const dropdown = doc.getElementById('user-menu-dropdown');
  if (dropdown) { dropdown.remove(); return 'close-menu'; }

  const scrim = doc.getElementById('sidebar-scrim');
  if (scrim) { scrim.click(); return 'close-drawer'; }

  if (doc.getElementById('app')) {
    const activeView = doc.querySelector('.view:not([hidden])')?.getAttribute('data-view');
    if (activeView && activeView !== 'dashboard') {
      const homeBtn = doc.querySelector('.tabbar [data-nav="dashboard"]') || doc.querySelector('[data-nav="dashboard"]');
      if (homeBtn) { homeBtn.click(); return 'go-home'; }
    }
  }

  // Root of the app: background it (Android convention) rather than
  // finishing the activity, so a guest's session-only data survives.
  app.minimizeApp();
  return 'minimize';
}

export function installNativeBridge({ win = window, plugins = { App, Browser, Filesystem, Share }, platform = Capacitor.getPlatform() } = {}) {
  const config = win.__HMPA_CONFIG__ || {};
  const redirectUrl = config.REDIRECT_URL;

  win.document.documentElement.classList.add('native-app', `native-${platform}`);

  win.HMPANative = {
    isNative: true,
    platform,

    /** Opens the OAuth provider in a Custom Tab (Google blocks embedded-WebView OAuth). */
    openAuthUrl(url) {
      return plugins.Browser.open({ url });
    },

    /** Writes a file to the app's cache and opens the share sheet to save/send it. */
    async saveFile(blob, filename) {
      const name = safeFilename(filename);
      const data = await blobToBase64(blob);
      const { uri } = await plugins.Filesystem.writeFile({ path: `exports/${name}`, data, directory: Directory.Cache, recursive: true });
      await plugins.Share.share({ title: name, files: [uri], dialogTitle: `Save or share ${name}` });
    },
  };

  if (!win.navigator.share) {
    // Shares text + link through the Android share sheet. Matches the
    // Web Share API contract closely enough for js/share.js.
    win.navigator.share = (data = {}) => plugins.Share.share({ title: data.title, text: data.text, url: data.url, dialogTitle: data.title }).then(() => undefined);
  }

  const routeAuthCallback = (url) => {
    const target = authCallbackTarget(url, redirectUrl);
    if (!target) return false;
    plugins.Browser.close().catch(() => { /* already closed */ });
    win.location.replace(target);
    return true;
  };

  plugins.App.addListener('appUrlOpen', ({ url }) => { routeAuthCallback(url); });

  // Cold start via the deep link (the OS killed the app while the user was
  // in the browser). getLaunchUrl() keeps returning the same URL for the
  // activity's lifetime, so remember it to avoid a redirect loop.
  plugins.App.getLaunchUrl().then((result) => {
    const url = result?.url;
    if (!url) return;
    let handled = null;
    try { handled = win.sessionStorage.getItem(HANDLED_LAUNCH_URL_KEY); } catch { /* storage blocked */ }
    if (handled === url) return;
    if (authCallbackTarget(url, redirectUrl)) {
      try { win.sessionStorage.setItem(HANDLED_LAUNCH_URL_KEY, url); } catch { /* storage blocked */ }
      routeAuthCallback(url);
    }
  }).catch(() => { /* no launch URL */ });

  plugins.App.addListener('backButton', () => { handleBackButton(win, plugins.App); });

  return win.HMPANative;
}

if (Capacitor.isNativePlatform()) {
  installNativeBridge();
}
