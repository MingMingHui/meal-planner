/**
 * ai/contract.js
 * ----------------------------------------------------------------------------
 * Purpose: The API contract between the app (web + Android) and the backend:
 *          the ai-proxy Edge Function's actions and the shape of the rows in
 *          ai_provider_connections / ai_usage_records. Both sides import
 *          this file, so a contract change is one edit, and the tests check
 *          both sides against it.
 * Inputs:  Database rows / usage records.
 * Outputs: Public (secret-free) connection objects, DB rows, usage records.
 * Depends on: ./usage.js
 * ----------------------------------------------------------------------------
 */

import { normalizeUsageRecord } from './usage.js';

export const AI_PROXY_FUNCTION = 'ai-proxy';

/**
 * POST /functions/v1/ai-proxy with JSON { action, ...payload } and the
 * user's Supabase access token as Authorization: Bearer.
 *   health          {}                                   -> { ok, encryptionConfigured }
 *   save_key        { provider, model, apiKey }          -> { connection }
 *   oauth_exchange  { provider, model, code, codeVerifier } -> { connection }
 *   disconnect      { provider }                         -> { disconnected }
 *   chat            { provider, model, messages, temperature, maxTokens, feature }
 *                                                        -> { text, model, usage }
 * Errors: HTTP 4xx/5xx with { error: { code, message } } (codes: errors.js).
 */
export const PROXY_ACTIONS = Object.freeze({
  HEALTH: 'health',
  SAVE_KEY: 'save_key',
  OAUTH_EXCHANGE: 'oauth_exchange',
  DISCONNECT: 'disconnect',
  CHAT: 'chat',
});

/**
 * Columns the `authenticated` role may read from ai_provider_connections
 * (column-level GRANT in supabase/ai_providers.sql). The encrypted
 * credential columns are deliberately absent.
 */
export const PUBLIC_CONNECTION_COLUMNS = 'provider,auth_method,model,key_hint,status,last_error_code,last_verified_at,updated_at';

/** The only view of a stored connection that ever leaves the server. */
export function toPublicConnection(row) {
  if (!row) return null;
  return {
    provider: row.provider,
    authMethod: row.auth_method,
    model: row.model,
    keyHint: row.key_hint,
    status: row.status,
    lastErrorCode: row.last_error_code ?? null,
    lastVerifiedAt: row.last_verified_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export const USAGE_COLUMNS = 'id,provider,model,feature,status,error_code,input_tokens,output_tokens,total_tokens,token_source,estimated_cost_usd,cost_source,recorded_by,latency_ms,created_at';

/** Usage record -> ai_usage_records insert row. total_tokens is a generated column and never sent. */
export function usageRecordToRow(record, userId) {
  return {
    user_id: userId,
    provider: record.provider,
    model: record.model,
    feature: record.feature,
    status: record.status,
    error_code: record.errorCode,
    input_tokens: record.inputTokens,
    output_tokens: record.outputTokens,
    token_source: record.tokenSource,
    estimated_cost_usd: record.estimatedCostUsd,
    cost_source: record.costSource,
    recorded_by: record.recordedBy,
    latency_ms: record.latencyMs,
    created_at: record.createdAt,
  };
}

export function rowToUsageRecord(row) {
  return normalizeUsageRecord({
    id: row.id,
    provider: row.provider,
    model: row.model,
    feature: row.feature,
    status: row.status,
    errorCode: row.error_code,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    tokenSource: row.token_source,
    estimatedCostUsd: row.estimated_cost_usd,
    costSource: row.cost_source,
    recordedBy: row.recorded_by,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
  });
}
