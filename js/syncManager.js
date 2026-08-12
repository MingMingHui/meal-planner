/**
 * syncManager.js
 * ----------------------------------------------------------------------------
 * Purpose: The only module that reconciles local (storage.js) and cloud
 *          (cloudStorage.js) data. Owns the visible sync status, the
 *          first-login "we found existing data on this device" decision,
 *          and per-domain sync/merge functions. No UI file should merge
 *          local/cloud data itself — it should call into here.
 * Inputs:  Local data from storage.js, cloud data from cloudStorage.js.
 * Outputs: Updated local + cloud records; a subscribable sync status.
 * Depends on: storage.js, cloudStorage.js, auth.js, utils.js.
 * ----------------------------------------------------------------------------
 */

import Storage from './storage.js';
import * as cloud from './cloudStorage.js';
import { getCurrentUser, isCloudConfigured } from './auth.js';
import { isOnline, pickNewer, mergeByDate, nowISO } from './utils.js';

/** @typedef {'idle'|'offline'|'syncing'|'synced'|'error'} SyncStatus */

let status = 'idle';
let lastError = null;
const statusListeners = new Set();

function setStatus(next, error = null) {
  status = next;
  lastError = error;
  statusListeners.forEach(fn => { try { fn(status, lastError); } catch (e) { console.error('[sync] status listener error', e); } });
}

export function getSyncStatus() { return { status, error: lastError }; }
export function onSyncStatusChange(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); }

/** Whether cloud sync is a real possibility right now (configured + signed in). */
export function syncAvailable() {
  return isCloudConfigured() && !!getCurrentUser();
}

/**
 * Call once right after a successful sign-in, before syncing. Detects
 * whether this device already has local data that hasn't been associated
 * with the signed-in account yet, and whether that account already has
 * cloud data — the two conditions the "we found existing data" prompt
 * needs to decide what to ask the user.
 */
export async function checkFirstLoginState() {
  const user = getCurrentUser();
  if (!user) return { needsDecision: false };

  const localTag = Storage.getLocalUserTag();
  const hasUnclaimedLocalData = localTag !== user.id && hasAnyLocalData();

  let hasCloudData = false;
  try {
    const [profile, plan, list] = await Promise.all([cloud.loadProfile(), cloud.loadMealPlans(), cloud.loadShoppingLists()]);
    hasCloudData = !!(profile || plan || list);
  } catch (e) {
    console.warn('[sync] could not check cloud data on first login', e);
  }

  return {
    needsDecision: hasUnclaimedLocalData && hasCloudData,
    hasUnclaimedLocalData,
    hasCloudData,
  };
}

function hasAnyLocalData() {
  const profile = Storage.getProfile();
  const plan = Storage.getMealPlan();
  const list = Storage.getShoppingList();
  const progress = Storage.getProgress();
  return !!(profile.weight || plan?.meals?.length || list.items?.length || progress.weightLog?.length || progress.calorieLog?.length);
}

/**
 * Applies the user's choice from the first-login prompt, then tags local
 * data as belonging to this account.
 * @param {'cloud'|'local'|'merge'} strategy
 */
export async function resolveFirstLogin(strategy) {
  const user = getCurrentUser();
  if (!user) return;

  if (strategy === 'cloud') {
    await pullAllFromCloud();
  } else if (strategy === 'local') {
    await pushAllToCloud();
  } else {
    await syncAll(); // 'merge' — the default, safest option
  }
  Storage.setLocalUserTag(user.id);
}

/* --------------------------------- Per-domain sync --------------------------------- */

export async function syncProfile() {
  const local = Storage.getProfile();
  const cloudRecord = await cloud.loadProfile();
  const { winner, value } = pickNewer(local, cloudRecord);
  if (winner === 'cloud') {
    Storage.saveProfile(value.data);
    return value.data;
  }
  await cloud.saveProfile(local);
  return local;
}

export async function syncMealPlans() {
  const local = Storage.getMealPlan();
  const cloudRecord = await cloud.loadMealPlans();
  const { winner, value } = pickNewer(local, cloudRecord);
  if (winner === 'cloud') {
    Storage.saveMealPlan(value.data);
    return value.data;
  }
  if (local) await cloud.saveMealPlan(local);
  return local;
}

