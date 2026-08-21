/**
 * app.js
 * ----------------------------------------------------------------------------
 * Purpose: Application entry point. Wires up the router, renders the
 *          Dashboard / Profile / Settings / AI Coach views (the ones that
 *          don't warrant their own file), handles theme switching, mobile
 *          navigation, and bootstraps data loading on startup.
 * Inputs:  DOM (index.html shell) + all other modules.
 * Outputs: A fully interactive app once loadAppData() resolves.
 * Depends on: storage.js, nutrition.js, ai.js, ui.js, router.js, data.js,
 *             calorie.js, recipes.js, shopping.js, progress.js, share.js.
 * ----------------------------------------------------------------------------
 */

import Storage from './storage.js';
import { calcFullProfile, ACTIVITY_FACTORS, GOAL_ADJUSTMENTS } from './nutrition.js';
import { PROVIDERS, coachReply, hasAPIKey } from './ai.js';
import { ICONS, escapeHTML, fmt, toast, optionsFromMap, openModal, closeModal, el } from './ui.js';
import { initRouter, registerView, navigate } from './router.js';
import { loadAppData } from './data.js';
import { renderCalculatorView } from './calorie.js';
import { renderPlannerView, renderRecipesView, buildLocalMealPlan } from './recipes.js';
import { renderShoppingView } from './shopping.js';
import { renderProgressView, getTodayCalories, getTodayWaterCups, addWaterCup, logCalories } from './progress.js';
import {
  initializeAuth, isCloudConfigured, getEnabledProviders, signInWithGmail, signInWithOutlook, signOut,
  isAuthenticated, getUserProfile, listenToAuthChanges,
} from './auth.js';
import { deleteUserData as deleteCloudData } from './cloudStorage.js';
import { syncAll, getSyncStatus, onSyncStatusChange, syncAvailable, checkFirstLoginState, resolveFirstLogin, wireAutoSync } from './syncManager.js';
import { exportCompleteReportPDF, exportProfilePDF } from './pdf.js';
import CONFIG from './config.js';

/* ============================== Theme ============================== */

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) btn.innerHTML = theme === 'dark' ? ICONS.sun : ICONS.moon;
}

function initTheme() {
  const settings = Storage.getSettings();
  let theme = settings.theme;
  if (!theme || theme === 'auto') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  applyTheme(theme);
  document.getElementById('theme-toggle-btn')?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    Storage.saveSettings({ theme: next });
  });
}

/* ============================== Auth gate ============================== */

/**
 * Decides whether to show the login/guest screen or go straight into the
 * app: skipped automatically if a session is already restored (including
 * right after an OAuth redirect back to this page) or if this browser tab
 * already has an active guest session (storage.js's isGuestSessionActive —
 * guest access is scoped to the browser session, not remembered
 * indefinitely like sign-in is).
 * @returns {Promise<void>} resolves once the app shell should be shown.
 */
function decideInitialScreen() {
  return new Promise((resolve) => {
    const authScreen = document.getElementById('auth-screen');
    const appShell = document.getElementById('app');

    const proceed = () => { authScreen.hidden = true; appShell.hidden = false; resolve(); };

    if (isAuthenticated()) { proceed(); return; }
    if (Storage.isGuestSessionActive()) { Storage.enterGuestSession(); proceed(); return; }

    authScreen.hidden = false;
    appShell.hidden = true;
    wireAuthScreenButtons(proceed);
  });
}

function wireAuthScreenButtons(proceed) {
  const gmailBtn = document.getElementById('auth-google-btn');
  const outlookBtn = document.getElementById('auth-microsoft-btn');
  const guestBtn = document.getElementById('auth-guest-btn');
  const note = document.getElementById('auth-note');

  if (!isCloudConfigured()) {
    gmailBtn.disabled = true;
    outlookBtn.disabled = true;
    note.textContent = 'Cloud sign-in isn\u2019t configured for this deployment yet — continue as a guest. (See README → Authentication Setup to enable Gmail/Outlook sign-in.)';
  } else {
    getEnabledProviders().then(({ google, azure }) => {
      const disabledLabels = [];
      if (!google) { gmailBtn.disabled = true; disabledLabels.push('Gmail'); }
      if (!azure) { outlookBtn.disabled = true; disabledLabels.push('Outlook'); }
      if (disabledLabels.length) {
        const verb = disabledLabels.length > 1 ? 'are not' : 'is not';
        note.textContent = disabledLabels.join(' and ') + ' sign-in ' + verb + ' enabled for this deployment yet. Continue as a guest, or see README Authentication Setup.';
      }
    });
  }

  gmailBtn.addEventListener('click', async () => {
    try { await signInWithGmail(); } // page navigates away on success
    catch (err) { note.textContent = err.message; toast(err.message, 'error', 5000); }
  });
  outlookBtn.addEventListener('click', async () => {
    try { await signInWithOutlook(); }
    catch (err) { note.textContent = err.message; toast(err.message, 'error', 5000); }
  });
  guestBtn.addEventListener('click', () => {
    // proceed() (the actual auth-screen -> app transition) must never be
    // blocked by best-effort session bookkeeping: if either call below
    // throws (e.g. sessionStorage restricted by a browser/enterprise
    // policy), the guest can still get into the app - the session-scoping
    // just degrades instead of silently eating the click.
    try { Storage.enterGuestSession(); } catch (err) { console.error('[app] enterGuestSession failed', err); }
    proceed();
    try { renderGuestBanner(); } catch (err) { console.error('[app] renderGuestBanner failed', err); }
  });
}

/**
 * Runs once, right after we know the user is signed in (fresh sign-in or a
 * restored session): checks for the "existing data on this device" case and
 * lets the user choose how to reconcile it, then performs an initial sync.
 */
async function handlePostAuth() {
  if (!isAuthenticated()) return;
  if (Storage.isGuestSessionActive()) {
    // A former guest just signed in during this browser tab session — fold
    // whatever they built up as a guest into the durable store first, so
    // checkFirstLoginState() below sees it as "existing local data" to
    // reconcile with the cloud instead of losing it when the backend
    // switches away from sessionStorage.
    try { Storage.claimGuestSessionForAccount(); } catch (err) { console.error('[app] claimGuestSessionForAccount failed', err); }
    try { renderGuestBanner(); } catch (err) { console.error('[app] renderGuestBanner failed', err); }
  }
  try {
    const state = await checkFirstLoginState();
    if (state.needsDecision) {
      await showDataConflictModal();
    } else {
      await resolveFirstLogin('merge');
    }
  } catch (err) {
    console.error('[app] post-auth sync check failed', err);
    toast('Could not check your cloud data — you can retry from Settings → Cloud Sync.', 'error', 4500);
  }
  maybeShowOnboarding();
}

