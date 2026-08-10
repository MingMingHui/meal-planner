/**
 * ai.js
 * ----------------------------------------------------------------------------
 * Purpose: Abstraction layer over several free/open-source-model AI providers
 *          so the rest of the app never talks to a specific vendor directly.
 *          The user supplies their own API key in Settings — nothing is
 *          hardcoded or bundled with the app.
 * Inputs:  Chat-style message arrays, plus provider/model/key from Storage
 *          settings.
 * Outputs: Promise<string> (assistant reply text) or a thrown Error with a
 *          human-readable .message for the caller to surface to the user.
 * Depends on: storage.js (reads aiProvider/apiKey/aiModel settings).
 * ----------------------------------------------------------------------------
 */

import Storage from './storage.js';

/**
 * All supported providers speak an OpenAI-compatible /chat/completions
 * schema, which is what lets a single request function serve all of them —
 * this is the "swap provider easily" abstraction the app requires.
 */
export const PROVIDERS = {
  openrouter: {
    label: 'OpenRouter (free models)',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'meta-llama/llama-3.1-8b-instruct:free',
    modelOptions: [
      'meta-llama/llama-3.1-8b-instruct:free',
      'mistralai/mistral-7b-instruct:free',
      'google/gemma-2-9b-it:free',
      'qwen/qwen-2.5-7b-instruct:free',
      'deepseek/deepseek-chat:free',
    ],
    keyUrl: 'https://openrouter.ai/keys',
    extraHeaders: { 'HTTP-Referer': 'https://github.com/health-meal-planner', 'X-Title': 'Health Meal Planning Agent' },
  },
  groq: {
    label: 'Groq (open-source models)',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.1-8b-instant',
    modelOptions: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'gemma2-9b-it'],
    keyUrl: 'https://console.groq.com/keys',
  },
  together: {
    label: 'Together AI (free models)',
    endpoint: 'https://api.together.xyz/v1/chat/completions',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
    modelOptions: ['meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', 'Qwen/Qwen2.5-7B-Instruct-Turbo'],
    keyUrl: 'https://api.together.xyz/settings/api-keys',
  },
  huggingface: {
    label: 'Hugging Face Inference (router)',
    endpoint: 'https://router.huggingface.co/v1/chat/completions',
    defaultModel: 'meta-llama/Llama-3.1-8B-Instruct',
    modelOptions: ['meta-llama/Llama-3.1-8B-Instruct', 'mistralai/Mistral-7B-Instruct-v0.3', 'Qwen/Qwen2.5-7B-Instruct'],
    keyUrl: 'https://huggingface.co/settings/tokens',
  },
};

export function getAIConfig() {
  const s = Storage.getSettings();
  const provider = PROVIDERS[s.aiProvider] ? s.aiProvider : 'openrouter';
  const model = s.aiModel || PROVIDERS[provider].defaultModel;
  return { provider, model, apiKey: s.apiKey || '', providerInfo: PROVIDERS[provider] };
}

export function hasAPIKey() {
  return !!Storage.getSettings().apiKey;
}

class AIError extends Error {}

/**
 * Low-level call to the configured provider. Every caller in the app should
 * go through this so provider swaps, timeouts and error messages stay
 * consistent everywhere (recipe generator, meal planner, AI coach).
 * @param {Array<{role:string, content:string}>} messages
 * @param {{temperature?:number, maxTokens?:number, timeoutMs?:number}} opts
 */
export async function chatComplete(messages, opts = {}) {
  const { provider, model, apiKey, providerInfo } = getAIConfig();
  if (!apiKey) {
    throw new AIError('No API key configured. Add one for your chosen provider in Settings → AI Provider.');
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs || 30000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(providerInfo.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...(providerInfo.extraHeaders || {}),
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 900,
      }),
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      throw new AIError('Your API key was rejected. Double-check it in Settings.');
    }
    if (res.status === 429) {
      throw new AIError('Rate limit reached for this provider/model. Wait a moment, or switch models in Settings.');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AIError(`AI provider returned an error (${res.status}). ${text.slice(0, 160)}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new AIError('The AI response was empty or malformed. Please try again.');
    return content.trim();
  } catch (err) {
    if (err.name === 'AbortError') throw new AIError('The AI request timed out. Check your connection and try again.');
    if (err instanceof AIError) throw err;
    if (err instanceof TypeError) throw new AIError('Network error reaching the AI provider. Check your internet connection.');
    throw new AIError(err.message || 'Unknown AI error.');
  } finally {
    clearTimeout(timeout);
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
    throw new AIError('Could not parse the AI response as JSON.');
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
  const reply = await chatComplete([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0.8, maxTokens: 1000 });
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
  const reply = await chatComplete([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0.7, maxTokens: 1400 });
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
  return chatComplete(messages, { temperature: 0.6, maxTokens: 500 });
}
