/**
 * ai.js
 * ----------------------------------------------------------------------------
 * Purpose: The app's AI entry point. Recipe Generator, AI Meal Plan and AI
 *          Coach all call chatComplete(); it sends the request to the
 *          provider + model the user selected in Settings → AI Provider,
 *          through the shared AIProvider adapters in ai/providers.js:
 *
 *            User/Guest → AI Provider settings → selected provider/model
 *              → credential store
 *                  'account'         → ai-proxy Edge Function (key decrypted
 *                                      server-side, usage recorded server-side)
 *                  'device'/'session' → provider API directly from this
 *                                      browser (usage recorded by aiUsage.js)
 *              → same adapter, same limits, same error codes either way.
 *
 *          Nothing here is provider-specific; adding a provider never touches
 *          this file. The web app and the Android app run this same file.
 * Inputs:  Chat-style message arrays + the active connection (aiConnections.js).
 * Outputs: Promise<string> (assistant reply text) or a thrown AIError whose
 *          .message is safe to show and whose .code drives the UI.
 * Depends on: aiConnections.js, aiUsage.js, cloudStorage.js, ai/*.
 * ----------------------------------------------------------------------------
 */

import { getActiveConnection, getDeviceApiKey, isAIConfigured, markCredentialFailure, markCredentialVerified } from './aiConnections.js';
import { recordUsage } from './aiUsage.js';
import { invokeAIProxy } from './cloudStorage.js';
import { PROVIDERS, validateChatRequest } from './ai/providers.js';
import { runProviderChat } from './ai/chat.js';
import { buildUsageRecord } from './ai/usage.js';
import { AIError, AI_ERROR_CODES as C, CREDENTIAL_FAILURE_CODES, toAIError } from './ai/errors.js';
import { PROXY_ACTIONS } from './ai/contract.js';
import { CREDENTIAL_STORES } from './ai/policy.js';

export { PROVIDERS, AIError };

/** The active provider/model (no secrets). Kept for existing callers. */
export function getAIConfig() {
  const c = getActiveConnection();
  return { provider: c.provider, model: c.model, providerInfo: c.providerInfo, store: c.store, configured: c.configured };
}

/** True when the active provider has a usable credential for this user/guest. */
export function hasAPIKey() {
  return isAIConfigured();
}

/**
 * Low-level call to the configured provider. Every AI feature goes through
 * this so provider swaps, timeouts, usage recording and error messages stay
 * consistent everywhere.
 * @param {Array<{role:string, content:string}>} messages
 * @param {{temperature?:number, maxTokens?:number, timeoutMs?:number, feature?:string}} opts
 */
export async function chatComplete(messages, opts = {}) {
  const conn = getActiveConnection();
  if (!conn.configured) throw new AIError(C.NOT_CONFIGURED);
  const request = validateChatRequest({ provider: conn.provider, model: conn.model, messages, temperature: opts.temperature, maxTokens: opts.maxTokens, feature: opts.feature });

  if (conn.store === CREDENTIAL_STORES.ACCOUNT) {
    try {
      const result = await invokeAIProxy(PROXY_ACTIONS.CHAT, request, { timeoutMs: (opts.timeoutMs || 45000) + 15000 });
      if (!result?.text) throw new AIError(C.BAD_RESPONSE);
      return result.text.trim();
    } catch (err) {
      const e = toAIError(err, conn.providerInfo);
      if (CREDENTIAL_FAILURE_CODES.includes(e.code)) markCredentialFailure(conn.provider, conn.store, e.code);
      throw e;
    }
  }

  const apiKey = getDeviceApiKey(conn.provider);
  if (!apiKey) throw new AIError(C.NOT_CONFIGURED);
  const started = Date.now();
  try {
    const result = await runProviderChat({ ...request, apiKey, context: 'browser', timeoutMs: opts.timeoutMs });
    markCredentialVerified(conn.provider, conn.store);
    await recordUsage(buildUsageRecord({
      provider: request.provider, model: request.model, servedModel: result.servedModel, feature: request.feature,
      status: 'success', usage: result.usage, messages: request.messages, responseText: result.text,
      recordedBy: 'client', latencyMs: result.latencyMs,
    }));
    return result.text;
  } catch (err) {
    const e = toAIError(err, conn.providerInfo);
    await recordUsage(buildUsageRecord({
      provider: request.provider, model: request.model, feature: request.feature,
      status: 'error', errorCode: e.code, recordedBy: 'client', latencyMs: Date.now() - started,
    }));
    if (CREDENTIAL_FAILURE_CODES.includes(e.code)) markCredentialFailure(conn.provider, conn.store, e.code);
    throw e;
  }
}

