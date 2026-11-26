// ai-proxy — Supabase Edge Function entry point (Deno).
// -----------------------------------------------------------------------------
// Wires handler.js to real dependencies. All request logic lives in
// handler.js so it can be tested under Node; keep this file to wiring only.
//
// Required function secrets (supabase secrets set …, never committed):
//   AI_CREDENTIALS_ENCRYPTION_KEY  base64 of 32 random bytes (openssl rand -base64 32)
// Optional:
//   AI_PROXY_ALLOWED_ORIGINS       comma-separated origins, default "*"
//                                  (safe: auth is a bearer token, not cookies)
// Provided automatically by Supabase:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//
// The service-role key is used ONLY here, server-side, to read the encrypted
// credential column that the `authenticated` role cannot select, and to insert
// server-recorded usage rows. Every query is scoped to the user id taken from
// the verified JWT — never from the request body.
// Deploy: supabase functions deploy ai-proxy   (see docs/ai-providers.md)
// -----------------------------------------------------------------------------

import { createClient } from 'npm:@supabase/supabase-js@2.119.2';
import { createAIProxyHandler } from './handler.js';
import { importEncryptionKey } from './credentials.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const keyPromise = importEncryptionKey(Deno.env.get('AI_CREDENTIALS_ENCRYPTION_KEY') ?? '');

function check<T>({ data, error }: { data: T; error: { message: string } | null }): T {
  if (error) throw new Error(error.message);
  return data;
}

const db = {
  async getConnection(userId: string, provider: string) {
    return check(await admin.from('ai_provider_connections').select('*')
      .eq('user_id', userId).eq('provider', provider).maybeSingle());
  },
  async upsertConnection(row: Record<string, unknown>) {
    return check(await admin.from('ai_provider_connections')
      .upsert(row, { onConflict: 'user_id,provider' }).select().single());
  },
  async updateConnectionStatus(userId: string, provider: string, patch: Record<string, unknown>) {
    check(await admin.from('ai_provider_connections').update(patch).eq('user_id', userId).eq('provider', provider));
  },
  async deleteConnection(userId: string, provider: string) {
    const rows = check(await admin.from('ai_provider_connections').delete()
      .eq('user_id', userId).eq('provider', provider).select('provider'));
    return Array.isArray(rows) ? rows.length : 0;
  },
  async insertUsage(row: Record<string, unknown>) {
    check(await admin.from('ai_usage_records').insert(row));
  },
};

async function authenticate(req: Request) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data?.user) return null;
  return { id: data.user.id, isAnonymous: !!data.user.is_anonymous };
}

const allowedOrigins = (Deno.env.get('AI_PROXY_ALLOWED_ORIGINS') || '*')
  .split(',').map((s) => s.trim()).filter(Boolean);

const handler = createAIProxyHandler({
  authenticate,
  db,
  getEncryptionKey: () => keyPromise,
  allowedOrigins,
  // Only event names and non-secret fields reach the logs (handler.js redacts).
  log: (event: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ fn: 'ai-proxy', event, ...data })),
});

Deno.serve(handler);
