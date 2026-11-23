import { describe, it, expect } from 'vitest';
import { parseEnvFile, resolveRuntimeConfig, assertPublishableKey } from '../scripts/env.mjs';

const APP_ID = 'com.ch2digital.mealplannerai';
const PROD_ENV = { SUPABASE_URL: 'https://prod.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_abc' };

function jwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.signature`;
}

describe('parseEnvFile', () => {
  it('parses keys, strips quotes, ignores comments and blanks', () => {
    expect(parseEnvFile('# c\n\nA=1\nB="two words"\nC=\'x\'\r\nBAD\n=nokey')).toEqual({ A: '1', B: 'two words', C: 'x' });
  });
});

describe('resolveRuntimeConfig', () => {
  it('development without Supabase values falls back to js/config.js defaults', () => {
    expect(resolveRuntimeConfig({}, { mode: 'development', appId: APP_ID })).toEqual({
      APP_ENV: 'development',
      REDIRECT_URL: `${APP_ID}://auth-callback`,
    });
  });

  it('production requires an explicit backend', () => {
    expect(() => resolveRuntimeConfig({}, { mode: 'production', appId: APP_ID })).toThrow(/required for production/);
    expect(() => resolveRuntimeConfig({}, { mode: 'staging', appId: APP_ID })).toThrow(/required for staging/);
  });

  it('production accepts only https backends', () => {
    expect(() => resolveRuntimeConfig({ ...PROD_ENV, SUPABASE_URL: 'http://prod.supabase.co' }, { mode: 'production', appId: APP_ID })).toThrow(/https/);
    expect(resolveRuntimeConfig(PROD_ENV, { mode: 'production', appId: APP_ID })).toMatchObject({
      APP_ENV: 'production', SUPABASE_URL: 'https://prod.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_abc',
    });
  });

  it('allows a local http Supabase only in development', () => {
    const local = { SUPABASE_URL: 'http://10.0.2.2:54321', SUPABASE_ANON_KEY: 'sb_publishable_local' };
    expect(resolveRuntimeConfig(local, { mode: 'development', appId: APP_ID }).SUPABASE_URL).toBe('http://10.0.2.2:54321');
  });

  it('requires both Supabase values or neither', () => {
    expect(() => resolveRuntimeConfig({ SUPABASE_URL: 'https://x.supabase.co' }, { mode: 'development', appId: APP_ID })).toThrow(/both/);
  });

  it('validates PUBLIC_URL as https', () => {
    expect(() => resolveRuntimeConfig({ ...PROD_ENV, PUBLIC_URL: 'http://example.com' }, { mode: 'production', appId: APP_ID })).toThrow(/PUBLIC_URL/);
    expect(resolveRuntimeConfig({ ...PROD_ENV, PUBLIC_URL: 'https://example.com/app/' }, { mode: 'production', appId: APP_ID }).PUBLIC_URL).toBe('https://example.com/app/');
  });

  it('rejects unknown modes', () => {
    expect(() => resolveRuntimeConfig({}, { mode: 'prod', appId: APP_ID })).toThrow(/Unknown mode/);
  });
});

describe('assertPublishableKey', () => {
  it('rejects secret and service_role keys', () => {
    expect(() => assertPublishableKey('sb_secret_123')).toThrow();
    expect(() => assertPublishableKey(jwt({ role: 'service_role' }))).toThrow();
  });
  it('accepts publishable and anon keys', () => {
    expect(() => assertPublishableKey('sb_publishable_123')).not.toThrow();
    expect(() => assertPublishableKey(jwt({ role: 'anon' }))).not.toThrow();
  });
});
