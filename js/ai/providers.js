/**
 * ai/providers.js
 * ----------------------------------------------------------------------------
 * Purpose: The AI provider registry and the AIProvider adapter interface —
 *          the single place that knows how each vendor's API is shaped.
 *          Shared verbatim by the browser (web + Android app) and the
 *          ai-proxy Edge Function, so request building, response parsing,
 *          model validation and limits can never drift between platforms.
 *
 *          AIProvider adapter interface (one per API "kind"):
 *            buildChatRequest({ provider, model, apiKey, messages,
 *                               temperature, maxTokens, context })
 *                -> { url, init }               (a fetch() call, not sent)
 *            parseChatResponse(json, { provider, model })
 *                -> { text, servedModel, usage: { inputTokens, outputTokens,
 *                     providerCostUsd } }        (usage fields may be null)
 *            buildVerifyRequest({ provider, apiKey, context }) -> { url, init } | null
 *
 *          Adapters:
 *            openAICompatibleAdapter -> OpenAI, OpenRouter, Groq, Together, Hugging Face
 *            anthropicAdapter        -> Anthropic (Claude Messages API)
 *
 *          Adding a provider = adding a PROVIDERS entry (and, only if its API
 *          isn't OpenAI-compatible, a new adapter). Nothing in the UI or the
 *          chat flow is provider-specific. See docs/ai-providers.md.
 * Inputs:  Plain objects; no globals, no DOM, no Storage.
 * Outputs: Registry lookups, fetch request descriptors, parsed results.
 * Depends on: ./errors.js
 * ----------------------------------------------------------------------------
 */

import { AIError, AI_ERROR_CODES as C } from './errors.js';

/** Authentication mechanisms a provider officially supports for this use case. */
export const AUTH_METHODS = Object.freeze({
  API_KEY: 'api_key',       // user pastes a key created in the provider's console
  OAUTH_PKCE: 'oauth_pkce', // provider's official OAuth PKCE flow that issues a user-controlled key
});

/**
 * Model pricing is USD per 1M tokens, copied from each provider's public
 * pricing page on PRICING_AS_OF. It only powers *estimated* cost — prices
 * change, so the usage page always labels these numbers as estimates.
 * `pricing: null` means we have no reliable price and show no cost.
 */
export const PRICING_AS_OF = '2026-11-03';

const openrouterFree = (id, label) => ({ id, label, pricing: { input: 0, output: 0 } });

