/**
 * Token usage arithmetic (js/ai/usage.js) and the DB row contract
 * (js/ai/contract.js) — shared by the apps and the ai-proxy Edge Function.
 */
import { describe, it, expect } from 'vitest';
import {
  buildUsageRecord, estimateCostUsd, estimateTokens, filterUsage, summarizeUsage, groupUsageByModel,
  currentPeriod, mergeUsageLists, normalizeUsageRecord,
} from '../../js/ai/usage.js';
import { usageRecordToRow, rowToUsageRecord, toPublicConnection, PUBLIC_CONNECTION_COLUMNS } from '../../js/ai/contract.js';

const base = { feature: 'coach', recordedBy: 'client' };

describe('buildUsageRecord', () => {
  it('records provider-reported input/output tokens and computes the total', () => {
    const r = buildUsageRecord({ ...base, provider: 'anthropic', model: 'claude-sonnet-5-5', status: 'success', usage: { inputTokens: 1200, outputTokens: 300, providerCostUsd: null } });
    expect(r).toMatchObject({ inputTokens: 1200, outputTokens: 300, totalTokens: 1500, tokenSource: 'provider', costSource: 'estimated' });
    // $2/M input + $10/M output
    expect(r.estimatedCostUsd).toBeCloseTo(1200 * 2e-6 + 300 * 10e-6, 10);
  });

  it('uses the provider-reported cost when given (OpenRouter)', () => {
    const r = buildUsageRecord({ ...base, provider: 'openrouter', model: 'meta-llama/llama-3.1-8b-instruct:free', status: 'success', usage: { inputTokens: 10, outputTokens: 5, providerCostUsd: 0.000321 } });
    expect(r).toMatchObject({ estimatedCostUsd: 0.000321, costSource: 'provider' });
  });

  it('labels estimates when the provider reports no tokens, and never invents a price', () => {
    const r = buildUsageRecord({ ...base, provider: 'groq', model: 'llama-3.1-8b-instant', status: 'success', usage: { inputTokens: null, outputTokens: null }, messages: [{ content: 'x'.repeat(40) }], responseText: 'y'.repeat(8) });
    expect(r).toMatchObject({ inputTokens: 10, outputTokens: 2, totalTokens: 12, tokenSource: 'estimated', estimatedCostUsd: null, costSource: 'unavailable' });
  });

  it('records failed requests with zero tokens and the error code', () => {
    const r = buildUsageRecord({ ...base, provider: 'openai', model: 'gpt-4.1-mini', status: 'error', errorCode: 'rate_limited' });
    expect(r).toMatchObject({ status: 'error', errorCode: 'rate_limited', inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 });
  });

  it('prices the model that actually answered (e.g. a refusal fallback) when it is known', () => {
    const r = buildUsageRecord({ ...base, provider: 'anthropic', model: 'claude-opus-5-5', servedModel: 'claude-sonnet-5-5', status: 'success', usage: { inputTokens: 1e6, outputTokens: 0 } });
    expect(r.model).toBe('claude-sonnet-5-5');
    expect(r.estimatedCostUsd).toBe(2);
  });

  it('never contains prompt or response text', () => {
    const r = buildUsageRecord({ ...base, provider: 'groq', model: 'llama-3.1-8b-instant', status: 'success', usage: {}, messages: [{ content: 'my private diagnosis' }], responseText: 'secret reply' });
    expect(JSON.stringify(r)).not.toMatch(/diagnosis|secret reply/);
  });
});

