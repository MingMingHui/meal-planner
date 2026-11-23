import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vendorCdnScripts, versionSatisfies, injectMobileTags } from '../scripts/build-web.mjs';

const mobileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(mobileDir, '..');
const installed = (pkg) => {
  const p = path.join(mobileDir, 'node_modules', pkg, 'package.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).version : null;
};

describe('versionSatisfies', () => {
  it('matches exact pins and major/minor prefixes', () => {
    expect(versionSatisfies('4.4.4', '4.4.4')).toBe(true);
    expect(versionSatisfies('2.119.2', '2')).toBe(true);
    expect(versionSatisfies('2.119.2', '2.119')).toBe(true);
    expect(versionSatisfies('4.6.1', '4.4.4')).toBe(false);
    expect(versionSatisfies('3.0.0', '2')).toBe(false);
  });
});

describe('vendorCdnScripts', () => {
  it('rewrites CDN tags to vendor/ paths and keeps attributes', () => {
    const html = '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js" defer></script>';
    const { html: out, copies } = vendorCdnScripts(html, () => '4.4.4');
    expect(out).toBe('<script src="./vendor/chart.js/dist/chart.umd.min.js" defer></script>');
    expect(copies).toEqual([{ pkg: 'chart.js', file: 'dist/chart.umd.min.js', rel: 'vendor/chart.js/dist/chart.umd.min.js' }]);
  });

  it('handles scoped packages', () => {
    const html = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js" defer></script>';
    expect(vendorCdnScripts(html, () => '2.119.2').html).toContain('./vendor/@supabase/supabase-js/dist/umd/supabase.js');
  });

  it('fails when the installed version drifts from the web app', () => {
    const html = '<script src="https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js"></script>';
    expect(() => vendorCdnScripts(html, () => '4.2.1')).toThrow(/Keep them in sync/);
    expect(() => vendorCdnScripts(html, () => null)).toThrow(/not installed/);
  });

  it('fails if any remote script is left', () => {
    expect(() => vendorCdnScripts('<script src="https://example.com/x.js"></script>', () => '1.0.0')).toThrow(/remote/);
  });

  it('every CDN script in the real web pages is pinned identically in mobile/package.json', () => {
    for (const page of ['index.html', 'dashboard.html']) {
      const html = fs.readFileSync(path.join(repoRoot, page), 'utf8');
      const { html: out } = vendorCdnScripts(html, installed);
      expect(out).not.toMatch(/cdn\.jsdelivr\.net/);
    }
  });
});

describe('injectMobileTags', () => {
  it('adds mobile.css after styles.css and the runtime config + bridge before </head>', () => {
    const html = fs.readFileSync(path.join(repoRoot, 'dashboard.html'), 'utf8');
    const out = injectMobileTags(html);
    expect(out).toMatch(/styles\.css" \/>\n<link rel="stylesheet" href="\.\/native\/mobile\.css" \/>/);
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head.indexOf('runtime-config.js')).toBeLessThan(head.indexOf('native/bridge.js'));
    // Both must run before the app's module scripts in <body>.
    expect(out.indexOf('native/bridge.js')).toBeLessThan(out.indexOf('./js/app.js'));
  });
});