export const PROVIDERS = Object.freeze({
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'One account for many models, including free open-source ones.',
    kind: 'openai-compatible',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    verifyUrl: 'https://openrouter.ai/api/v1/key',
    keyUrl: 'https://openrouter.ai/keys',
    revokeUrl: 'https://openrouter.ai/settings/keys',
    keyPattern: /^sk-or-[A-Za-z0-9_-]{16,}$/,
    keyPlaceholder: 'sk-or-…',
    authMethods: [AUTH_METHODS.OAUTH_PKCE, AUTH_METHODS.API_KEY],
    // OpenRouter reports the real charge per request when asked to.
    extraBody: { usage: { include: true } },
    extraHeaders: { 'HTTP-Referer': 'https://github.com/health-meal-planner', 'X-Title': 'Health Meal Planning Agent' },
    defaultModel: 'meta-llama/llama-3.1-8b-instruct:free',
    models: [
      openrouterFree('meta-llama/llama-3.1-8b-instruct:free', 'Llama 3.1 8B (free)'),
      openrouterFree('mistralai/mistral-7b-instruct:free', 'Mistral 7B (free)'),
      openrouterFree('google/gemma-2-9b-it:free', 'Gemma 2 9B (free)'),
      openrouterFree('qwen/qwen-2.5-7b-instruct:free', 'Qwen 2.5 7B (free)'),
      openrouterFree('deepseek/deepseek-chat:free', 'DeepSeek Chat (free)'),
    ],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI (ChatGPT models)',
    description: 'Uses an OpenAI Platform API key. A ChatGPT subscription does not include API access.',
    kind: 'openai-compatible',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    verifyUrl: 'https://api.openai.com/v1/models',
    keyUrl: 'https://platform.openai.com/api-keys',
    revokeUrl: 'https://platform.openai.com/api-keys',
    keyPattern: /^sk-[A-Za-z0-9_-]{20,}$/,
    keyPlaceholder: 'sk-…',
    authMethods: [AUTH_METHODS.API_KEY],
    tokenParam: 'max_completion_tokens',
    defaultModel: 'gpt-4.1-mini',
    models: [
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', pricing: { input: 0.40, output: 1.60 } },
      { id: 'gpt-4.1-nano', label: 'GPT-4.1 nano', pricing: { input: 0.10, output: 0.40 } },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', pricing: { input: 0.15, output: 0.60 } },
    ],
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    description: 'Uses an Anthropic Console API key. A Claude.ai subscription does not include API access.',
    kind: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    verifyUrl: 'https://api.anthropic.com/v1/models',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    revokeUrl: 'https://console.anthropic.com/settings/keys',
    keyPattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
    keyPlaceholder: 'sk-ant-…',
    authMethods: [AUTH_METHODS.API_KEY],
    apiVersion: '2023-06-01',
    // Current Claude models think by default; the floor keeps short replies
    // from being cut off before any text is written, and low effort keeps
    // chat-style requests fast and cheap.
    maxTokensFloor: 4096,
    effort: 'low',
    defaultModel: 'claude-opus-5-5',
    models: [
      // refusalFallback: on a safety decline the API re-runs the request on a
      // fallback model in the same call (server-side-fallback beta).
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', pricing: { input: 4.00, output: 20.00 }, refusalFallback: true },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', pricing: { input: 2.00, output: 10.00 }, refusalFallback: true },
      // Haiku 5.5's listed price applies to prompts up to 100K input tokens.
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', pricing: { input: 0.10, output: 0.50, longContextThreshold: 100000, longInput: 0.50, longOutput: 2.50 } },
    ],
  },
  groq: {
    id: 'groq',
    label: 'Groq (open-source models)',
    description: 'Fast hosted open-source models with a free tier.',
    kind: 'openai-compatible',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    verifyUrl: 'https://api.groq.com/openai/v1/models',
    keyUrl: 'https://console.groq.com/keys',
    revokeUrl: 'https://console.groq.com/keys',
    keyPattern: /^gsk_[A-Za-z0-9]{20,}$/,
    keyPlaceholder: 'gsk_…',
    authMethods: [AUTH_METHODS.API_KEY],
    defaultModel: 'llama-3.1-8b-instant',
    models: [
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant', pricing: null },
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile', pricing: null },
      { id: 'gemma2-9b-it', label: 'Gemma 2 9B', pricing: null },
    ],
  },
  together: {
    id: 'together',
    label: 'Together AI (free models)',
    description: 'Hosted open-source models, some free.',
    kind: 'openai-compatible',
    endpoint: 'https://api.together.xyz/v1/chat/completions',
    verifyUrl: 'https://api.together.xyz/v1/models',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
    revokeUrl: 'https://api.together.xyz/settings/api-keys',
    keyPattern: /^[A-Za-z0-9_-]{20,}$/,
    keyPlaceholder: 'Together API key',
    authMethods: [AUTH_METHODS.API_KEY],
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', label: 'Llama 3.3 70B Turbo (free)', pricing: { input: 0, output: 0 } },
      { id: 'Qwen/Qwen2.5-7B-Instruct-Turbo', label: 'Qwen 2.5 7B Turbo', pricing: null },
    ],
  },
  huggingface: {
    id: 'huggingface',
    label: 'Hugging Face Inference (router)',
    description: 'Hugging Face Inference Providers via a user access token.',
    kind: 'openai-compatible',
    endpoint: 'https://router.huggingface.co/v1/chat/completions',
    verifyUrl: 'https://huggingface.co/api/whoami-v2',
    keyUrl: 'https://huggingface.co/settings/tokens',
    revokeUrl: 'https://huggingface.co/settings/tokens',
    keyPattern: /^hf_[A-Za-z0-9]{20,}$/,
    keyPlaceholder: 'hf_…',
    authMethods: [AUTH_METHODS.API_KEY],
    defaultModel: 'meta-llama/Llama-3.1-8B-Instruct',
    models: [
      { id: 'meta-llama/Llama-3.1-8B-Instruct', label: 'Llama 3.1 8B Instruct', pricing: null },
      { id: 'mistralai/Mistral-7B-Instruct-v0.3', label: 'Mistral 7B Instruct', pricing: null },
      { id: 'Qwen/Qwen2.5-7B-Instruct', label: 'Qwen 2.5 7B Instruct', pricing: null },
    ],
  },
});

export const DEFAULT_PROVIDER = 'openrouter';