function showDataConflictModal() {
  return new Promise((resolve) => {
    openModal(`
      <div class="modal-head"><h3>Existing data found</h3></div>
      <p class="small">We found existing data on this device, and your account already has data saved in the cloud. What would you like to do?</p>
      <div class="conflict-options">
        <button class="btn btn-primary" data-choice="merge">Merge Both <span class="small" style="display:block; font-weight:400;">Recommended — combines both safely</span></button>
        <button class="btn btn-ghost" data-choice="cloud">Keep Cloud Data</button>
        <button class="btn btn-ghost" data-choice="local">Keep This Device's Data</button>
      </div>
    `, { onClose: () => resolve() });

    document.querySelectorAll('[data-choice]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const choice = btn.dataset.choice;
        closeModal();
        toast('Syncing your data…', 'default', 2000);
        await resolveFirstLogin(choice);
        toast('Your data is up to date.', 'success');
        renderCurrentViewIfActive(['dashboard', 'planner', 'shopping', 'progress']);
        resolve();
      });
    });
  });
}

function renderCurrentViewIfActive(viewIds) {
  // Cheap refresh: re-render dashboard since it's the most common landing view after sync.
  if (viewIds.includes('dashboard') && !document.getElementById('view-dashboard').hasAttribute('hidden')) renderDashboard();
}

/** Shows the multi-step onboarding flow once, right after first sign-in, if the profile looks incomplete. */
function maybeShowOnboarding() {
  const profile = Storage.getProfile();
  const meta = Storage.getMeta();
  if (meta.onboardingDone) return;
  if (profile.weight && profile.height && profile.age) { Storage.saveMeta({ onboardingDone: true }); return; }
  showOnboardingModal();
}

const ONBOARDING_STEPS = [
  { title: 'Personal information', fields: ['weight', 'height', 'age', 'gender'] },
  { title: 'Health & nutrition goals', fields: ['activityLevel', 'goal'] },
  { title: 'Diet & allergies', fields: ['dietPreference', 'allergies', 'medicalNotes'] },
  { title: 'Lifestyle', fields: ['mealBudget', 'cookingSkill', 'mealsPerDay'] },
  { title: 'Preferences', fields: ['favoriteFoods', 'dislikedFoods'] },
];

function onboardingFieldHTML(field, p) {
  const toStr = (arr) => escapeHTML((arr || []).join(', '));
  switch (field) {
    case 'weight': return `<div class="field"><label>Weight (kg)</label><input type="number" step="0.1" name="weight" value="${p.weight ?? ''}" min="20" max="400" /></div>`;
    case 'height': return `<div class="field"><label>Height (cm)</label><input type="number" step="0.1" name="height" value="${p.height ?? ''}" min="80" max="250" /></div>`;
    case 'age': return `<div class="field"><label>Age</label><input type="number" name="age" value="${p.age ?? ''}" min="10" max="110" /></div>`;
    case 'gender': return `<div class="field"><label>Gender</label><select name="gender">${optionsFromMap(GENDER_OPTIONS, p.gender)}</select></div>`;
    case 'activityLevel': return `<div class="field full"><label>Activity level</label><select name="activityLevel">${optionsFromMap(ACTIVITY_OPTIONS, p.activityLevel)}</select></div>`;
    case 'goal': return `<div class="field full"><label>Goal</label><select name="goal">${optionsFromMap(GOAL_OPTIONS, p.goal)}</select></div>`;
    case 'dietPreference': return `<div class="field full"><label>Diet preference</label><select name="dietPreference">${optionsFromMap(DIET_OPTIONS, p.dietPreference)}</select></div>`;
    case 'allergies': return `<div class="field full"><label>Allergies (comma-separated, optional)</label><input type="text" name="allergies" value="${toStr(p.allergies)}" placeholder="e.g. shellfish, peanut" /></div>`;
    case 'medicalNotes': return `<div class="field full"><label>Medical notes (optional)</label><textarea name="medicalNotes">${escapeHTML(p.medicalNotes || '')}</textarea></div>`;
    case 'mealBudget': return `<div class="field"><label>Meal budget</label><select name="mealBudget">${optionsFromMap(BUDGET_OPTIONS, p.mealBudget)}</select></div>`;
    case 'cookingSkill': return `<div class="field"><label>Cooking skill</label><select name="cookingSkill">${optionsFromMap(SKILL_OPTIONS, p.cookingSkill)}</select></div>`;
    case 'mealsPerDay': return `<div class="field"><label>Meals per day</label><input type="number" name="mealsPerDay" value="${p.mealsPerDay || 3}" min="3" max="5" /></div>`;
    case 'favoriteFoods': return `<div class="field full"><label>Favorite foods (optional)</label><input type="text" name="favoriteFoods" value="${toStr(p.favoriteFoods)}" placeholder="e.g. nasi lemak, tofu" /></div>`;
    case 'dislikedFoods': return `<div class="field full"><label>Disliked foods (optional)</label><input type="text" name="dislikedFoods" value="${toStr(p.dislikedFoods)}" placeholder="e.g. okra, blue cheese" /></div>`;
    default: return '';
  }
}

function showOnboardingModal(stepIndex = 0, collected = {}) {
  const profile = { ...Storage.getProfile(), ...collected };
  const step = ONBOARDING_STEPS[stepIndex];
  const isLast = stepIndex === ONBOARDING_STEPS.length - 1;

  openModal(`
    <div class="modal-head"><h3>Welcome! Let's personalize your meal planning.</h3></div>
    <div class="onboarding-steps">${ONBOARDING_STEPS.map((s, i) => `<span class="${i < stepIndex ? 'done' : i === stepIndex ? 'active' : ''}"></span>`).join('')}</div>
    <p class="eyebrow">Step ${stepIndex + 1} of ${ONBOARDING_STEPS.length}</p>
    <form id="onboarding-form">
      <div class="form-grid">${step.fields.map(f => onboardingFieldHTML(f, profile)).join('')}</div>
      <div class="divider"></div>
      <div style="display:flex; justify-content:space-between; gap:10px;">
        <button type="button" class="btn btn-ghost btn-sm" id="onboarding-skip">Skip for now</button>
        <div style="display:flex; gap:10px;">
          ${stepIndex > 0 ? `<button type="button" class="btn btn-ghost btn-sm" id="onboarding-back">Back</button>` : ''}
          <button type="submit" class="btn btn-primary btn-sm">${isLast ? 'Finish' : 'Next'}</button>
        </div>
      </div>
    </form>
  `);

  document.getElementById('onboarding-skip').addEventListener('click', () => {
    Storage.saveMeta({ onboardingDone: true });
    closeModal();
  });
  document.getElementById('onboarding-back')?.addEventListener('click', () => showOnboardingModal(stepIndex - 1, collected));
  document.getElementById('onboarding-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const stepData = {};
    step.fields.forEach(f => {
      if (['allergies', 'favoriteFoods', 'dislikedFoods'].includes(f)) {
        stepData[f] = String(fd.get(f) || '').split(',').map(s => s.trim()).filter(Boolean);
      } else if (['weight', 'height'].includes(f)) {
        stepData[f] = fd.get(f) ? parseFloat(fd.get(f)) : null;
      } else if (['age', 'mealsPerDay'].includes(f)) {
        stepData[f] = fd.get(f) ? parseInt(fd.get(f), 10) : null;
      } else {
        stepData[f] = fd.get(f);
      }
    });
    const merged = { ...collected, ...stepData };
    if (isLast) {
      Storage.saveProfile(merged);
      Storage.saveMealPlan(null);
      Storage.saveMeta({ onboardingDone: true });
      closeModal();
      toast('Your personalized meal planner is ready.', 'success');
      navigate('dashboard');
      if (syncAvailable()) syncAll();
    } else {
      showOnboardingModal(stepIndex + 1, merged);
    }
  });
}

