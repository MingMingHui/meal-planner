/**
 * router.js
 * ----------------------------------------------------------------------------
 * Purpose: Minimal hash-based router for the single-page app. Shows/hides
 *          .view sections, updates the active state of sidebar/tab-bar nav
 *          buttons, and calls each view's registered onShow callback so it
 *          can (re)render itself with fresh data.
 * Inputs:  A map of viewId -> onShow callback, registered via registerView().
 * Outputs: DOM visibility changes; no return values.
 * Depends on: ui.js is not required; operates directly on the DOM.
 * ----------------------------------------------------------------------------
 */

const views = new Map(); // id -> { onShow }
let currentView = null;

const VIEW_TITLES = {
  dashboard: ['Dashboard', "Today's overview at a glance"],
  profile: ['Profile', 'Tell us about yourself'],
  calculator: ['Calorie Calculator', 'The science behind your numbers'],
  planner: ['Meal Planner', 'Your personalized daily meals'],
  recipes: ['Recipe Generator', 'AI-crafted recipes for your goals'],
  shopping: ['Shopping List', 'Grouped and ready to check off'],
  progress: ['Progress Tracker', 'Weight, calories and milestones'],
  coach: ['AI Coach', 'Ask anything about nutrition'],
  settings: ['Settings', 'Theme, units, AI provider & data'],
};

export function registerView(id, onShow) {
  views.set(id, { onShow });
}

export function navigate(viewId) {
  if (!views.has(viewId)) return;
  document.querySelectorAll('.view').forEach(v => v.toggleAttribute('hidden', v.dataset.view !== viewId));
  document.querySelectorAll('.nav-btn, .tabbar button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.nav === viewId);
  });
  const [title, sub] = VIEW_TITLES[viewId] || [viewId, ''];
  const titleEl = document.getElementById('topbar-title');
  const subEl = document.getElementById('topbar-sub');
  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = sub;

  currentView = viewId;
  window.location.hash = viewId;
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-scrim')?.remove();

  const view = views.get(viewId);
  if (view && typeof view.onShow === 'function') view.onShow();

  const main = document.querySelector('.main');
  if (main) main.scrollTop = 0;
}

export function getCurrentView() { return currentView; }

export function initRouter(defaultView = 'dashboard') {
  document.querySelectorAll('[data-nav]').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.nav));
  });
  const fromHash = window.location.hash.replace('#', '');
  navigate(views.has(fromHash) ? fromHash : defaultView);
}
