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
import { ICONS, escapeHTML, fmt, toast, optionsFromMap } from './ui.js';
import { initRouter, registerView, navigate } from './router.js';
import { loadAppData } from './data.js';
import { renderCalculatorView } from './calorie.js';
import { renderPlannerView, renderRecipesView, buildLocalMealPlan } from './recipes.js';
import { renderShoppingView } from './shopping.js';
import { renderProgressView, getTodayCalories, getTodayWaterCups, addWaterCup, logCalories } from './progress.js';

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

/* ============================== Dashboard ============================== */

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
      <button class="btn btn-primary" type="submit">${ICONS.profile} Save profile</button>
    </form>
  `;

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
  });
}

/* ============================== Settings ============================== */

function renderSettingsView() {
  const container = document.getElementById('view-settings');
  const s = Storage.getSettings();
  const providerOptions = Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.label]));

  container.innerHTML = `
    <div class="grid grid-dash">
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
        <p class="small">Bring your own free API key. Nothing is sent anywhere except the provider you choose, directly from your browser.</p>
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
        <p class="small">All your data stays on this device in your browser's local storage. Nothing is uploaded anywhere.</p>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <button class="btn btn-ghost" id="export-all-btn">Export all data</button>
          <label class="btn btn-ghost" for="import-all-input" style="cursor:pointer;">Import data</label>
          <input type="file" id="import-all-input" accept="application/json" class="hidden" />
          <button class="btn btn-danger" id="clear-all-btn">Clear all data</button>
        </div>
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

  container.querySelector('#export-all-btn').addEventListener('click', () => {
    const payload = Storage.exportAll();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'health-meal-planner-data.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('Data exported.', 'success');
  });

  container.querySelector('#import-all-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const result = Storage.importAll(payload);
      if (result.ok) { toast('Data imported successfully.', 'success'); navigate('dashboard'); }
      else toast(`Import failed: ${result.error}`, 'error');
    } catch (err) {
      toast('That file could not be read as valid JSON.', 'error');
    }
    e.target.value = '';
  });

  container.querySelector('#clear-all-btn').addEventListener('click', () => {
    if (!window.confirm('This will permanently delete all your profile, plans, progress and settings from this device. Continue?')) return;
    Storage.clearAll();
    toast('All data cleared.', 'success');
    setTimeout(() => window.location.reload(), 900);
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

  registerView('dashboard', renderDashboard);
  registerView('profile', renderProfileView);
  registerView('calculator', renderCalculatorView);
  registerView('planner', renderPlannerView);
  registerView('recipes', renderRecipesView);
  registerView('shopping', renderShoppingView);
  registerView('progress', renderProgressView);
  registerView('coach', renderCoachView);
  registerView('settings', renderSettingsView);

  try {
    await loadAppData();
  } catch (e) {
    toast('Some data failed to load. Functionality may be limited until you reload.', 'error', 5000);
  }

  initRouter('dashboard');

  window.addEventListener('online', () => toast('Back online.', 'success'));
  window.addEventListener('offline', () => toast('You are offline — locally stored data and plans still work.', 'default', 4000));
}

document.addEventListener('DOMContentLoaded', initApp);
