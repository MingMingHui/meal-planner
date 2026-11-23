/**
 * platform.js
 * ----------------------------------------------------------------------------
 * Purpose: The few browser capabilities that behave differently inside the
 *          Android app's WebView than in a normal browser, behind one call
 *          each. In a browser these do exactly what the app always did; in
 *          the app they delegate to the native helpers that
 *          mobile/src/native-bridge.js installs on window.HMPANative.
 * Inputs:  Blobs + filenames to save.
 * Outputs: A browser download, or (in the app) the Android share sheet so
 *          the user can save the file to Files/Drive or send it elsewhere.
 * Depends on: ui.js (toast for native save failures).
 * ----------------------------------------------------------------------------
 */

import { toast } from './ui.js';

/** True when running inside the packaged mobile app rather than a browser. */
export function isNativeApp() {
  return !!window.HMPANative?.isNative;
}

/**
 * Saves a file for the user. Android WebViews silently ignore
 * <a download href="blob:..."> clicks, so the app writes the file natively
 * and opens the share sheet instead.
 */
export function saveFile(blob, filename) {
  if (isNativeApp()) {
    return window.HMPANative.saveFile(blob, filename).catch((err) => {
      if (/cancel/i.test(err?.message || '')) return; // user dismissed the share sheet
      console.error('[platform] native saveFile failed', err);
      toast(`Could not save ${filename}.`, 'error');
    });
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  return Promise.resolve();
}
