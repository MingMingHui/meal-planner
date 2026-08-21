/**
 * storage.js
 * ----------------------------------------------------------------------------
 * Purpose:   Single abstraction over the browser Storage APIs for the whole
 *            app. Every other module reads/writes app data through this file
 *            so the storage backend could be swapped later without touching
 *            business logic. Also owns the versioned local schema, migration
 *            handling, JSON export/import with a validated preview step, and
 *            the guest-session backend switch (see "Guest session storage"
 *            below).
 * Inputs:    Plain JS values (objects/arrays/strings) passed by callers.
 * Outputs:   Parsed JS values read back from storage, or sane defaults.
 * Depends on: utils.js (mergeByDate, for import merging).
 * ----------------------------------------------------------------------------
 * Guest session storage
 * ----------------------------------------------------------------------------
 * Signed-in users are backed by localStorage (durable, and mirrored to the
 * cloud by syncManager.js). Guests are backed by sessionStorage instead —
 * data that exists only for the current browser tab/session and disappears
 * when the browser is closed, per the "guest sessions are ephemeral by
 * design" product decision. app.js decides which backend is active by
 * calling enterGuestSession() (guest) / claimGuestSessionForAccount()
 * (guest signs in) around the auth flow; see app.js's decideInitialScreen()
 * and handlePostAuth().
 * ----------------------------------------------------------------------------
 */

import { mergeByDate } from './utils.js';

const CURRENT_SCHEMA_VERSION = 2;

const NS = 'hmpa'; // health-meal-planning-agent namespace, avoids key collisions

const KEYS = {
  profile:   `${NS}:profile`,
  settings:  `${NS}:settings`,
  mealPlan:  `${NS}:mealPlan`,
  shopping:  `${NS}:shopping`,
  progress:  `${NS}:progress`,
  chatLog:   `${NS}:chatLog`,
  recipeLog: `${NS}:recipeLog`,
  meta:      `${NS}:meta`, // { schemaVersion, userId, lastSyncedAt }
};

/** sessionStorage-only flag: set while a guest is using this browser session. */
const GUEST_SESSION_FLAG = `${NS}:guestSessionActive`;

function isStorageAvailable(store) {
  try {
    const t = '__hmpa_test__';
    store.setItem(t, '1');
    store.removeItem(t);
    return true;
  } catch (e) {
    return false;
  }
}

const STORAGE_OK = isStorageAvailable(window.localStorage);
const SESSION_STORAGE_OK = STORAGE_OK && isStorageAvailable(window.sessionStorage);
/** In-memory fallback used only if localStorage is blocked (e.g. private mode edge cases). */
const memoryFallback = {};

/** The active backend: localStorage for signed-in users, sessionStorage for guests. */
let backend = window.localStorage;

function get(key, fallback = null) {
  try {
    if (!STORAGE_OK) return memoryFallback[key] ?? fallback;
    const raw = backend.getItem(key);
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
    backend.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('[storage] set failed for', key, e);
    return false;
  }
}

