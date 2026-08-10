/**
 * storage.js
 * ----------------------------------------------------------------------------
 * Purpose:   Single abstraction over window.localStorage for the whole app.
 *            Every other module reads/writes app data through this file so
 *            the storage backend could be swapped later without touching
 *            business logic.
 * Inputs:    Plain JS values (objects/arrays/strings) passed by callers.
 * Outputs:   Parsed JS values read back from localStorage, or sane defaults.
 * Depends on: nothing (pure browser API).
 * ----------------------------------------------------------------------------
 */

const NS = 'hmpa'; // health-meal-planning-agent namespace, avoids key collisions

const KEYS = {
  profile:   `${NS}:profile`,
  settings:  `${NS}:settings`,
  mealPlan:  `${NS}:mealPlan`,
  shopping:  `${NS}:shopping`,
  progress:  `${NS}:progress`,
  chatLog:   `${NS}:chatLog`,
  recipeLog: `${NS}:recipeLog`,
};

function isStorageAvailable() {
  try {
    const t = '__hmpa_test__';
    localStorage.setItem(t, '1');
    localStorage.removeItem(t);
    return true;
  } catch (e) {
    return false;
  }
}

const STORAGE_OK = isStorageAvailable();
/** In-memory fallback used only if localStorage is blocked (e.g. private mode edge cases). */
const memoryFallback = {};

function get(key, fallback = null) {
  try {
    if (!STORAGE_OK) return memoryFallback[key] ?? fallback;
    const raw = localStorage.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[storage] get failed for', key, e);
    return fallback;
  }
}

function set(key, value) {
  try {
    if (!STORAGE_OK) { memoryFallback[key] = value; return true; }
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('[storage] set failed for', key, e);
    return false;
  }
}

function remove(key) {
  try {
    if (!STORAGE_OK) { delete memoryFallback[key]; return; }
    localStorage.removeItem(key);
  } catch (e) { /* noop */ }
}

/* -------------------------- Domain-specific helpers ------------------------- */

const DEFAULT_PROFILE = {
  name: '', weight: null, height: null, age: null, gender: 'female',
  activityLevel: 'moderate', goal: 'maintain', dietPreference: 'no-preference',
  allergies: [], medicalNotes: '', mealBudget: 'medium', cookingSkill: 'beginner',
  mealsPerDay: 3, favoriteFoods: [], dislikedFoods: [], createdAt: null, updatedAt: null,
};

const DEFAULT_SETTINGS = {
  theme: 'light', units: 'metric', language: 'en',
  aiProvider: 'openrouter', apiKey: '', aiModel: '',
};

const Storage = {
  KEYS,
  getProfile()        { return get(KEYS.profile, { ...DEFAULT_PROFILE }); },
  saveProfile(profile) {
    const now = new Date().toISOString();
    const existing = Storage.getProfile();
    const merged = { ...DEFAULT_PROFILE, ...existing, ...profile, updatedAt: now };
    if (!merged.createdAt) merged.createdAt = now;
    set(KEYS.profile, merged);
    return merged;
  },

  getSettings()         { return get(KEYS.settings, { ...DEFAULT_SETTINGS }); },
  saveSettings(partial) {
    const merged = { ...DEFAULT_SETTINGS, ...Storage.getSettings(), ...partial };
    set(KEYS.settings, merged);
    return merged;
  },

  getMealPlan()      { return get(KEYS.mealPlan, null); },
  saveMealPlan(plan) { set(KEYS.mealPlan, plan); return plan; },

  getShoppingList()      { return get(KEYS.shopping, { items: [], updatedAt: null }); },
  saveShoppingList(list) { set(KEYS.shopping, { ...list, updatedAt: new Date().toISOString() }); return list; },

  getProgress()      { return get(KEYS.progress, { weightLog: [], calorieLog: [], waterLog: {}, achievements: [] }); },
  saveProgress(p)    { set(KEYS.progress, p); return p; },

  getChatLog()       { return get(KEYS.chatLog, []); },
  saveChatLog(log)   { set(KEYS.chatLog, log.slice(-100)); }, // cap history

  getRecipeLog()     { return get(KEYS.recipeLog, []); },
  saveRecipeLog(log) { set(KEYS.recipeLog, log.slice(-50)); },

  /** Export everything as a single downloadable JSON blob. */
  exportAll() {
    const payload = {
      exportedAt: new Date().toISOString(),
      version: 1,
      profile: Storage.getProfile(),
      settings: { ...Storage.getSettings(), apiKey: '' }, // never export the API key
      mealPlan: Storage.getMealPlan(),
      shopping: Storage.getShoppingList(),
      progress: Storage.getProgress(),
    };
    return payload;
  },

  /** Import a previously exported JSON payload. Returns {ok, error}. */
  importAll(payload) {
    try {
      if (!payload || typeof payload !== 'object') throw new Error('Invalid file format');
      if (payload.profile) set(KEYS.profile, { ...DEFAULT_PROFILE, ...payload.profile });
      if (payload.settings) {
        const current = Storage.getSettings();
        set(KEYS.settings, { ...DEFAULT_SETTINGS, ...payload.settings, apiKey: current.apiKey });
      }
      if (payload.mealPlan) set(KEYS.mealPlan, payload.mealPlan);
      if (payload.shopping) set(KEYS.shopping, payload.shopping);
      if (payload.progress) set(KEYS.progress, payload.progress);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  clearAll() {
    Object.values(KEYS).forEach(remove);
  },

  raw: { get, set, remove },
};

export default Storage;
