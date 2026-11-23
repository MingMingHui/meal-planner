// @vitest-environment jsdom
/**
 * Loads both page entry points of the shared web app so a broken import or
 * syntax error anywhere in js/ fails CI before it reaches the Android build.
 * (jsdom has already fired DOMContentLoaded, so the apps don't boot here.)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const jsDir = path.resolve(__dirname, '../../js');

describe('web app module graph', () => {
  it('dashboard.html entry (js/app.js) and every module it imports load', async () => {
    await expect(import('../../js/app.js')).resolves.toBeDefined();
  });

  it('index.html entry (js/authGate.js) loads', async () => {
    await expect(import('../../js/authGate.js')).resolves.toBeDefined();
  });

  it('every file in js/ is reachable from an entry point', async () => {
    const files = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'));
    const sources = files.map(f => fs.readFileSync(path.join(jsDir, f), 'utf8')).join('\n');
    for (const f of files.filter(f => !['app.js', 'authGate.js'].includes(f))) {
      expect(sources, f).toContain(`./${f}'`);
    }
  });
});
