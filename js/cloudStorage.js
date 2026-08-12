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
  const { apiKey, ...safeSettings } = settings; // eslint-disable-line no-unused-vars
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
  const tables = ['profiles', 'meal_plans', 'recipes', 'shopping_lists', 'shopping_list_items', 'progress_entries', 'achievements', 'user_settings'];
  const results = await Promise.all(tables.map(t => c.from(t).delete().eq('user_id', uid)));
  const failed = results.filter(r => r.error);
  if (failed.length) throw new Error(`Some cloud data could not be deleted: ${failed.map(f => f.error.message).join('; ')}`);
  return true;
}
