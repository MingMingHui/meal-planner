/**
 * cloudStorage.js
 * ----------------------------------------------------------------------------
 * Purpose: Centralizes every Supabase database read/write. No other file in
 *          the app should import the Supabase client directly — this keeps
 *          database access in one auditable place (see spec: "Keep database
 *          access centralized").
 * Inputs:  Plain JS objects matching the local storage.js shapes.
 * Outputs: Promises resolving to plain JS objects/arrays, or throwing a
 *          human-readable Error on failure.
 * Depends on: auth.js (for the Supabase client + current user).
 * ----------------------------------------------------------------------------
 */

import { getSupabaseClient, getCurrentUser, isCloudConfigured } from './auth.js';
import { DEVICE_ONLY_SETTINGS } from './storage.js';
import { AI_PROXY_FUNCTION, PUBLIC_CONNECTION_COLUMNS, USAGE_COLUMNS, toPublicConnection, usageRecordToRow, rowToUsageRecord } from './ai/contract.js';
import { AIError, AI_ERROR_CODES } from './ai/errors.js';

function client() {
  const c = getSupabaseClient();
  if (!c) throw new Error('Cloud storage is not available — sign in is not configured or no session is active.');
  return c;
}

function userId() {
  const user = getCurrentUser();
  if (!user) throw new Error('You must be signed in to use cloud sync.');
  return user.id;
}

function checkResult(label, { data, error }) {
  if (error) throw new Error(`Cloud ${label} failed: ${error.message}`);
  return data;
}

export function cloudAvailable() {
  return isCloudConfigured() && !!getCurrentUser();
}

/* --------------------------------- Profile --------------------------------- */

export async function saveProfile(profile) {
  const uid = userId();
  const data = checkResult('profile save', await client()
    .from('profiles')
    .upsert({ user_id: uid, data: profile }, { onConflict: 'user_id' })
    .select()
    .single());
  return data;
}

export async function loadProfile() {
  const uid = userId();
  const { data, error } = await client().from('profiles').select('*').eq('user_id', uid).maybeSingle();
  if (error) throw new Error(`Cloud profile load failed: ${error.message}`);
  return data || null;
}

/* -------------------------------- Meal plan -------------------------------- */

export async function saveMealPlan(plan) {
  const uid = userId();
  return checkResult('meal plan save', await client()
    .from('meal_plans')
    .upsert({ user_id: uid, data: plan }, { onConflict: 'user_id' })
    .select()
    .single());
}

export async function loadMealPlans() {
  const uid = userId();
  const { data, error } = await client().from('meal_plans').select('*').eq('user_id', uid).maybeSingle();
  if (error) throw new Error(`Cloud meal plan load failed: ${error.message}`);
  return data || null;
}

/* --------------------------------- Recipes ---------------------------------- */

export async function saveRecipe(recipe) {
  const uid = userId();
  return checkResult('recipe save', await client()
    .from('recipes')
    .insert({ user_id: uid, data: recipe })
    .select()
    .single());
}