function remove(key) {
  try {
    if (!STORAGE_OK) { delete memoryFallback[key]; return; }
    backend.removeItem(key);
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

function dedupeAchievements(list) {
  const seen = new Map();
  list.forEach(a => { if (!seen.has(a.id)) seen.set(a.id, a); });
  return [...seen.values()];
}

/**
 * Schema migrations, keyed by the version they migrate FROM. Each function
 * mutates localStorage in place; runMigrations() applies them in sequence
 * and bumps the stored schemaVersion. Add new entries here — keyed by the
 * old version number — whenever a stored shape changes; never delete old
 * migrations, so a user who hasn't opened the app in a while still upgrades
 * cleanly step by step.
 */
const MIGRATIONS = {
  // v1 → v2: introduced updatedAt timestamps on mealPlan/shopping/progress
  // (needed for cloud conflict resolution) and the meta/userTag record.
  // Existing v1 data is left as-is; the next save() call naturally adds the
  // new timestamp fields, so no destructive rewrite is needed here.
  1: () => { /* structural additions only — nothing to transform */ },
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
  saveMealPlan(plan) {
    if (plan) plan = { ...plan, updatedAt: new Date().toISOString() };
    set(KEYS.mealPlan, plan);
    return plan;
  },

  getShoppingList()      { return get(KEYS.shopping, { items: [], updatedAt: null }); },
  saveShoppingList(list) { const withTs = { ...list, updatedAt: new Date().toISOString() }; set(KEYS.shopping, withTs); return withTs; },

  getProgress()      { return get(KEYS.progress, { weightLog: [], calorieLog: [], waterLog: {}, achievements: [] }); },
  saveProgress(p)    { const withTs = { ...p, updatedAt: new Date().toISOString() }; set(KEYS.progress, withTs); return withTs; },

  getChatLog()       { return get(KEYS.chatLog, []); },
  saveChatLog(log)   { set(KEYS.chatLog, log.slice(-100)); }, // cap history

  getRecipeLog()     { return get(KEYS.recipeLog, []); },
  saveRecipeLog(log) { set(KEYS.recipeLog, log.slice(-50)); },

  /** Export everything as a single downloadable JSON blob. */
  exportAll() {
    const payload = {
      exportedAt: new Date().toISOString(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      profile: Storage.getProfile(),
      settings: { ...Storage.getSettings(), apiKey: '' }, // never export the API key
      mealPlan: Storage.getMealPlan(),
      shopping: Storage.getShoppingList(),
      progress: Storage.getProgress(),
    };
    return payload;
  },

  /**
   * Validates a previously exported JSON payload without writing anything —
   * used to show an import preview before the user confirms.
   * @returns {{ok:boolean, error?:string, summary?:object}}
   */
  previewImport(payload) {
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'This does not look like a valid export file.' };
    if (payload.schemaVersion && payload.schemaVersion > CURRENT_SCHEMA_VERSION) {
      return { ok: false, error: 'This file was exported from a newer version of the app and cannot be safely imported here.' };
    }
    const summary = {
      hasProfile: !!payload.profile,
      hasMealPlan: !!payload.mealPlan,
      hasShopping: !!(payload.shopping?.items?.length),
      shoppingItemCount: payload.shopping?.items?.length || 0,
      hasProgress: !!(payload.progress?.weightLog?.length || payload.progress?.calorieLog?.length),
      weightEntryCount: payload.progress?.weightLog?.length || 0,
      calorieEntryCount: payload.progress?.calorieLog?.length || 0,
      hasSettings: !!payload.settings,
      exportedAt: payload.exportedAt || null,
    };
    return { ok: true, summary };
  },

  /**
   * Imports a previously exported JSON payload. `mode` is 'merge' (default,
   * combines with existing local data) or 'replace' (overwrites local data
   * for the sections present in the file). Never touches sections the file
   * doesn't include.
   */
  importAll(payload, mode = 'merge') {
    try {
      const check = Storage.previewImport(payload);
      if (!check.ok) return check;

      if (payload.profile) {
        const merged = mode === 'replace' ? { ...DEFAULT_PROFILE, ...payload.profile } : { ...DEFAULT_PROFILE, ...Storage.getProfile(), ...payload.profile };
        set(KEYS.profile, merged);
      }
      if (payload.settings) {
        const current = Storage.getSettings();
        set(KEYS.settings, { ...DEFAULT_SETTINGS, ...current, ...payload.settings, apiKey: current.apiKey });
      }
      if (payload.mealPlan) set(KEYS.mealPlan, payload.mealPlan);
      if (payload.shopping) {
        if (mode === 'replace' || !Storage.getShoppingList().items?.length) {
          set(KEYS.shopping, payload.shopping);
        } else {
          const existingIds = new Set(Storage.getShoppingList().items.map(i => i.id));
          const merged = [...Storage.getShoppingList().items, ...payload.shopping.items.filter(i => !existingIds.has(i.id))];
          set(KEYS.shopping, { ...payload.shopping, items: merged });
        }
      }
      if (payload.progress) {
        if (mode === 'replace') {
          set(KEYS.progress, payload.progress);
        } else {
          const current = Storage.getProgress();
          set(KEYS.progress, {
            weightLog: mergeByDate(current.weightLog, payload.progress.weightLog || []),
            calorieLog: mergeByDate(current.calorieLog, payload.progress.calorieLog || []),
            waterLog: { ...current.waterLog, ...(payload.progress.waterLog || {}) },
            achievements: dedupeAchievements([...(current.achievements || []), ...(payload.progress.achievements || [])]),
          });
        }
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  clearAll() {
    Object.values(KEYS).forEach(remove);
  },
  /** Alias — clears only browser-local data, distinct from cloud data (see cloudStorage.deleteUserData). */
  clearLocalData() { Storage.clearAll(); },

  /* -------------------------- Schema / user tagging -------------------------- */

  getMeta() { return get(KEYS.meta, { schemaVersion: CURRENT_SCHEMA_VERSION, userId: null, lastSyncedAt: null, onboardingDone: false }); },
  saveMeta(partial) { const merged = { ...Storage.getMeta(), ...partial }; set(KEYS.meta, merged); return merged; },

  /** Which user's data is currently cached locally (null = guest/unclaimed). Used to detect "existing device data" on first login. */
  getLocalUserTag() { return Storage.getMeta().userId; },
  setLocalUserTag(userId) { Storage.saveMeta({ userId }); },

  getLastSyncedAt() { return Storage.getMeta().lastSyncedAt; },
  setLastSyncedAt(iso) { Storage.saveMeta({ lastSyncedAt: iso }); },

  /** Runs any pending migrations. Safe to call on every app start — a no-op once caught up. */
  runMigrations() {
    const meta = Storage.getMeta();
    let version = meta.schemaVersion || 1;
    while (MIGRATIONS[version]) {
      try {
        MIGRATIONS[version]();
        version += 1;
      } catch (e) {
        console.error(`[storage] migration from v${version} failed`, e);
        break;
      }
    }
    Storage.saveMeta({ schemaVersion: version });
  },

  /* -------------------------- Guest session backend -------------------------- */

  /** True if this browser tab currently has an active (unclosed) guest session. */
  isGuestSessionActive() {
    if (!SESSION_STORAGE_OK) return false;
    try { return window.sessionStorage.getItem(GUEST_SESSION_FLAG) === '1'; }
    catch (e) { return false; }
  },

  /**
   * Switches the active backend to sessionStorage and marks a guest session
   * as active. Safe to call both when a guest first clicks "Continue as
   * Guest" and on every later page load while that session is still active
   * (e.g. a refresh) — migration only happens the first time. If this
   * browser already has *unclaimed* guest data sitting in localStorage from
   * before this backend split existed, that data is migrated into the
   * session-scoped store first so it isn't silently orphaned, then removed
   * from localStorage, since guest data is no longer meant to outlive the
   * browser session.
   */
  enterGuestSession() {
    if (!SESSION_STORAGE_OK) { backend = window.localStorage; return; }
    if (!Storage.isGuestSessionActive()) {
      const meta = get(KEYS.meta, {});
      if (!meta.userId) {
        Object.values(KEYS).forEach((key) => {
          if (key === KEYS.meta) return;
          const raw = window.localStorage.getItem(key);
          if (raw !== null) window.sessionStorage.setItem(key, raw);
        });
        Object.values(KEYS).forEach((key) => { if (key !== KEYS.meta) window.localStorage.removeItem(key); });
      }
      try { window.sessionStorage.setItem(GUEST_SESSION_FLAG, '1'); } catch (e) { /* noop */ }
    }
    backend = window.sessionStorage;
  },

  /**
   * Folds a guest session's sessionStorage data into the durable localStorage
   * store, then clears the session-scoped copy and flag. Called once, right
   * after a guest signs in during the same browser tab session (before
   * syncManager's first-login merge runs), so the data they built up as a
   * guest is treated as "existing local data to reconcile with the cloud"
   * instead of being lost when the backend switches to localStorage.
   */
  claimGuestSessionForAccount() {
    if (SESSION_STORAGE_OK && Storage.isGuestSessionActive()) {
      Object.values(KEYS).forEach((key) => {
        if (key === KEYS.meta) return;
        const raw = window.sessionStorage.getItem(key);
        if (raw !== null) window.localStorage.setItem(key, raw);
      });
      Object.values(KEYS).forEach((key) => window.sessionStorage.removeItem(key));
      try { window.sessionStorage.removeItem(GUEST_SESSION_FLAG); } catch (e) { /* noop */ }
    }
    backend = window.localStorage;
  },

  raw: { get, set, remove },
};

export default Storage;