/** Request limits enforced identically in the browser and in ai-proxy. */
export const CHAT_LIMITS = Object.freeze({
  maxMessages: 40,
  maxMessageChars: 12000,
  maxTotalChars: 60000,
  maxTokens: 4000,
  minTemperature: 0,
  maxTemperature: 2,
  timeoutMs: 45000,
});

export const ALLOWED_ROLES = Object.freeze(['system', 'user', 'assistant']);
export const ALLOWED_FEATURES = Object.freeze(['coach', 'recipe', 'meal_plan', 'other']);

export function listProviders() { return Object.values(PROVIDERS); }

export function getProvider(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : null;
}

export function requireProvider(id) {
  const p = getProvider(id);
  if (!p) throw new AIError(C.UNSUPPORTED_PROVIDER);
  return p;
}

export function getModel(providerId, modelId) {
  return getProvider(providerId)?.models.find(m => m.id === modelId) || null;
}

/** The model to use: the requested one if the provider offers it, else the provider default. */
export function resolveModel(providerId, modelId) {
  const p = requireProvider(providerId);
  return getModel(providerId, modelId) ? modelId : p.defaultModel;
}

export function supportsAuthMethod(providerId, method) {
  return !!getProvider(providerId)?.authMethods.includes(method);
}

/** "••••abcd" — the only part of a key ever shown again or stored in plain text. */
export function keyHint(apiKey) {
  const k = String(apiKey || '');
  return k.length >= 8 ? `••••${k.slice(-4)}` : '••••';
}

/**
 * Validates what a user submits when connecting with an API key. Shape checks
 * only — the definitive check is a live verify call to the provider.
 */
export function validateConnectionInput({ provider, model, apiKey }) {
  const p = getProvider(provider);
  if (!p) throw new AIError(C.UNSUPPORTED_PROVIDER);
  if (model !== undefined && model !== null && model !== '' && !getModel(provider, model)) {
    throw new AIError(C.UNSUPPORTED_MODEL, undefined, { provider: p.id, providerLabel: p.label });
  }
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw new AIError(C.INVALID_INPUT, 'Enter an API key.');
  if (key.length > 512 || /\s/.test(key)) throw new AIError(C.INVALID_INPUT, 'That API key contains spaces or is too long. Paste it exactly as the provider shows it.');
  if (p.keyPattern && !p.keyPattern.test(key)) {
    throw new AIError(C.INVALID_INPUT, `That doesn't look like a ${p.label} API key (expected ${p.keyPlaceholder}). Check you copied the whole key from the provider's website.`);
  }
  return { provider: p.id, model: resolveModel(p.id, model), apiKey: key };
}

/**
 * Validates and normalizes a chat request. Throws AIError on anything a
 * malicious or buggy client could send to run up cost or abuse the proxy.
 */
export function validateChatRequest({ provider, model, messages, temperature, maxTokens, feature }) {
  const p = getProvider(provider);
  if (!p) throw new AIError(C.UNSUPPORTED_PROVIDER);
  if (!getModel(provider, model)) throw new AIError(C.UNSUPPORTED_MODEL, undefined, { provider: p.id, providerLabel: p.label });
  if (!Array.isArray(messages) || messages.length === 0) throw new AIError(C.INVALID_INPUT, 'The AI request had no messages.');
  if (messages.length > CHAT_LIMITS.maxMessages) throw new AIError(C.INVALID_INPUT, 'The conversation is too long to send in one request.');
  let total = 0;
  const clean = messages.map((m) => {
    if (!m || !ALLOWED_ROLES.includes(m.role) || typeof m.content !== 'string') throw new AIError(C.INVALID_INPUT, 'The AI request contained an invalid message.');
    if (m.content.length > CHAT_LIMITS.maxMessageChars) throw new AIError(C.INVALID_INPUT, 'One of the messages is too long.');
    total += m.content.length;
    return { role: m.role, content: m.content };
  });
  if (total > CHAT_LIMITS.maxTotalChars) throw new AIError(C.INVALID_INPUT, 'The AI request is too long.');
  const t = temperature === undefined || temperature === null ? 0.7 : Number(temperature);
  if (!Number.isFinite(t) || t < CHAT_LIMITS.minTemperature || t > CHAT_LIMITS.maxTemperature) throw new AIError(C.INVALID_INPUT, 'Invalid temperature.');
  const mt = maxTokens === undefined || maxTokens === null ? 900 : Math.floor(Number(maxTokens));
  if (!Number.isFinite(mt) || mt < 1) throw new AIError(C.INVALID_INPUT, 'Invalid max tokens.');
  return {
    provider: p.id,
    model,
    messages: clean,
    temperature: t,
    maxTokens: Math.min(mt, CHAT_LIMITS.maxTokens),
    feature: ALLOWED_FEATURES.includes(feature) ? feature : 'other',
  };
}

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/* ------------------------------- Adapters ------------------------------- */

