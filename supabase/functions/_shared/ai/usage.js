/**
 * ai/usage.js
 * ----------------------------------------------------------------------------
 * Purpose: Token-usage records and their arithmetic — shared by the browser
 *          (web + Android) and the ai-proxy Edge Function so totals, cost
 *          estimates, filters and summaries are computed identically
 *          everywhere.
 *
 *          Every number is labelled with where it came from:
 *            tokenSource 'provider'   tokens the provider reported in its response
 *            tokenSource 'estimated'  the provider reported nothing; ~4 chars/token
 *            costSource  'provider'   the provider reported the charge (OpenRouter)
 *            costSource  'estimated'  tokens × our pricing table (PRICING_AS_OF)
 *            costSource  'unavailable' no reliable price — no cost is shown
 *          Nothing is invented: a failed request is recorded with 0 tokens.
 *          Prompts and responses are NEVER part of a usage record.
 * Inputs:  Parsed adapter usage, plain record arrays, filter objects.
 * Outputs: Usage records, filtered lists, summaries.
 * Depends on: ./providers.js
 * ----------------------------------------------------------------------------
 */

import { getModel, getProvider } from './providers.js';

export const TOKEN_SOURCES = Object.freeze({ PROVIDER: 'provider', ESTIMATED: 'estimated' });
export const COST_SOURCES = Object.freeze({ PROVIDER: 'provider', ESTIMATED: 'estimated', UNAVAILABLE: 'unavailable' });

/** Rough token estimate (≈4 characters per token for English text). Only used when the provider reports nothing. */
export function estimateTokens(text) {
  const n = String(text || '').length;
  return n === 0 ? 0 : Math.ceil(n / 4);
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Estimated USD cost from our pricing table, or null when we have no
 * reliable price for this provider/model.
 */
export function estimateCostUsd(providerId, modelId, inputTokens, outputTokens) {
  const pricing = getModel(providerId, modelId)?.pricing;
  if (!pricing) return null;
  const long = pricing.longContextThreshold && inputTokens > pricing.longContextThreshold;
  const inRate = long ? pricing.longInput : pricing.input;
  const outRate = long ? pricing.longOutput : pricing.output;
  return round6(((inputTokens || 0) * inRate + (outputTokens || 0) * outRate) / 1e6);
}

/**
 * Builds the canonical usage record for one AI request.
 * @param {object} p
 * @param {string} p.provider
 * @param {string} p.model           model we asked for (must be in the registry)
 * @param {string} [p.servedModel]   model the provider says answered (may differ, e.g. a refusal fallback)
 * @param {{inputTokens:number|null, outputTokens:number|null, providerCostUsd:number|null}} [p.usage]
 * @param {Array<{content:string}>} [p.messages] only used to estimate when the provider reported no tokens
 * @param {string} [p.responseText]  only used to estimate when the provider reported no tokens
 * @param {'success'|'error'} p.status
 * @param {string} [p.errorCode]
 * @param {string} p.feature
 * @param {'server'|'client'} p.recordedBy
 * @param {number} [p.latencyMs]
 * @param {string} [p.createdAt]
 * @param {string} [p.id]
 */
export function buildUsageRecord(p) {
  const success = p.status === 'success';
  let inputTokens = 0;
  let outputTokens = 0;
  /** @type {string} */
  let tokenSource = TOKEN_SOURCES.PROVIDER;

  if (success) {
    /** @type {{inputTokens?:number|null, outputTokens?:number|null}} */
    const u = p.usage || {};
    if (u.inputTokens === null || u.inputTokens === undefined || u.outputTokens === null || u.outputTokens === undefined) {
      tokenSource = TOKEN_SOURCES.ESTIMATED;
      inputTokens = u.inputTokens ?? (p.messages || []).reduce((s, m) => s + estimateTokens(m.content), 0);
      outputTokens = u.outputTokens ?? estimateTokens(p.responseText);
    } else {
      inputTokens = u.inputTokens;
      outputTokens = u.outputTokens;
    }
  }

  // Price the model that actually answered when we know it, else the requested one.
  const pricedModel = getModel(p.provider, p.servedModel) ? p.servedModel : p.model;
  let estimatedCostUsd = null;
  /** @type {string} */
  let costSource = COST_SOURCES.UNAVAILABLE;
  const providerCost = p.usage?.providerCostUsd;
  if (!success) {
    estimatedCostUsd = 0;
    costSource = COST_SOURCES.ESTIMATED;
  } else if (typeof providerCost === 'number' && Number.isFinite(providerCost)) {
    estimatedCostUsd = round6(providerCost);
    costSource = COST_SOURCES.PROVIDER;
  } else {
    const est = estimateCostUsd(p.provider, pricedModel, inputTokens, outputTokens);
    if (est !== null) { estimatedCostUsd = est; costSource = COST_SOURCES.ESTIMATED; }
  }

  return {
    ...(p.id ? { id: p.id } : {}),
    provider: p.provider,
    model: pricedModel,
    feature: p.feature || 'other',
    status: success ? 'success' : 'error',
    errorCode: success ? null : (p.errorCode || 'unknown'),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    tokenSource,
    estimatedCostUsd,
    costSource,
    recordedBy: p.recordedBy,
    latencyMs: Number.isFinite(p.latencyMs) ? Math.round(p.latencyMs) : null,
    createdAt: p.createdAt || new Date().toISOString(),
  };
}

/** Normalizes a record from any store (local or cloud) and recomputes totalTokens. */
export function normalizeUsageRecord(r) {
  const input = Math.max(0, Math.floor(Number(r.inputTokens) || 0));
  const output = Math.max(0, Math.floor(Number(r.outputTokens) || 0));
  const cost = r.estimatedCostUsd === null || r.estimatedCostUsd === undefined ? null : Number(r.estimatedCostUsd);
  return {
    ...r,
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    estimatedCostUsd: Number.isFinite(cost) ? cost : null,
  };
}

/**
 * Date-range / provider / model filter. `from` and `to` are inclusive
 * YYYY-MM-DD strings interpreted in the viewer's local time zone, or full
 * ISO timestamps.
 */
/** @param {object[]} records @param {{from?:string, to?:string, provider?:string, model?:string}} [filters] */
export function filterUsage(records, { from, to, provider, model } = {}) {
  const fromMs = from ? toStartMs(from) : -Infinity;
  const toMs = to ? toEndMs(to) : Infinity;
  return records.filter((r) => {
    const t = Date.parse(r.createdAt);
    if (!Number.isFinite(t) || t < fromMs || t > toMs) return false;
    if (provider && r.provider !== provider) return false;
    if (model && r.model !== model) return false;
    return true;
  });
}

function toStartMs(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00`).getTime() : Date.parse(d); }
function toEndMs(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T23:59:59.999`).getTime() : Date.parse(d); }

