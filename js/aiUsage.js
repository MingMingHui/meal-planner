/**
 * aiUsage.js
 * ----------------------------------------------------------------------------
 * Purpose: Where AI token-usage records are kept and read back from.
 *            - Account-stored keys: ai-proxy records usage server-side
 *              (recorded_by 'server'); nothing to do here.
 *            - Device keys of signed-in users: inserted into the user's own
 *              ai_usage_records rows (recorded_by 'client'); if that fails
 *              (offline), kept locally as pending and retried later.
 *            - Guests: kept only in this tab's session storage (Storage's
 *              guest backend), like every other piece of guest data.
 *          Local records carry an ownerId, so one person's history is never
 *          shown to the next person who uses this browser.
 * Inputs:  Usage records from ai/usage.js buildUsageRecord().
 * Outputs: Filtered, merged usage lists for the AI Usage view.
 * Depends on: storage.js, auth.js, cloudStorage.js, aiConnections.js, ai/usage.js.
 * ----------------------------------------------------------------------------
 */

import Storage from './storage.js';
import { isCloudConfigured } from './auth.js';
import { insertAIUsage, loadAIUsage } from './cloudStorage.js';
import { currentOwnerId, isGuestUser } from './aiConnections.js';
import { filterUsage, mergeUsageLists, normalizeUsageRecord } from './ai/usage.js';
import { generateId } from './utils.js';

function cloudUsageEnabled() { return !isGuestUser() && isCloudConfigured(); }

function appendLocal(record, extra = {}) {
  const list = Storage.getAIUsage();
  list.push({ ...record, id: record.id || generateId('usage'), ownerId: currentOwnerId(), ...extra });
  Storage.saveAIUsage(list);
}

/** Stores one usage record in the right place for the current user. Never throws. */
export async function recordUsage(record) {
  if (!record || record.recordedBy === 'server') return; // ai-proxy already stored it
  if (!cloudUsageEnabled()) { appendLocal(record); return; }
  try {
    await insertAIUsage(record);
  } catch {
    appendLocal(record, { pending: true });
  }
}

/** Retries pending local records for the signed-in user. */
export async function flushPendingUsage() {
  if (!cloudUsageEnabled()) return 0;
  const owner = currentOwnerId();
  const list = Storage.getAIUsage();
  const pending = list.filter(r => r.pending && r.ownerId === owner);
  if (!pending.length) return 0;
  const sent = new Set();
  for (const r of pending) {
    const { id, ownerId, pending: _p, ...record } = r; // eslint-disable-line no-unused-vars
    try { await insertAIUsage(record); sent.add(id); } catch { break; } // still offline — try again later
  }
  Storage.saveAIUsage(Storage.getAIUsage().filter(r => !sent.has(r.id)));
  return sent.size;
}

/**
 * Usage history for the current user/guest, filtered and newest first.
 * @returns {Promise<{records: object[], scope: 'session'|'account'|'device', cloudError: Error|null, pendingCount: number}>}
 */
export async function listUsage(filters = {}) {
  const owner = currentOwnerId();
  let cloudRecords = [];
  let cloudError = null;
  if (cloudUsageEnabled()) {
    await flushPendingUsage().catch(() => 0);
    try { cloudRecords = await loadAIUsage(filters); } catch (err) { cloudError = err; }
  }
  const local = Storage.getAIUsage().filter(r => r.ownerId === owner).map(normalizeUsageRecord);
  return {
    records: filterUsage(mergeUsageLists(cloudRecords, local), filters),
    scope: isGuestUser() ? 'session' : cloudUsageEnabled() ? 'account' : 'device',
    cloudError,
    pendingCount: local.filter(r => r.pending).length,
  };
}
