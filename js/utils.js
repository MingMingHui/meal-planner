/**
 * utils.js
 * ----------------------------------------------------------------------------
 * Purpose: Small stateless helpers shared by storage.js, syncManager.js and
 *          cloudStorage.js that don't belong in ui.js (which is DOM-focused).
 * Inputs:  Varies per function.
 * Outputs: Varies per function — see JSDoc on each export.
 * Depends on: nothing.
 * ----------------------------------------------------------------------------
 */

export function nowISO() {
  return new Date().toISOString();
}

export function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

export function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export function generateId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * "Latest updated_at wins" conflict resolution for single-object records
 * (profile / meal plan / shopping list / settings). Returns whichever of
 * localRecord / cloudRecord is newer, or the local one if timestamps are
 * missing/equal (so first-time cloud sync doesn't clobber real local data).
 * @param {{updatedAt?: string}} localRecord
 * @param {{updated_at?: string}} cloudRecord
 */
export function pickNewer(localRecord, cloudRecord) {
  if (!cloudRecord) return { winner: 'local', value: localRecord };
  if (!localRecord) return { winner: 'cloud', value: cloudRecord };
  const localTime = Date.parse(localRecord.updatedAt || 0) || 0;
  const cloudTime = Date.parse(cloudRecord.updated_at || 0) || 0;
  return cloudTime > localTime ? { winner: 'cloud', value: cloudRecord } : { winner: 'local', value: localRecord };
}

/**
 * Merges two arrays of dated entries (e.g. weightLog) keyed by `dateKey`,
 * preferring whichever entry is present — used when both local and cloud
 * have logs for overlapping-but-not-identical date ranges. Cloud entries
 * win on exact date collisions since the cloud copy was, by definition,
 * already synced from some device including possibly this one.
 */
export function mergeByDate(localEntries = [], cloudEntries = [], dateKey = 'date') {
  const map = new Map();
  localEntries.forEach(e => map.set(e[dateKey], e));
  cloudEntries.forEach(e => map.set(e[dateKey], e)); // cloud overwrites same-date local
  return [...map.values()].sort((a, b) => String(a[dateKey]).localeCompare(String(b[dateKey])));
}

export function debounce(fn, ms = 800) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