/**
 * Totals for a set of records. Cost is summed only over records that have a
 * cost; `costComplete` says whether every successful record had one, and
 * `hasEstimates` whether any number shown is an estimate.
 */
export function summarizeUsage(records) {
  const s = {
    requests: records.length,
    successfulRequests: 0,
    failedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    costComplete: true,
    hasEstimatedTokens: false,
    hasEstimatedCost: false,
  };
  for (const r of records) {
    if (r.status === 'success') s.successfulRequests += 1; else s.failedRequests += 1;
    s.inputTokens += r.inputTokens;
    s.outputTokens += r.outputTokens;
    if (r.tokenSource === TOKEN_SOURCES.ESTIMATED) s.hasEstimatedTokens = true;
    if (r.estimatedCostUsd === null) { if (r.status === 'success') s.costComplete = false; }
    else {
      s.estimatedCostUsd += r.estimatedCostUsd;
      if (r.costSource === COST_SOURCES.ESTIMATED && r.status === 'success') s.hasEstimatedCost = true;
    }
  }
  s.totalTokens = s.inputTokens + s.outputTokens;
  s.estimatedCostUsd = round6(s.estimatedCostUsd);
  return s;
}

/** Per provider+model breakdown, largest token users first. */
export function groupUsageByModel(records) {
  const groups = new Map();
  for (const r of records) {
    const key = `${r.provider}\u0000${r.model}`;
    if (!groups.has(key)) groups.set(key, { provider: r.provider, model: r.model, records: [] });
    groups.get(key).records.push(r);
  }
  return [...groups.values()]
    .map(g => ({ provider: g.provider, model: g.model, providerLabel: getProvider(g.provider)?.label || g.provider, ...summarizeUsage(g.records) }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

/** The current usage period: the calendar month containing `now`, as inclusive YYYY-MM-DD bounds in local time. */
export function currentPeriod(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = now.getFullYear();
  const m = now.getMonth();
  const last = new Date(y, m + 1, 0).getDate();
  return { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(last)}`, label: now.toLocaleString(undefined, { month: 'long', year: 'numeric' }) };
}

/** Newest first, de-duplicated by id (local pending copies vs cloud rows). */
export function mergeUsageLists(...lists) {
  const seen = new Set();
  const out = [];
  for (const r of lists.flat()) {
    const key = r.id || `${r.createdAt}|${r.provider}|${r.model}|${r.totalTokens}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