describe('cost estimates', () => {
  it('applies Haiku 5.5 long-context rates above 100K input tokens', () => {
    expect(estimateCostUsd('anthropic', 'claude-haiku-5-5', 100000, 1000)).toBeCloseTo(0.01 + 0.0005, 10);
    expect(estimateCostUsd('anthropic', 'claude-haiku-5-5', 200000, 1000)).toBeCloseTo(0.1 + 0.0025, 10);
  });
  it('returns null for unpriced or unknown models', () => {
    expect(estimateCostUsd('huggingface', 'Qwen/Qwen2.5-7B-Instruct', 10, 10)).toBeNull();
    expect(estimateCostUsd('openai', 'unknown', 10, 10)).toBeNull();
  });
  it('estimateTokens is ~4 chars per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

const rec = (over) => normalizeUsageRecord({ provider: 'openai', model: 'gpt-4.1-mini', status: 'success', inputTokens: 100, outputTokens: 50, tokenSource: 'provider', estimatedCostUsd: 0.001, costSource: 'estimated', recordedBy: 'server', feature: 'coach', createdAt: '2026-11-10T10:00:00.000Z', ...over });

describe('filters and summaries', () => {
  const list = [
    rec({ id: '1' }),
    rec({ id: '2', provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 1000, outputTokens: 10, estimatedCostUsd: 0.0042, createdAt: '2026-11-15T10:00:00.000Z' }),
    rec({ id: '3', provider: 'groq', model: 'llama-3.1-8b-instant', estimatedCostUsd: null, costSource: 'unavailable', createdAt: '2026-10-01T10:00:00.000Z' }),
    rec({ id: '4', status: 'error', inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, createdAt: '2026-11-20T10:00:00.000Z' }),
  ];

  it('filters by provider, model and inclusive date range', () => {
    expect(filterUsage(list, { provider: 'anthropic' }).map(r => r.id)).toEqual(['2']);
    expect(filterUsage(list, { provider: 'openai', model: 'gpt-4.1-mini' }).map(r => r.id)).toEqual(['1', '4']);
    expect(filterUsage(list, { from: '2026-11-01', to: '2026-11-15' }).map(r => r.id)).toEqual(['1', '2']);
    expect(filterUsage(list, { to: '2026-10-31' }).map(r => r.id)).toEqual(['3']);
  });

  it('summarizes totals, failures and cost completeness', () => {
    const s = summarizeUsage(list);
    expect(s).toMatchObject({ requests: 4, successfulRequests: 3, failedRequests: 1, inputTokens: 1200, outputTokens: 110, totalTokens: 1310, costComplete: false });
    expect(s.estimatedCostUsd).toBeCloseTo(0.0052, 10);
    expect(summarizeUsage(filterUsage(list, { provider: 'anthropic' })).costComplete).toBe(true);
  });

  it('groups by provider + model, biggest first', () => {
    const g = groupUsageByModel(list);
    expect(g[0]).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', totalTokens: 1010, requests: 1 });
    expect(g.find(x => x.model === 'gpt-4.1-mini').requests).toBe(2);
  });

  it('current period is the calendar month', () => {
    expect(currentPeriod(new Date(2026, 1, 10))).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('merges lists newest first without duplicates', () => {
    expect(mergeUsageLists([list[0], list[1]], [list[1], list[3]]).map(r => r.id)).toEqual(['4', '2', '1']);
  });

  it('normalize recomputes totals instead of trusting stored ones', () => {
    expect(normalizeUsageRecord({ inputTokens: 3, outputTokens: 4, totalTokens: 999 }).totalTokens).toBe(7);
  });
});

describe('API contract (shared by apps and ai-proxy)', () => {
  it('usage record <-> row round-trips and never sends total_tokens (generated column)', () => {
    const r = buildUsageRecord({ ...base, provider: 'openai', model: 'gpt-4.1-mini', status: 'success', usage: { inputTokens: 7, outputTokens: 3 }, createdAt: '2026-11-01T00:00:00.000Z' });
    const row = usageRecordToRow(r, 'user-1');
    expect(row.user_id).toBe('user-1');
    expect(row).not.toHaveProperty('total_tokens');
    const back = rowToUsageRecord({ ...row, id: 'x', total_tokens: 10, estimated_cost_usd: String(row.estimated_cost_usd) });
    expect(back).toMatchObject({ inputTokens: 7, outputTokens: 3, totalTokens: 10, provider: 'openai', recordedBy: 'client' });
    expect(typeof back.estimatedCostUsd).toBe('number'); // Postgres numeric arrives as a string
  });

  it('public connections never include credential columns', () => {
    const pub = toPublicConnection({ provider: 'openai', auth_method: 'api_key', model: 'gpt-4.1-mini', key_hint: '••••1234', status: 'active', credential_ciphertext: 'v1:aaa:bbb', user_id: 'u' });
    expect(JSON.stringify(pub)).not.toMatch(/ciphertext|v1:aaa|user_id/);
    expect(PUBLIC_CONNECTION_COLUMNS).not.toMatch(/credential/);
  });
});