export async function loadRecipes(limit = 50) {
  const uid = userId();
  const { data, error } = await client()
    .from('recipes')
    .select('*')
    .eq('user_id', uid)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Cloud recipe load failed: ${error.message}`);
  return data || [];
}

/* ------------------------------ Shopping lists ------------------------------ */

export async function saveShoppingList(list) {
  const uid = userId();
  return checkResult('shopping list save', await client()
    .from('shopping_lists')
    .upsert({ user_id: uid, data: list }, { onConflict: 'user_id' })
    .select()
    .single());
}

export async function loadShoppingLists() {
  const uid = userId();
  const { data, error } = await client().from('shopping_lists').select('*').eq('user_id', uid).maybeSingle();
  if (error) throw new Error(`Cloud shopping list load failed: ${error.message}`);
  return data || null;
}

/* --------------------------------- Progress --------------------------------- */

/**
 * Upserts one progress entry (weight/calories/water) for a given date.
 * One row per (user, type, date) — see schema.sql — which is what makes
 * merging progress across devices safe instead of overwrite-only.
 */
export async function saveProgressEntry(entryType, date, value) {
  const uid = userId();
  return checkResult('progress entry save', await client()
    .from('progress_entries')
    .upsert({ user_id: uid, entry_type: entryType, entry_date: date, value }, { onConflict: 'user_id,entry_type,entry_date' })
    .select()
    .single());
}

export async function loadProgressEntries(entryType = null) {
  const uid = userId();
  let query = client().from('progress_entries').select('*').eq('user_id', uid).order('entry_date', { ascending: true });
  if (entryType) query = query.eq('entry_type', entryType);
  const { data, error } = await query;
  if (error) throw new Error(`Cloud progress load failed: ${error.message}`);
  return data || [];
}

export async function saveAchievement(achievementId, label, unlockedAt) {
  const uid = userId();
  return checkResult('achievement save', await client()
    .from('achievements')
    .upsert({ user_id: uid, achievement_id: achievementId, label, unlocked_at: unlockedAt }, { onConflict: 'user_id,achievement_id' })
    .select()
    .single());
}

export async function loadAchievements() {
  const uid = userId();
  const { data, error } = await client().from('achievements').select('*').eq('user_id', uid);
  if (error) throw new Error(`Cloud achievements load failed: ${error.message}`);
  return data || [];
}

/** Convenience: loads the full progress shape (weightLog/calorieLog/waterLog/achievements) in one go. */
export async function loadProgress() {
  const [entries, achievements] = await Promise.all([loadProgressEntries(), loadAchievements()]);
  const weightLog = entries.filter(e => e.entry_type === 'weight').map(e => ({ date: e.entry_date, weight: Number(e.value) }));
  const calorieLog = entries.filter(e => e.entry_type === 'calories').map(e => ({ date: e.entry_date, kcal: Number(e.value) }));
  const waterLog = {};
  entries.filter(e => e.entry_type === 'water').forEach(e => { waterLog[e.entry_date] = Number(e.value); });
  return {
    weightLog, calorieLog, waterLog,
    achievements: achievements.map(a => ({ id: a.achievement_id, label: a.label, unlockedAt: a.unlocked_at })),
  };
}

/** Pushes an entire local progress object up as individual rows (used by sync + first-login merge). */
export async function saveProgress(progress) {
  const ops = [];
  (progress.weightLog || []).forEach(e => ops.push(saveProgressEntry('weight', e.date, e.weight)));
  (progress.calorieLog || []).forEach(e => ops.push(saveProgressEntry('calories', e.date, e.kcal)));
  Object.entries(progress.waterLog || {}).forEach(([date, cups]) => ops.push(saveProgressEntry('water', date, cups)));
  (progress.achievements || []).forEach(a => ops.push(saveAchievement(a.id, a.label, a.unlockedAt)));
  await Promise.all(ops);
}

/* --------------------------------- Settings ---------------------------------- */

/** Note: never pass an AI apiKey into this — see README "API Key Security". */
export async function saveSettings(settings) {
  const uid = userId();
  const safeSettings = { ...settings };
  DEVICE_ONLY_SETTINGS.forEach((k) => { delete safeSettings[k]; }); // the device API key and its bindings never leave the device
  return checkResult('settings save', await client()
    .from('user_settings')
    .upsert({ user_id: uid, data: safeSettings }, { onConflict: 'user_id' })
    .select()
    .single());
}

export async function loadSettings() {
  const uid = userId();
  const { data, error } = await client().from('user_settings').select('*').eq('user_id', uid).maybeSingle();
  if (error) throw new Error(`Cloud settings load failed: ${error.message}`);
  return data || null;
}

/* ------------------------------ Account deletion ------------------------------ */

/** Deletes every cloud row owned by the current user, across all tables. Irreversible. */
export async function deleteUserData() {
  const uid = userId();
  const c = client();
  const tables = ['profiles', 'meal_plans', 'recipes', 'shopping_lists', 'shopping_list_items', 'progress_entries', 'achievements', 'user_settings', 'ai_provider_connections', 'ai_usage_records'];
  const results = await Promise.all(tables.map(t => c.from(t).delete().eq('user_id', uid)));
  const failed = results.filter(r => r.error);
  if (failed.length) throw new Error(`Some cloud data could not be deleted: ${failed.map(f => f.error.message).join('; ')}`);
  return true;
}

/**
 * Permanently deletes the signed-in user's account itself (their sign-in
 * identity), which cascades to every cloud row they own. Irreversible.
 * Requires supabase/delete_account.sql to have been run on the project.
 */
export async function deleteAccount() {
  userId(); // throws if not signed in
  const { error } = await client().rpc('delete_my_account');
  if (error) {
    if (error.code === 'PGRST202' || /could not find the function/i.test(error.message || '')) {
      throw new Error('Account deletion is not set up on the server yet. Run supabase/delete_account.sql in your Supabase project (see README → Delete Account).');
    }
    throw new Error(`Account deletion failed: ${error.message}`);
  }
  return true;
}

/* ---------------------------- AI providers & usage ---------------------------- */
/* Table and function shapes: js/ai/contract.js and supabase/ai_providers.sql.   */

/** The signed-in user's account-stored AI connections — non-secret columns only (the ciphertext is not even selectable). */
export async function loadAIConnections() {
  const uid = userId();
  const { data, error } = await client().from('ai_provider_connections').select(PUBLIC_CONNECTION_COLUMNS).eq('user_id', uid);
  if (error) {
    // Table not created yet (ai_providers.sql not run) — treat as "no account connections".
    if (error.code === '42P01' || error.code === 'PGRST205') return [];
    throw new AIError(AI_ERROR_CODES.UNKNOWN, 'Could not load your AI connections.');
  }
  return (data || []).map(toPublicConnection);
}

/** Direct revocation of one account connection (RLS: own rows only). Used when ai-proxy is unreachable. */
export async function deleteAIConnection(provider) {
  const uid = userId();
  const { error } = await client().from('ai_provider_connections').delete().eq('user_id', uid).eq('provider', provider);
  if (error) throw new AIError(AI_ERROR_CODES.UNKNOWN, 'Could not disconnect this provider.');
}

/** Inserts a client-recorded usage row (RLS only accepts recorded_by = 'client' for your own user id). */
export async function insertAIUsage(record) {
  const uid = userId();
  const { error } = await client().from('ai_usage_records').insert(usageRecordToRow({ ...record, recordedBy: 'client' }, uid));
  if (error) throw new AIError(AI_ERROR_CODES.USAGE_UNAVAILABLE, 'Could not save AI usage to your account.');
}

/** The signed-in user's usage history, newest first, filtered server-side. */
export async function loadAIUsage({ from, to, provider, model, limit = 1000 } = {}) {
  const uid = userId();
  let q = client().from('ai_usage_records').select(USAGE_COLUMNS).eq('user_id', uid).order('created_at', { ascending: false }).limit(limit);
  if (from) q = q.gte('created_at', new Date(`${from}T00:00:00`).toISOString());
  if (to) q = q.lte('created_at', new Date(`${to}T23:59:59.999`).toISOString());
  if (provider) q = q.eq('provider', provider);
  if (model) q = q.eq('model', model);
  const { data, error } = await q;
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') return [];
    throw new AIError(AI_ERROR_CODES.USAGE_UNAVAILABLE);
  }
  return (data || []).map(rowToUsageRecord);
}

/**
 * Calls the ai-proxy Edge Function. supabase-js attaches the user's access
 * token. Errors come back as AIError with the server's code; the request
 * body (which may contain a key being saved) is never logged.
 */
export async function invokeAIProxy(action, payload = {}, { timeoutMs = 60000 } = {}) {
  const c = client();
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new AIError(AI_ERROR_CODES.NETWORK);
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new AIError(AI_ERROR_CODES.TIMEOUT)), timeoutMs); });
  try {
    const { data, error } = await Promise.race([c.functions.invoke(AI_PROXY_FUNCTION, { body: { action, ...payload } }), timeout]);
    if (!error) return data;
    const response = error.context;
    if (response && typeof response.json === 'function') {
      const body = await response.json().catch(() => null);
      if (body?.error?.code) throw new AIError(body.error.code, body.error.message, { status: response.status });
      if (response.status === 404) throw new AIError(AI_ERROR_CODES.PROXY_UNAVAILABLE, undefined, { status: 404 });
      if (response.status === 401) throw new AIError(AI_ERROR_CODES.APP_AUTH_REQUIRED, undefined, { status: 401 });
    }
    // FunctionsFetchError / FunctionsRelayError: not deployed, blocked, or offline.
    throw new AIError(AI_ERROR_CODES.PROXY_UNAVAILABLE);
  } finally {
    clearTimeout(timer);
  }
}
