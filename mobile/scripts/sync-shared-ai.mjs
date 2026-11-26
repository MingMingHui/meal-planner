#!/usr/bin/env node
/**
 * sync-shared-ai.mjs — copies the shared AI core (js/ai/*.js) into
 * supabase/functions/_shared/ai/ for the ai-proxy Edge Function.
 * ----------------------------------------------------------------------------
 * js/ai/ is the single source of truth: the web app and the Android app run
 * it directly, and the Edge Function runs this byte-identical copy (Supabase
 * bundles a function from supabase/functions/, so it can't reliably import
 * ../../js). tests/shared-ai-sync.test.js fails if the copy drifts.
 *
 * Usage: npm run sync:shared-ai          (writes the copy)
 *        npm run sync:shared-ai -- --check (exit 1 if out of date)
 * ----------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SOURCE_DIR = path.join(REPO_ROOT, 'js', 'ai');
export const TARGET_DIR = path.join(REPO_ROOT, 'supabase', 'functions', '_shared', 'ai');

export function sourceFiles() {
  return fs.readdirSync(SOURCE_DIR).filter(f => f.endsWith('.js')).sort();
}

/** Files whose copy is missing, different, or stale (present in target but not in source). */
export function findDrift() {
  const src = sourceFiles();
  const drift = src.filter((f) => {
    const target = path.join(TARGET_DIR, f);
    return !fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== fs.readFileSync(path.join(SOURCE_DIR, f), 'utf8');
  });
  const extra = fs.existsSync(TARGET_DIR) ? fs.readdirSync(TARGET_DIR).filter(f => f.endsWith('.js') && !src.includes(f)) : [];
  return { drift, extra };
}

function main() {
  const check = process.argv.includes('--check');
  const { drift, extra } = findDrift();
  if (check) {
    if (drift.length || extra.length) {
      console.error(`[sync-shared-ai] out of date: ${[...drift, ...extra].join(', ')}. Run: npm run sync:shared-ai`);
      process.exit(1);
    }
    console.log('[sync-shared-ai] up to date.');
    return;
  }
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  for (const f of sourceFiles()) fs.copyFileSync(path.join(SOURCE_DIR, f), path.join(TARGET_DIR, f));
  for (const f of extra) fs.rmSync(path.join(TARGET_DIR, f));
  console.log(`[sync-shared-ai] copied ${sourceFiles().length} files to supabase/functions/_shared/ai/.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
