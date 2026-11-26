/**
 * Web/mobile/backend parity: one AI core, three consumers.
 *   - js/ai/ is run directly by the web app and (packaged by build-web.mjs)
 *     by the Android app.
 *   - supabase/functions/_shared/ai/ must be a byte-identical copy for the
 *     ai-proxy Edge Function.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { findDrift, sourceFiles } from '../scripts/sync-shared-ai.mjs';

const repoRoot = path.resolve(__dirname, '../..');

describe('shared AI core', () => {
  it('the Edge Function copy matches js/ai exactly (run `npm run sync:shared-ai` if this fails)', () => {
    expect(sourceFiles().length).toBeGreaterThan(0);
    expect(findDrift()).toEqual({ drift: [], extra: [] });
  });

  it('the Android build packages js/ (including js/ai/) unchanged', () => {
    const build = fs.readFileSync(path.join(repoRoot, 'mobile/scripts/build-web.mjs'), 'utf8');
    expect(build).toMatch(/const WEB_DIRS = \[[^\]]*'js'/);
    expect(build).toMatch(/for \(const dir of WEB_DIRS\) fs\.cpSync\(.*\{ recursive: true \}\)/);
  });

  it('the server handler and the apps use the same contract module', () => {
    const handler = fs.readFileSync(path.join(repoRoot, 'supabase/functions/ai-proxy/handler.js'), 'utf8');
    const cloud = fs.readFileSync(path.join(repoRoot, 'js/cloudStorage.js'), 'utf8');
    expect(handler).toContain("from '../_shared/ai/contract.js'");
    expect(cloud).toContain("from './ai/contract.js'");
  });

  it('shared AI modules stay platform-neutral (no DOM, Storage or app imports)', () => {
    for (const f of sourceFiles()) {
      const src = fs.readFileSync(path.join(repoRoot, 'js/ai', f), 'utf8');
      expect(src, f).not.toMatch(/\b(document|localStorage|sessionStorage|window)\b\./);
      expect(src, f).not.toMatch(/from '\.\.\//);
    }
  });

  it('no real-looking credentials are committed in the AI code or docs', () => {
    const files = [
      ...sourceFiles().map(f => `js/ai/${f}`),
      'js/aiConnections.js', 'js/aiUsage.js', 'js/aiViews.js', 'js/ai.js',
      'supabase/functions/ai-proxy/handler.js', 'supabase/functions/ai-proxy/index.ts', 'supabase/functions/ai-proxy/credentials.js',
      'supabase/ai_providers.sql', 'docs/ai-providers.md', 'supabase/functions/.env.example',
    ];
    for (const f of files) {
      const p = path.join(repoRoot, f);
      if (!fs.existsSync(p)) continue;
      const src = fs.readFileSync(p, 'utf8');
      expect(src, f).not.toMatch(/\bsk-(proj-|ant-|or-)?[A-Za-z0-9]{32,}/);
      expect(src, f).not.toMatch(/\bgsk_[A-Za-z0-9]{32,}/);
    }
  });
});