export async function syncRecipes() {
  // Recipes are append-only history: push anything local that isn't in the
  // cloud log yet. We key on generatedAt since local entries don't have a
  // stable id until they're saved to the cloud.
  const localLog = Storage.getRecipeLog();
  const cloudLog = await cloud.loadRecipes(200);
  const cloudTimestamps = new Set(cloudLog.map(r => r.data?.generatedAt));
  const toPush = localLog.filter(r => r.generatedAt && !cloudTimestamps.has(r.generatedAt));
  await Promise.all(toPush.map(r => cloud.saveRecipe(r)));
  return { pushed: toPush.length, cloudCount: cloudLog.length };
}

export async function syncShoppingLists() {
  const local = Storage.getShoppingList();
  const cloudRecord = await cloud.loadShoppingLists();
  const { winner, value } = pickNewer(local, cloudRecord);
  if (winner === 'cloud') {
    Storage.saveShoppingList(value.data);
    return value.data;
  }
  await cloud.saveShoppingList(local);
  return local;
}

export async function syncProgress() {
  const local = Storage.getProgress();
  const cloudProgress = await cloud.loadProgress();

  // Progress merges by individual dated entry rather than "latest wins" —
  // logging weight on your phone shouldn't erase a calorie entry you made
  // on your laptop the same day.
  const mergedWeight = mergeByDate(local.weightLog, cloudProgress.weightLog);
  const mergedCalorie = mergeByDate(local.calorieLog, cloudProgress.calorieLog);
  const mergedWater = { ...local.waterLog, ...cloudProgress.waterLog };
  const achievementMap = new Map();
  [...(local.achievements || []), ...(cloudProgress.achievements || [])].forEach(a => achievementMap.set(a.id, a));

  const merged = {
    weightLog: mergedWeight,
    calorieLog: mergedCalorie,
    waterLog: mergedWater,
    achievements: [...achievementMap.values()],
  };

  Storage.saveProgress(merged);
  await cloud.saveProgress(merged);
  return merged;
}

async function syncSettings() {
  const local = Storage.getSettings();
  const cloudRecord = await cloud.loadSettings();
  const { winner, value } = pickNewer({ updatedAt: local.updatedAt }, cloudRecord);
  if (winner === 'cloud' && value?.data) {
    Storage.saveSettings(value.data); // apiKey is never in the cloud copy — local apiKey is preserved by saveSettings' merge
  } else {
    await cloud.saveSettings(local);
  }
}

/* ------------------------------------ Bulk operations ------------------------------------ */

async function pullAllFromCloud() {
  const [profile, plan, list, progress] = await Promise.all([
    cloud.loadProfile(), cloud.loadMealPlans(), cloud.loadShoppingLists(), cloud.loadProgress(),
  ]);
  if (profile) Storage.saveProfile(profile.data);
  if (plan) Storage.saveMealPlan(plan.data);
  if (list) Storage.saveShoppingList(list.data);
  Storage.saveProgress(progress);
}

async function pushAllToCloud() {
  const profile = Storage.getProfile();
  const plan = Storage.getMealPlan();
  const list = Storage.getShoppingList();
  const progress = Storage.getProgress();
  await Promise.all([
    cloud.saveProfile(profile),
    plan ? cloud.saveMealPlan(plan) : Promise.resolve(),
    cloud.saveShoppingList(list),
    cloud.saveProgress(progress),
  ]);
}

/**
 * Runs a full two-way sync across every domain. Safe to call repeatedly
 * (e.g. on a "Sync Now" button, after reconnecting, or periodically).
 */
export async function syncAll() {
  if (!isOnline()) { setStatus('offline'); return { ok: false, reason: 'offline' }; }
  if (!syncAvailable()) { setStatus('idle'); return { ok: false, reason: 'not_signed_in' }; }

  setStatus('syncing');
  try {
    await syncProfile();
    await syncMealPlans();
    await syncShoppingLists();
    await syncProgress();
    await syncRecipes();
    await syncSettings();
    Storage.setLastSyncedAt(nowISO());
    setStatus('synced');
    return { ok: true };
  } catch (err) {
    console.error('[sync] syncAll failed', err);
    setStatus('error', err.message || 'Sync failed');
    return { ok: false, reason: 'error', error: err };
  }
}

/* ------------------------------------ Online/offline wiring ------------------------------------ */

let autoSyncWired = false;
export function wireAutoSync() {
  if (autoSyncWired || typeof window === 'undefined') return;
  autoSyncWired = true;
  window.addEventListener('online', () => { if (syncAvailable()) syncAll(); });
  window.addEventListener('offline', () => setStatus('offline'));
}