/** Strips ```json fences etc and parses the first JSON object/array found. */
export function extractJSON(text) {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) { /* fall through */ }
    }
    throw new AIError(C.BAD_RESPONSE, 'Could not parse the AI response as JSON.');
  }
}

function profileSummary(profile) {
  const parts = [];
  if (profile.age) parts.push(`${profile.age} years old`);
  if (profile.gender) parts.push(profile.gender);
  if (profile.weight) parts.push(`${profile.weight}kg`);
  if (profile.height) parts.push(`${profile.height}cm`);
  if (profile.goal) parts.push(`goal: ${profile.goal.replace('_', ' ')}`);
  if (profile.dietPreference && profile.dietPreference !== 'no-preference') parts.push(`diet: ${profile.dietPreference}`);
  if (profile.allergies?.length) parts.push(`allergies: ${profile.allergies.join(', ')}`);
  if (profile.medicalNotes) parts.push(`medical notes: ${profile.medicalNotes}`);
  if (profile.cookingSkill) parts.push(`cooking skill: ${profile.cookingSkill}`);
  if (profile.mealBudget) parts.push(`budget: ${profile.mealBudget}`);
  if (profile.favoriteFoods?.length) parts.push(`likes: ${profile.favoriteFoods.join(', ')}`);
  if (profile.dislikedFoods?.length) parts.push(`dislikes: ${profile.dislikedFoods.join(', ')}`);
  return parts.join('; ') || 'No profile details provided yet.';
}

/**
 * Asks the AI to design an original recipe as strict JSON, personalized to
 * the user's profile. Used by the Recipe Generator tab.
 */
export async function generateAIRecipe(profile, requestText) {
  const sys = `You are a certified nutritionist and chef specializing in Malaysian and international healthy cooking. Respond with ONLY valid JSON (no prose, no markdown fences) matching this shape:
{"name":string,"cuisine":string,"mealType":string,"servings":number,"prepTime":number,"cookTime":number,"difficulty":"Easy|Medium|Hard",
"ingredients":[{"item":string,"amount":string}],"instructions":[string],
"nutritionPerServing":{"kcal":number,"protein":number,"fat":number,"carbs":number,"fiber":number},
"estimatedCostMYR":number,"substitutions":[string],"healthBenefits":[string]}`;
  const user = `User profile: ${profileSummary(profile)}.\nRequest: ${requestText || 'Suggest a healthy recipe suited to my profile.'}\nPrefer ingredients available in Malaysia. Keep it realistic and practical.`;
  const reply = await chatComplete([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0.8, maxTokens: 1000, feature: 'recipe' });
  return extractJSON(reply);
}

/**
 * Generates a full day's meal plan as JSON, personalized to the profile and
 * calorie/macro targets. Used as an AI-assisted alternative to the local
 * rule-based planner in recipes.js.
 */
export async function generateAIMealPlan(profile, targets) {
  const sys = `You are a nutrition coach. Respond with ONLY valid JSON (no prose) matching:
{"meals":[{"slot":"breakfast|lunch|dinner|snack","name":string,"kcal":number,"protein":number,"fat":number,"carbs":number,"fiber":number,"prepTime":number,"difficulty":"Easy|Medium|Hard","servings":number,"ingredients":[string],"instructions":[string]}]}
Produce exactly ${profile.mealsPerDay || 3} meals whose kcal sum is close to the daily target.`;
  const user = `Profile: ${profileSummary(profile)}.\nDaily calorie target: ${targets.calorieTarget} kcal. Protein target: ${targets.macros.proteinG}g, Fat: ${targets.macros.fatG}g, Carbs: ${targets.macros.carbG}g.\nInclude at least one Malaysian-inspired dish if it fits the diet preference and allergies.`;
  const reply = await chatComplete([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0.7, maxTokens: 1400, feature: 'meal_plan' });
  return extractJSON(reply);
}

/** Conversational AI Coach reply, grounded in the user's profile for personalization. */
export async function coachReply(userMessage, profile, history = []) {
  const sys = `You are a friendly, evidence-based nutrition coach inside a Malaysian health app called "Health Meal Planning Agent". Give concise, practical, safe advice (max ~180 words). Personalize using the user's profile when relevant. You are not a doctor — for medical concerns, suggest seeing a healthcare professional. Profile: ${profileSummary(profile)}`;
  const messages = [
    { role: 'system', content: sys },
    ...history.slice(-8).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];
  return chatComplete(messages, { temperature: 0.6, maxTokens: 500, feature: 'coach' });
}
