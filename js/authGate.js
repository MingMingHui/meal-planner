/**
 * authGate.js
 * ----------------------------------------------------------------------------
 * Purpose: Controller for the login/guest-choice page (index.html) ONLY.
 *          This is a genuinely separate page from the app shell
 *          (dashboard.html) — not a hidden/shown div toggled within one
 *          combined document. Its only job is to get the visitor into one of
 *          two states (signed in, or an active guest session) and then
 *          navigate the browser to dashboard.html; it renders no app UI
 *          itself. dashboard.html's app.js enforces the reverse guard on
 *          load — no session or guest state there bounces back here — so the
 *          two pages can't drift out of sync about who's allowed where.
 * Inputs:  DOM (index.html shell).
 * Outputs: A browser navigation to dashboard.html once the visitor is signed
 *          in or has chosen to continue as a guest.
 * Depends on: storage.js, auth.js, ui.js (toast).
 * ----------------------------------------------------------------------------
 */

import Storage from './storage.js';
import { toast } from './ui.js';
import {
  initializeAuth, isCloudConfigured, getEnabledProviders,
  signInWithGmail, signInWithOutlook, isAuthenticated,
} from './auth.js';

const DASHBOARD_URL = './dashboard.html';

async function initAuthScreen() {
  await initializeAuth();

  // Already signed in (a restored session, or just back from an OAuth
  // redirect) or already mid-guest-session (e.g. this tab reloaded index.html
  // directly) — nothing to choose, go straight to the app.
  if (isAuthenticated() || Storage.isGuestSessionActive()) {
    window.location.replace(DASHBOARD_URL);
    return;
  }

  wireAuthScreenButtons();
}

function wireAuthScreenButtons() {
  const gmailBtn = document.getElementById('auth-google-btn');
  const outlookBtn = document.getElementById('auth-microsoft-btn');
  const guestBtn = document.getElementById('auth-guest-btn');
  const note = document.getElementById('auth-note');

  if (!isCloudConfigured()) {
    gmailBtn.disabled = true;
    outlookBtn.disabled = true;
    note.textContent = 'Cloud sign-in isn’t configured for this deployment yet — continue as a guest. (See README → Authentication Setup to enable Gmail/Outlook sign-in.)';
  } else {
    // Best-effort: disable a provider's button individually if it isn't
    // actually turned on in the Supabase dashboard yet, so clicking it
    // doesn't navigate the whole tab away to a raw Supabase error page
    // (see auth.js's getEnabledProviders()).
    getEnabledProviders().then(({ google, azure }) => {
      const disabledLabels = [];
      if (!google) { gmailBtn.disabled = true; disabledLabels.push('Gmail'); }
      if (!azure) { outlookBtn.disabled = true; disabledLabels.push('Outlook'); }
      if (disabledLabels.length) {
        const verb = disabledLabels.length > 1 ? 'are not' : 'is not';
        note.textContent = `${disabledLabels.join(' and ')} sign-in ${verb} enabled for this deployment yet — continue as a guest. (See README → Authentication Setup.)`;
      }
    });
  }

  gmailBtn.addEventListener('click', async () => {
    try { await signInWithGmail(); } // page navigates away to Supabase, then back here, on success
    catch (err) { note.textContent = err.message; toast(err.message, 'error', 5000); }
  });
  outlookBtn.addEventListener('click', async () => {
    try { await signInWithOutlook(); }
    catch (err) { note.textContent = err.message; toast(err.message, 'error', 5000); }
  });
  guestBtn.addEventListener('click', () => {
    // The navigation to dashboard.html must never be blocked by best-effort
    // session bookkeeping — if enterGuestSession() throws (e.g. sessionStorage
    // restricted by a browser/enterprise policy), the guest can still get
    // into the app; the session-scoping just degrades instead of silently
    // eating the click.
    try { Storage.enterGuestSession(); } catch (err) { console.error('[authGate] enterGuestSession failed', err); }
    window.location.href = DASHBOARD_URL;
  });
}

document.addEventListener('DOMContentLoaded', initAuthScreen);