/* ============================== User menu & sync badge ============================== */

function renderUserMenu() {
  const container = document.getElementById('user-menu');
  if (isAuthenticated()) {
    const profile = getUserProfile();
    const initials = (profile.name || '?').slice(0, 1).toUpperCase();
    container.innerHTML = `
      <button class="user-menu-trigger" id="user-menu-trigger">
        <span class="user-avatar">${profile.avatarUrl ? `<img src="${escapeHTML(profile.avatarUrl)}" alt="" />` : initials}</span>
        <span class="um-trigger-name">${escapeHTML(profile.name)}</span>
      </button>
    `;
    container.querySelector('#user-menu-trigger').addEventListener('click', () => toggleUserDropdown(profile));
  } else {
    container.innerHTML = `<button class="user-menu-trigger" id="user-menu-trigger"><span class="user-avatar">${ICONS.profile}</span><span class="um-trigger-name">Guest</span></button>`;
    container.querySelector('#user-menu-trigger').addEventListener('click', () => toggleGuestDropdown());
  }
}

function closeDropdown() { document.getElementById('user-menu-dropdown')?.remove(); }

function toggleUserDropdown(profile) {
  if (document.getElementById('user-menu-dropdown')) { closeDropdown(); return; }
  const dropdown = el(`
    <div class="user-menu-dropdown" id="user-menu-dropdown">
      <div class="um-header">
        <div class="um-name">${escapeHTML(profile.name)}</div>
        <div class="um-email">${escapeHTML(profile.email)}</div>
        <div class="small" style="margin-top:4px;">Signed in with ${escapeHTML(profile.providerLabel)}</div>
      </div>
      <button class="um-item" data-action="profile">${ICONS.profile} My Profile</button>
      <button class="um-item" data-action="sync">${ICONS.progress} Cloud Sync</button>
      <button class="um-item" data-action="export">${ICONS.shopping} Export My Data</button>
      <button class="um-item" data-action="pdf">${ICONS.sparkle} Download PDF</button>
      <button class="um-item" data-action="settings">${ICONS.settings} Settings</button>
      <button class="um-item danger" data-action="signout">${ICONS.close} Sign Out</button>
    </div>
  `);
  document.getElementById('user-menu').appendChild(dropdown);
  dropdown.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    closeDropdown();
    if (action === 'profile') navigate('profile');
    else if (action === 'sync' || action === 'settings') navigate('settings');
    else if (action === 'export') exportJSONFile();
    else if (action === 'pdf') exportCompleteReportPDF();
    else if (action === 'signout') handleSignOut();
  });
  setTimeout(() => document.addEventListener('click', outsideDropdownListener, { once: true, capture: true }), 0);
}

function toggleGuestDropdown() {
  if (document.getElementById('user-menu-dropdown')) { closeDropdown(); return; }
  const cloudNote = isCloudConfigured()
    ? `<button class="um-item" data-action="google">${ICONS.sparkle} Continue with Gmail</button><button class="um-item" data-action="microsoft">${ICONS.sparkle} Continue with Outlook</button>`
    : `<p class="small" style="padding:8px 10px;">Cloud sign-in isn't configured for this deployment.</p>`;
  const dropdown = el(`
    <div class="user-menu-dropdown" id="user-menu-dropdown">
      <div class="um-header"><div class="um-name">Guest</div><div class="um-email">Data lives only in this browser session</div></div>
      ${cloudNote}
      <button class="um-item" data-action="export">${ICONS.shopping} Export My Data</button>
      <button class="um-item" data-action="pdf">${ICONS.sparkle} Download PDF</button>
      <button class="um-item" data-action="settings">${ICONS.settings} Settings</button>
    </div>
  `);
  document.getElementById('user-menu').appendChild(dropdown);
  dropdown.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    closeDropdown();
    if (action === 'google') signInWithGmail().catch(err => toast(err.message, 'error', 5000));
    else if (action === 'microsoft') signInWithOutlook().catch(err => toast(err.message, 'error', 5000));
    else if (action === 'export') exportJSONFile();
    else if (action === 'pdf') exportCompleteReportPDF();
    else if (action === 'settings') navigate('settings');
  });
  setTimeout(() => document.addEventListener('click', outsideDropdownListener, { once: true, capture: true }), 0);
}

function outsideDropdownListener(e) {
  const dropdown = document.getElementById('user-menu-dropdown');
  if (dropdown && !dropdown.contains(e.target) && !e.target.closest('#user-menu-trigger')) closeDropdown();
}