export const openAICompatibleAdapter = {
  buildChatRequest({ provider, model, apiKey, messages, temperature, maxTokens }) {
    const body = {
      model,
      messages,
      temperature,
      [provider.tokenParam || 'max_tokens']: maxTokens,
      ...(provider.extraBody || {}),
    };
    return {
      url: provider.endpoint,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...(provider.extraHeaders || {}) },
        body: JSON.stringify(body),
      },
    };
  },

  parseChatResponse(json, { model }) {
    const choice = json?.choices?.[0];
    const text = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '';
    const u = json?.usage || {};
    return {
      text,
      servedModel: typeof json?.model === 'string' ? json.model : model,
      finishReason: choice?.finish_reason || null,
      usage: {
        inputTokens: numOrNull(u.prompt_tokens),
        outputTokens: numOrNull(u.completion_tokens),
        providerCostUsd: numOrNull(u.cost), // OpenRouter, when usage.include is set
      },
    };
  },

  buildVerifyRequest({ provider, apiKey }) {
    if (!provider.verifyUrl) return null;
    return { url: provider.verifyUrl, init: { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } } };
  },
};

/** Claude requires alternating user/assistant turns starting with user; system goes top-level. */
function toAnthropicMessages(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const turns = messages.filter(m => m.role !== 'system');
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return { system, turns: turns.map(m => ({ role: m.role, content: m.content })) };
}

export const anthropicAdapter = {
  buildChatRequest({ provider, model, apiKey, messages, maxTokens, context }) {
    const { system, turns } = toAnthropicMessages(messages);
    if (!turns.length) throw new AIError(C.INVALID_INPUT, 'The AI request had no user message.');
    const modelInfo = provider.models.find(m => m.id === model) || {};
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': provider.apiVersion,
    };
    // Anthropic's documented opt-in for calling the API straight from a
    // browser with the user's own key (guest / "this device only" mode).
    if (context === 'browser') headers['anthropic-dangerous-direct-browser-access'] = 'true';
    if (modelInfo.refusalFallback) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    // No temperature: current Claude models reject non-default sampling values.
    const body = {
      model,
      max_tokens: Math.max(maxTokens, provider.maxTokensFloor || 0),
      messages: turns,
      ...(system ? { system } : {}),
      ...(provider.effort ? { output_config: { effort: provider.effort } } : {}),
      ...(modelInfo.refusalFallback ? { fallbacks: 'default' } : {}),
    };
    return { url: provider.endpoint, init: { method: 'POST', headers, body: JSON.stringify(body) } };
  },

  parseChatResponse(json, { model }) {
    if (json?.stop_reason === 'refusal') throw new AIError(C.REFUSED);
    const text = (Array.isArray(json?.content) ? json.content : [])
      .filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text).join('').trim();
    const u = json?.usage || {};
    const input = numOrNull(u.input_tokens);
    const cacheTokens = (numOrNull(u.cache_creation_input_tokens) || 0) + (numOrNull(u.cache_read_input_tokens) || 0);
    return {
      text,
      servedModel: typeof json?.model === 'string' ? json.model : model,
      finishReason: json?.stop_reason || null,
      usage: {
        inputTokens: input === null ? null : input + cacheTokens,
        outputTokens: numOrNull(u.output_tokens),
        providerCostUsd: null, // Anthropic does not return per-request cost
      },
    };
  },

  buildVerifyRequest({ provider, apiKey, context }) {
    const headers = { 'x-api-key': apiKey, 'anthropic-version': provider.apiVersion };
    if (context === 'browser') headers['anthropic-dangerous-direct-browser-access'] = 'true';
    return { url: provider.verifyUrl, init: { method: 'GET', headers } };
  },
};

export const ADAPTERS = Object.freeze({
  'openai-compatible': openAICompatibleAdapter,
  anthropic: anthropicAdapter,
});

export function getAdapter(providerOrId) {
  const provider = typeof providerOrId === 'string' ? requireProvider(providerOrId) : providerOrId;
  const adapter = ADAPTERS[provider.kind];
  if (!adapter) throw new AIError(C.UNSUPPORTED_PROVIDER);
  return adapter;
}