async function handleSignOut() {
  if (!window.confirm('Sign out of this device? Your local data stays on this device and your cloud data is unaffected.')) return;
  try {
    await signOut();
    toast('Signed out.', 'success');
    renderUserMenu();
    updateSyncBadge('idle');
    navigate('dashboard');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function updateSyncBadge(statusOverride) {
  const badge = document.getElementById('sync-badge');
  if (!badge) return;
  const { status } = statusOverride ? { status: statusOverride } : getSyncStatus();

  if (!isAuthenticated() || !isCloudConfigured()) { badge.hidden = true; return; }
  badge.hidden = false;
  badge.className = `sync-badge ${status}`;
  const labels = { idle: 'Not synced yet', syncing: 'Syncing…', synced: 'Synced', error: 'Sync failed', offline: 'Offline' };
  badge.innerHTML = `<span class="sync-dot"></span><span class="sync-label">${labels[status] || status}</span>`;
}

/** True if the guest has anything worth exporting before their session-scoped data is cleared. */
function hasExportableGuestData() {
  const profile = Storage.getProfile();
  const plan = Storage.getMealPlan();
  const list = Storage.getShoppingList();
  const progress = Storage.getProgress();
  return !!(profile.weight || plan?.meals?.length || list.items?.length || progress.weightLog?.length || progress.calorieLog?.length);
}

/**
 * Shows/hides the persistent reminder banner telling guests their data is
 * scoped to this browser session. Re-run it after anything that changes
 * auth state (sign-in, sign-out, entering guest mode).
 */
function renderGuestBanner() {
  const banner = document.getElementById('guest-banner');
  if (!banner) return;
  const show = !isAuthenticated() && Storage.isGuestSessionActive();
  banner.hidden = !show;
  if (!show) { banner.innerHTML = ''; return; }
  banner.innerHTML = `
    <span class="guest-banner-text">You're in a guest session — your data lives only in this browser tab and is cleared when you close it. Export or share it below to keep it, or sign in to save it to an account.</span>
    <div class="guest-banner-actions">
      <button class="btn btn-ghost btn-sm" id="guest-banner-export">Export JSON</button>
      <button class="btn btn-ghost btn-sm" id="guest-banner-pdf">${ICONS.sparkle} Download PDF</button>
    </div>
  `;
  banner.querySelector('#guest-banner-export').addEventListener('click', exportJSONFile);
  banner.querySelector('#guest-banner-pdf').addEventListener('click', () => exportCompleteReportPDF());
}

/**
 * Warns a guest before they leave the tab that their session-scoped data
 * (sessionStorage) is about to be cleared by the browser. Browsers show
 * their own generic confirmation text rather than our custom message, but
 * triggering the native dialog still gives the guest a chance to cancel and
 * export first — the visible guest banner is the more reliable reminder.
 */
function wireGuestExitReminder() {
  window.addEventListener('beforeunload', (e) => {
    if (isAuthenticated() || !Storage.isGuestSessionActive()) return;
    if (!hasExportableGuestData()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

function exportJSONFile() {
  const payload = Storage.exportAll();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'health-meal-planner-data.json';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('Data exported.', 'success');
}

function exportCSVFile() {
  const progress = Storage.getProgress();
  const rows = [['type', 'date', 'value']];
  (progress.weightLog || []).forEach(e => rows.push(['weight_kg', e.date, e.weight]));
  (progress.calorieLog || []).forEach(e => rows.push(['calories_kcal', e.date, e.kcal]));
  Object.entries(progress.waterLog || {}).forEach(([date, cups]) => rows.push(['water_cups', date, cups]));
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'health-meal-planner-progress.csv';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('Progress exported as CSV.', 'success');
}



function renderDashboard() {
  const container = document.getElementById('view-dashboard');
  const profile = Storage.getProfile();
  const result = calcFullProfile(profile);

  if (!result) {
    container.innerHTML = `<div class="empty-state">${ICONS.empty}
      <p>Welcome! Set up your profile to unlock your personalized dashboard, calorie targets and meal plan.</p>
      <button class="btn btn-primary" onclick="document.querySelector('[data-nav=profile]').click()">Set up my profile</button>
    </div>`;
    return;
  }

  const consumed = getTodayCalories();
  const remaining = Math.max(0, result.calorieTarget - consumed);
  const ringPct = Math.min(100, Math.round((consumed / result.calorieTarget) * 100));

  let plan = Storage.getMealPlan();
  if (!plan || !plan.meals?.length) { plan = buildLocalMealPlan(profile, result); if (plan.meals.length) Storage.saveMealPlan(plan); }
  const mealsForDisplay = plan.meals || [];

  const waterCups = getTodayWaterCups();
  const waterTargetCups = Math.round(result.water / 250);

  container.innerHTML = `
    <div class="grid grid-dash">
      <div class="g-12" style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:-8px;">
        <div>
          <h3 style="margin:0;">${greeting()}${isAuthenticated() ? `, ${escapeHTML(getUserProfile().name)}` : ''}</h3>
          <p class="small" style="margin:0;">${isAuthenticated() ? (syncAvailable() ? 'Your plan is synced across your devices.' : 'Signed in — cloud sync unavailable right now.') : 'Using this device only — sign in to sync across devices.'}</p>
        </div>
        <button class="btn btn-ghost btn-sm" id="dash-pdf-btn">${ICONS.sparkle} Download PDF</button>
      </div>

      <div class="g-4 card" style="display:flex; flex-direction:column; align-items:center;">
        <div class="eyebrow">Today's calories</div>
        ${ringSVG(ringPct, `${fmt(consumed)}`, `of ${fmt(result.calorieTarget)} kcal`)}
        <div class="chat-input-row" style="width:100%; margin-top:14px;">
          <input type="number" id="dash-log-cal" placeholder="Log calories eaten" />
          <button class="btn btn-primary btn-sm" id="dash-log-cal-btn">Log</button>
        </div>
      </div>

      <div class="g-4 grid" style="grid-template-columns:1fr; gap:var(--space-4);">
        <div class="card stat-card"><div class="stat-label">Remaining today</div><div class="stat-value">${fmt(remaining)}</div><div class="small">kcal left</div></div>
        <div class="card stat-card"><div class="stat-label">BMI</div><div class="stat-value">${result.bmi ?? '—'}</div><div class="small">${escapeHTML(result.bmiCat.label)}</div></div>
        <div class="card stat-card"><div class="stat-label">Goal status</div><div class="stat-value" style="font-size:1.1rem;">${escapeHTML(result.goalInfo.label)}</div><div class="small">${escapeHTML(result.goalInfo.note)}</div></div>
      </div>

      <div class="g-4 card">
        <div class="eyebrow">${ICONS.water} Water reminder</div>
        <h3 style="margin-top:4px;">${waterCups} / ${waterTargetCups} cups</h3>
        <div class="macro-bar" style="margin:10px 0;"><span style="width:${Math.min(100, Math.round((waterCups / waterTargetCups) * 100))}%; background:#4C86C6;"></span></div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-ghost btn-sm" id="water-minus">−</button>
          <button class="btn btn-primary btn-sm" id="water-plus">+ Add cup</button>
        </div>
      </div>

      <div class="g-12 card">
        <div class="card-title"><h3>Today's meals</h3><button class="btn btn-ghost btn-sm" data-nav="planner" id="dash-view-planner">Open planner</button></div>
        <div class="grid" style="grid-template-columns:repeat(auto-fill, minmax(220px, 1fr));">
          ${mealsForDisplay.length ? mealsForDisplay.map(m => `
            <div class="meal-card">
              <div class="eyebrow">${escapeHTML(m.slot)}</div>
              <h4>${escapeHTML(m.recipe.name)}</h4>
              <div class="nutrient-row"><span><b>${fmt(m.nutrition.kcal)}</b> kcal</span><span><b>${fmt(m.nutrition.protein, 1)}g</b> protein</span></div>
            </div>
          `).join('') : `<p class="small">Recipe database still loading — check back in a moment or reload the page.</p>`}
        </div>
      </div>

      <div class="g-12 card">
        <div class="card-title"><h3>Macro progress (plan vs target)</h3></div>
        ${macroCompareRow('Protein', mealsForDisplay.reduce((s, m) => s + m.nutrition.protein, 0), result.macros.proteinG, 'var(--primary)')}
        ${macroCompareRow('Fat', mealsForDisplay.reduce((s, m) => s + m.nutrition.fat, 0), result.macros.fatG, 'var(--accent)')}
        ${macroCompareRow('Carbs', mealsForDisplay.reduce((s, m) => s + m.nutrition.carbs, 0), result.macros.carbG, 'var(--berry)')}
        ${macroCompareRow('Fiber', mealsForDisplay.reduce((s, m) => s + m.nutrition.fiber, 0), result.macros.fiberG, 'var(--success)')}
      </div>
    </div>
  `;

  container.querySelector('#dash-log-cal-btn').addEventListener('click', () => {
    const val = parseInt(container.querySelector('#dash-log-cal').value, 10);
    if (!val || val <= 0) { toast('Enter a valid calorie amount.', 'error'); return; }
    logCalories(consumed + val);
    toast('Calories logged.', 'success');
    renderDashboard();
  });
  container.querySelector('#water-plus').addEventListener('click', () => { addWaterCup(1); renderDashboard(); });
  container.querySelector('#water-minus').addEventListener('click', () => { addWaterCup(-1); renderDashboard(); });
  container.querySelector('#dash-view-planner').addEventListener('click', () => navigate('planner'));
  container.querySelector('#dash-pdf-btn').addEventListener('click', () => exportCompleteReportPDF());
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function ringSVG(pct, bigText, smallText) {
  const r = 70, c = 2 * Math.PI * r;
  const offset = c - (Math.min(100, pct) / 100) * c;
  return `
    <div class="plate-ring">
      <svg viewBox="0 0 170 170">
        <circle class="track" cx="85" cy="85" r="${r}" />
        <circle class="prog" cx="85" cy="85" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${offset}" />
      </svg>
      <div class="center"><div class="num">${bigText}</div><div class="lbl">${smallText}</div></div>
    </div>`;
}

function macroCompareRow(label, actual, target, color) {
  const pct = target ? Math.min(100, Math.round((actual / target) * 100)) : 0;
  return `
    <div style="margin-bottom:12px;">
      <div style="display:flex; justify-content:space-between; font-size:0.8rem; margin-bottom:4px;">
        <span>${escapeHTML(label)}</span><span class="mono">${fmt(actual, 1)}g / ${fmt(target, 1)}g</span>
      </div>
      <div class="macro-bar"><span style="width:${pct}%; background:${color};"></span></div>
    </div>`;
}

/* ============================== Profile ============================== */

const ACTIVITY_OPTIONS = Object.fromEntries(Object.entries(ACTIVITY_FACTORS).map(([k, v]) => [k, v.label]));
const GOAL_OPTIONS = Object.fromEntries(Object.entries(GOAL_ADJUSTMENTS).map(([k, v]) => [k, v.label]));
const DIET_OPTIONS = { 'no-preference': 'No preference', vegetarian: 'Vegetarian', vegan: 'Vegan', halal: 'Halal', pescatarian: 'Pescatarian', 'gluten-free': 'Gluten-free', keto: 'Keto' };
const BUDGET_OPTIONS = { low: 'Low (budget-friendly)', medium: 'Medium', high: 'High (flexible)' };
const SKILL_OPTIONS = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
const GENDER_OPTIONS = { female: 'Female', male: 'Male', other: 'Other / prefer not to say' };

function renderProfileView() {
  const container = document.getElementById('view-profile');
  const p = Storage.getProfile();

  container.innerHTML = `
    <form class="card" id="profile-form">
      <div class="card-title"><h3>Health details</h3></div>
      <div class="form-grid">
        <div class="field"><label>Weight (kg)</label><input type="number" step="0.1" name="weight" value="${p.weight ?? ''}" required min="20" max="400" /></div>
        <div class="field"><label>Height (cm)</label><input type="number" step="0.1" name="height" value="${p.height ?? ''}" required min="80" max="250" /></div>
        <div class="field"><label>Age</label><input type="number" name="age" value="${p.age ?? ''}" required min="10" max="110" /></div>
        <div class="field"><label>Gender</label><select name="gender">${optionsFromMap(GENDER_OPTIONS, p.gender)}</select></div>
        <div class="field"><label>Activity level</label><select name="activityLevel">${optionsFromMap(ACTIVITY_OPTIONS, p.activityLevel)}</select></div>
        <div class="field"><label>Goal</label><select name="goal">${optionsFromMap(GOAL_OPTIONS, p.goal)}</select></div>
        <div class="field"><label>Diet preference</label><select name="dietPreference">${optionsFromMap(DIET_OPTIONS, p.dietPreference)}</select></div>
        <div class="field"><label>Allergies (comma-separated)</label><input type="text" name="allergies" value="${escapeHTML((p.allergies || []).join(', '))}" placeholder="e.g. shellfish, peanut" /></div>
        <div class="field full"><label>Medical notes</label><textarea name="medicalNotes" placeholder="e.g. diabetic, hypertension — optional">${escapeHTML(p.medicalNotes || '')}</textarea></div>
      </div>

      <div class="divider"></div>
      <div class="card-title"><h3>Lifestyle</h3></div>
      <div class="form-grid">
        <div class="field"><label>Meal budget</label><select name="mealBudget">${optionsFromMap(BUDGET_OPTIONS, p.mealBudget)}</select></div>
        <div class="field"><label>Cooking skill</label><select name="cookingSkill">${optionsFromMap(SKILL_OPTIONS, p.cookingSkill)}</select></div>
        <div class="field"><label>Meals per day</label><input type="number" name="mealsPerDay" value="${p.mealsPerDay || 3}" min="3" max="5" /></div>
        <div class="field"><label>Favorite foods (comma-separated)</label><input type="text" name="favoriteFoods" value="${escapeHTML((p.favoriteFoods || []).join(', '))}" placeholder="e.g. nasi lemak, tofu" /></div>
        <div class="field full"><label>Disliked foods (comma-separated)</label><input type="text" name="dislikedFoods" value="${escapeHTML((p.dislikedFoods || []).join(', '))}" placeholder="e.g. okra, blue cheese" /></div>
      </div>

      <div class="divider"></div>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn btn-primary" type="submit">${ICONS.profile} Save profile</button>
        <button class="btn btn-ghost" type="button" id="profile-pdf-btn">${ICONS.sparkle} Download PDF</button>
      </div>
    </form>
  `;

  container.querySelector('#profile-pdf-btn').addEventListener('click', () => exportProfilePDF());

  container.querySelector('#profile-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const toList = (str) => str.split(',').map(s => s.trim()).filter(Boolean);
    const profile = {
      weight: parseFloat(fd.get('weight')),
      height: parseFloat(fd.get('height')),
      age: parseInt(fd.get('age'), 10),
      gender: fd.get('gender'),
      activityLevel: fd.get('activityLevel'),
      goal: fd.get('goal'),
      dietPreference: fd.get('dietPreference'),
      allergies: toList(fd.get('allergies') || ''),
      medicalNotes: fd.get('medicalNotes') || '',
      mealBudget: fd.get('mealBudget'),
      cookingSkill: fd.get('cookingSkill'),
      mealsPerDay: Math.min(5, Math.max(3, parseInt(fd.get('mealsPerDay'), 10) || 3)),
      favoriteFoods: toList(fd.get('favoriteFoods') || ''),
      dislikedFoods: toList(fd.get('dislikedFoods') || ''),
    };
    if (!profile.weight || !profile.height || !profile.age) { toast('Please fill in weight, height and age.', 'error'); return; }
    Storage.saveProfile(profile);
    Storage.saveMealPlan(null); // invalidate cached plan so it regenerates for the new profile
    toast('Profile saved.', 'success');
    navigate('dashboard');
    if (syncAvailable()) syncAll();
  });
}

/* ============================== Settings ============================== */

function renderSettingsView() {
  const container = document.getElementById('view-settings');
  const s = Storage.getSettings();
  const providerOptions = Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.label]));
  const authed = isAuthenticated();
  const profile = authed ? getUserProfile() : null;
  const lastSynced = Storage.getLastSyncedAt();

  container.innerHTML = `
    <div class="grid grid-dash">

      <div class="g-6 card">
        <div class="card-title"><h3>Account</h3></div>
        ${authed ? `
          <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
            <span class="user-avatar" style="width:44px; height:44px; font-size:1rem;">${profile.avatarUrl ? `<img src="${escapeHTML(profile.avatarUrl)}" alt="" />` : escapeHTML(profile.name.slice(0, 1).toUpperCase())}</span>
            <div><div style="font-weight:700;">${escapeHTML(profile.name)}</div><div class="small">${escapeHTML(profile.email)}</div></div>
          </div>
          <div class="small">Signed in with <b>${escapeHTML(profile.providerLabel)}</b></div>
          <button class="btn btn-danger btn-sm" id="settings-signout-btn" style="margin-top:12px;">Sign Out</button>
        ` : `
          <p class="small">You're using this app as a guest for this browser session only. Sign in to sync your plans and progress across devices — and to keep your data beyond this session.</p>
          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:8px;">
            <button class="btn btn-ghost btn-sm" id="settings-google-btn" ${isCloudConfigured() ? '' : 'disabled'}>Continue with Gmail</button>
            <button class="btn btn-ghost btn-sm" id="settings-microsoft-btn" ${isCloudConfigured() ? '' : 'disabled'}>Continue with Outlook</button>
          </div>
          ${!isCloudConfigured() ? `<p class="small" style="margin-top:8px;">Cloud sign-in isn't configured for this deployment yet. See README → Authentication Setup.</p>` : ''}
        `}
      </div>

      <div class="g-6 card">
        <div class="card-title"><h3>Cloud Sync</h3></div>
        ${authed && isCloudConfigured() ? `
          <div class="nutrient-row" style="margin-bottom:10px;"><span>Status:</span><span id="settings-sync-badge-slot"></span></div>
          <p class="small">Last synchronized: ${lastSynced ? new Date(lastSynced).toLocaleString() : 'Never'}</p>
          <button class="btn btn-primary btn-sm" id="sync-now-btn">${ICONS.sparkle} Sync Now</button>
        ` : `<p class="small">${authed ? 'Cloud sync is not configured for this deployment.' : 'Sign in above to enable cloud sync.'}</p>`}
      </div>

      <div class="g-6 card">
        <div class="card-title"><h3>Appearance</h3></div>
        <div class="form-grid">
          <div class="field"><label>Theme</label><select id="set-theme">${optionsFromMap({ light: 'Light', dark: 'Dark' }, document.documentElement.getAttribute('data-theme'))}</select></div>
          <div class="field"><label>Units</label><select id="set-units">${optionsFromMap({ metric: 'Metric (kg/cm)', imperial: 'Imperial (lb/in) — display only' }, s.units)}</select></div>
          <div class="field"><label>Language</label><select id="set-lang">${optionsFromMap({ en: 'English', ms: 'Bahasa Malaysia (coming soon)' }, s.language)}</select></div>
        </div>
      </div>

      <div class="g-6 card">
        <div class="card-title"><h3>AI Provider</h3></div>
        <p class="small">Bring your own free API key. Nothing is sent anywhere except the provider you choose, directly from your browser. Your key stays in this browser only — it is never synced to the cloud.</p>
        <div class="form-grid">
          <div class="field full"><label>Provider</label><select id="set-provider">${optionsFromMap(providerOptions, s.aiProvider)}</select></div>
          <div class="field full"><label>Model</label><select id="set-model"></select></div>
          <div class="field full"><label>API key</label><input type="password" id="set-apikey" value="${escapeHTML(s.apiKey || '')}" placeholder="Paste your API key" autocomplete="off" /></div>
        </div>
        <p class="small">Get a free key: <a id="provider-key-link" href="#" target="_blank" rel="noopener"></a></p>
        <button class="btn btn-primary btn-sm" id="save-ai-btn">Save AI settings</button>
      </div>

      <div class="g-12 card">
        <div class="card-title"><h3>Your data</h3></div>
        <p class="small">${authed ? 'Your data is stored on this device and, when cloud sync is available, in your account.' : 'All your data stays in this browser tab\'s session storage. Nothing is uploaded anywhere unless you sign in, and it is cleared automatically once you close this browser — export or share it below to keep a copy.'}</p>
        <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px;">
          <button class="btn btn-ghost" id="export-json-btn">Export JSON</button>
          <button class="btn btn-ghost" id="export-csv-btn">Export CSV</button>
          <button class="btn btn-ghost" id="download-pdf-btn">${ICONS.sparkle} Download PDF Report</button>
          <label class="btn btn-ghost" for="import-all-input" style="cursor:pointer;">Import Data</label>
          <input type="file" id="import-all-input" accept="application/json" class="hidden" />
        </div>
        <div class="divider"></div>
        <p class="small" style="margin-bottom:8px;"><b>Destructive actions</b> — these cannot be undone.</p>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <button class="btn btn-danger" id="delete-local-btn">Delete Local Data</button>
          <button class="btn btn-danger" id="delete-cloud-btn" ${authed && isCloudConfigured() ? '' : 'disabled'}>Delete Cloud Data</button>
        </div>
        ${authed ? `<p class="small" style="margin-top:10px;">Full account deletion (removing your sign-in identity itself) isn't something this static, backend-less app can safely perform from the browser — see README → Delete Account for the supported workflow via your Supabase project.</p>` : ''}
      </div>

      <div class="g-12 card">
        <div class="card-title"><h3>Privacy</h3></div>
        <p class="small"><b>Guest users:</b> your data is stored only in this browser tab's session storage — nothing leaves your device, and it is cleared automatically when you close the browser. Export, download a PDF, or share your data before then if you want to keep it.</p>
        <p class="small"><b>Signed-in users:</b> your data is additionally synchronized to a cloud database (Supabase), protected so only your account can read or write it.</p>
        <p class="small"><b>AI features:</b> when you use the Recipe Generator, AI Meal Plan, or AI Coach, relevant profile details (e.g. weight, goals, allergies) are sent to the AI provider you configured, directly from your browser, to generate a response. This data is not "100% private" once sent to that third-party provider — review your chosen provider's own privacy policy.</p>
      </div>
    </div>
  `;

  const providerSelect = container.querySelector('#set-provider');
  const modelSelect = container.querySelector('#set-model');
  const keyLink = container.querySelector('#provider-key-link');

  function refreshModelOptions() {
    const providerInfo = PROVIDERS[providerSelect.value];
    modelSelect.innerHTML = providerInfo.modelOptions.map(m => `<option value="${escapeHTML(m)}" ${m === (s.aiModel || providerInfo.defaultModel) ? 'selected' : ''}>${escapeHTML(m)}</option>`).join('');
    keyLink.href = providerInfo.keyUrl;
    keyLink.textContent = providerInfo.keyUrl;
  }
  providerSelect.addEventListener('change', refreshModelOptions);
  refreshModelOptions();

  container.querySelector('#set-theme').addEventListener('change', (e) => { applyTheme(e.target.value); Storage.saveSettings({ theme: e.target.value }); });
  container.querySelector('#set-units').addEventListener('change', (e) => Storage.saveSettings({ units: e.target.value }));
  container.querySelector('#set-lang').addEventListener('change', (e) => Storage.saveSettings({ language: e.target.value }));

  container.querySelector('#save-ai-btn').addEventListener('click', () => {
    Storage.saveSettings({
      aiProvider: providerSelect.value,
      aiModel: modelSelect.value,
      apiKey: container.querySelector('#set-apikey').value.trim(),
    });
    toast('AI settings saved.', 'success');
  });

  container.querySelector('#settings-google-btn')?.addEventListener('click', () => signInWithGmail().catch(err => toast(err.message, 'error', 5000)));
  container.querySelector('#settings-microsoft-btn')?.addEventListener('click', () => signInWithOutlook().catch(err => toast(err.message, 'error', 5000)));
  container.querySelector('#settings-signout-btn')?.addEventListener('click', handleSignOut);

  container.querySelector('#sync-now-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const result = await syncAll();
    btn.disabled = false;
    if (result.ok) { toast('Sync complete.', 'success'); renderSettingsView(); }
    else if (result.reason === 'offline') toast('You are offline — will sync automatically once reconnected.', 'default', 4000);
    else toast('Sync failed. Please try again.', 'error');
  });
  if (authed && isCloudConfigured()) {
    const badgeSlot = container.querySelector('#settings-sync-badge-slot');
    const { status } = getSyncStatus();
    badgeSlot.innerHTML = `<span class="sync-badge ${status}"><span class="sync-dot"></span><span class="sync-label">${status}</span></span>`;
  }

  container.querySelector('#export-json-btn').addEventListener('click', exportJSONFile);
  container.querySelector('#export-csv-btn').addEventListener('click', exportCSVFile);
  container.querySelector('#download-pdf-btn').addEventListener('click', () => exportCompleteReportPDF());

  container.querySelector('#import-all-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      showImportPreviewModal(payload);
    } catch (err) {
      toast('That file could not be read as valid JSON.', 'error');
    }
    e.target.value = '';
  });

  container.querySelector('#delete-local-btn').addEventListener('click', () => {
    if (!window.confirm('This will permanently delete your profile, plans, progress and settings from THIS DEVICE only. Your cloud data (if any) is not affected. Continue?')) return;
    Storage.clearLocalData();
    toast('Local data deleted.', 'success');
    setTimeout(() => window.location.reload(), 900);
  });

  container.querySelector('#delete-cloud-btn').addEventListener('click', async () => {
    if (!window.confirm('This will permanently delete all of your data from the cloud database. Your local data on this device is not affected. Continue?')) return;
    try {
      await deleteCloudData();
      toast('Cloud data deleted.', 'success');
      renderSettingsView();
    } catch (err) {
      toast(err.message || 'Could not delete cloud data.', 'error');
    }
  });
}

function showImportPreviewModal(payload) {
  const preview = Storage.previewImport(payload);
  if (!preview.ok) { toast(preview.error, 'error', 5000); return; }
  const s = preview.summary;
  openModal(`
    <div class="modal-head"><h3>Import data</h3></div>
    <p class="small">Here's what's in this file. Choose how to apply it — merging is the safest option and never silently overwrites your existing data.</p>
    <ul class="small">
      ${s.hasProfile ? '<li>Profile information</li>' : ''}
      ${s.hasMealPlan ? '<li>A saved meal plan</li>' : ''}
      ${s.hasShopping ? `<li>${s.shoppingItemCount} shopping list item(s)</li>` : ''}
      ${s.hasProgress ? `<li>${s.weightEntryCount} weight entr${s.weightEntryCount === 1 ? 'y' : 'ies'}, ${s.calorieEntryCount} calorie entr${s.calorieEntryCount === 1 ? 'y' : 'ies'}</li>` : ''}
      ${s.hasSettings ? '<li>App settings (excluding any API key)</li>' : ''}
    </ul>
    ${s.exportedAt ? `<p class="small">Exported: ${new Date(s.exportedAt).toLocaleString()}</p>` : ''}
    <div class="conflict-options">
      <button class="btn btn-primary" data-mode="merge">Merge with existing data (recommended)</button>
      <button class="btn btn-danger" data-mode="replace">Replace existing data</button>
      <button class="btn btn-ghost" id="import-cancel-btn">Cancel</button>
    </div>
  `);
  document.getElementById('import-cancel-btn').addEventListener('click', closeModal);
  document.querySelectorAll('[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === 'replace' && !window.confirm('Replace mode will overwrite the sections included in this file. Continue?')) return;
      const result = Storage.importAll(payload, mode);
      closeModal();
      if (result.ok) { toast('Data imported successfully.', 'success'); navigate('dashboard'); if (syncAvailable()) syncAll(); }
      else toast(`Import failed: ${result.error}`, 'error');
    });
  });
}

/* ============================== AI Coach ============================== */

function renderCoachView() {
  const container = document.getElementById('view-coach');
  const suggestions = [
    'Can I replace rice with quinoa?',
    'Suggest a healthy Malaysian breakfast',
    'How much protein do I need?',
    'Suggest meals for diabetics',
    'Suggest meals for weight loss',
  ];

  container.innerHTML = `
    <div class="card">
      ${!hasAPIKey() ? `<p class="small" style="margin-bottom:12px;">Add a free AI provider API key in <a href="#" id="coach-goto-settings">Settings</a> to chat with the AI Coach.</p>` : ''}
      <div class="suggest-row">${suggestions.map(s => `<button class="chip" data-suggest="${escapeHTML(s)}">${escapeHTML(s)}</button>`).join('')}</div>
      <div class="chat-window" id="chat-window"></div>
      <div class="chat-input-row">
        <input type="text" id="chat-input" placeholder="Ask the AI Coach anything about nutrition…" />
        <button class="btn btn-primary" id="chat-send-btn">${ICONS.send}</button>
      </div>
    </div>
  `;

  container.querySelector('#coach-goto-settings')?.addEventListener('click', (e) => { e.preventDefault(); navigate('settings'); });

  const chatWindow = container.querySelector('#chat-window');
  const log = Storage.getChatLog();
  log.forEach(m => appendMessage(chatWindow, m.role, m.content));
  chatWindow.scrollTop = chatWindow.scrollHeight;

  container.querySelectorAll('[data-suggest]').forEach(btn => {
    btn.addEventListener('click', () => sendChat(container, btn.dataset.suggest));
  });
  container.querySelector('#chat-send-btn').addEventListener('click', () => {
    const input = container.querySelector('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendChat(container, text);
  });
  container.querySelector('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') container.querySelector('#chat-send-btn').click();
  });
}

function appendMessage(chatWindow, role, content, isError = false) {
  const div = document.createElement('div');
  div.className = `msg ${role === 'user' ? 'user' : 'bot'} ${isError ? 'error' : ''}`.trim();
  div.textContent = content;
  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return div;
}

async function sendChat(container, text) {
  const chatWindow = container.querySelector('#chat-window');
  const profile = Storage.getProfile();
  let log = Storage.getChatLog();

  appendMessage(chatWindow, 'user', text);
  log.push({ role: 'user', content: text });
  Storage.saveChatLog(log);

  if (!hasAPIKey()) {
    appendMessage(chatWindow, 'assistant', 'Add a free AI provider API key in Settings to unlock the AI Coach chat.', true);
    return;
  }

  const thinkingEl = appendMessage(chatWindow, 'assistant', 'Thinking…');
  try {
    const reply = await coachReply(text, profile, log);
    thinkingEl.textContent = reply;
    log = Storage.getChatLog();
    log.push({ role: 'assistant', content: reply });
    Storage.saveChatLog(log);
  } catch (err) {
    thinkingEl.textContent = err.message || 'Something went wrong reaching the AI provider.';
    thinkingEl.classList.add('error');
  }
}

/* ============================== Mobile nav ============================== */

/** Injects icon SVGs + labels into nav buttons (kept out of index.html so icons live in one JS module). */
function initNavIcons() {
  document.querySelectorAll('.nav-btn[data-icon]').forEach(btn => {
    const icon = ICONS[btn.dataset.icon] || '';
    btn.innerHTML = `${icon}<span>${escapeHTML(btn.dataset.label || '')}</span>`;
  });
  document.querySelectorAll('.tabbar button[data-icon]').forEach(btn => {
    const icon = ICONS[btn.dataset.icon] || '';
    const label = (btn.getAttribute('aria-label') || '').split(' ')[0];
    btn.innerHTML = `${icon}<span>${escapeHTML(label)}</span>`;
  });
  const menuBtn = document.getElementById('menu-btn');
  if (menuBtn) menuBtn.innerHTML = ICONS.menu;
}

function initMobileNav() {
  const sidebar = document.getElementById('sidebar');
  const menuBtn = document.getElementById('menu-btn');
  menuBtn?.addEventListener('click', () => {
    sidebar.classList.add('open');
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.id = 'sidebar-scrim';
    scrim.addEventListener('click', () => { sidebar.classList.remove('open'); scrim.remove(); });
    document.body.appendChild(scrim);
  });
}

/* ============================== Bootstrap ============================== */

async function initApp() {
  initNavIcons();
  initTheme();
  initMobileNav();
  // Point Storage at the session-scoped backend as early as possible if this
  // tab already has a guest session running (e.g. a page refresh) — must
  // happen before runMigrations()/loadAppData() touch anything. Wrapped so a
  // storage-access failure here can never abort the rest of startup.
  try { if (Storage.isGuestSessionActive()) Storage.enterGuestSession(); }
  catch (err) { console.error('[app] guest session bootstrap check failed', err); }
  Storage.runMigrations();

  registerView('dashboard', renderDashboard);
  registerView('profile', renderProfileView);
  registerView('calculator', renderCalculatorView);
  registerView('planner', renderPlannerView);
  registerView('recipes', renderRecipesView);
  registerView('shopping', renderShoppingView);
  registerView('progress', renderProgressView);
  registerView('coach', renderCoachView);
  registerView('settings', renderSettingsView);

  const dataPromise = loadAppData().catch(() => {
    toast('Some data failed to load. Functionality may be limited until you reload.', 'error', 5000);
  });

  await initializeAuth();
  wireAutoSync();
  wireGuestExitReminder();
  onSyncStatusChange(() => updateSyncBadge());
  listenToAuthChanges(async (event) => {
    if (event === 'SIGNED_IN') {
      renderUserMenu();
      updateSyncBadge();
      await handlePostAuth();
      renderGuestBanner();
      if (!document.getElementById('view-dashboard').hasAttribute('hidden')) renderDashboard();
    } else if (event === 'SIGNED_OUT') {
      renderUserMenu();
      updateSyncBadge('idle');
      renderGuestBanner();
    }
  });

  await dataPromise;
  await decideInitialScreen();

  renderUserMenu();
  updateSyncBadge();
  renderGuestBanner();
  initRouter('dashboard');

  if (isAuthenticated()) {
    await handlePostAuth();
    renderGuestBanner();
    renderDashboard();
  }

  window.addEventListener('online', () => toast('Back online.', 'success'));
  window.addEventListener('offline', () => toast('You are offline — locally stored data and plans still work.', 'default', 4000));
}

document.addEventListener('DOMContentLoaded', initApp);
