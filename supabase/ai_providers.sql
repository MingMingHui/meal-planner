-- ============================================================================
-- ai_providers.sql — AI provider connections + token usage (migration)
-- ----------------------------------------------------------------------------
-- Run order: after schema.sql and policies.sql (and delete_account.sql), in
-- the Supabase SQL Editor. Safe to re-run.
--
-- ai_provider_connections
--   One row per (user, provider) for credentials the user chose to save to
--   their account. The credential is AES-256-GCM encrypted by the ai-proxy
--   Edge Function (key: AI_CREDENTIALS_ENCRYPTION_KEY function secret) — the
--   database never sees it in plain text. The `authenticated` role can read
--   ONLY the non-secret columns of its own rows (column-level GRANT + RLS)
--   and cannot write at all; all writes go through ai-proxy, which scopes
--   every query to the user id from the verified JWT.
--
-- ai_usage_records
--   Token usage telemetry. No prompts, no responses — counts and metadata
--   only. Rows written by ai-proxy are recorded_by = 'server'; rows the app
--   writes for "this device only" keys are recorded_by = 'client', and RLS
--   makes it impossible for a client to insert a 'server' row or a row for
--   another user. total_tokens is a generated column, so it is always exactly
--   input_tokens + output_tokens.
--
-- Both tables reference auth.users ON DELETE CASCADE, so Delete Account
-- (delete_account.sql) removes them with everything else.
-- ============================================================================

create table if not exists public.ai_provider_connections (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  provider              text not null check (provider ~ '^[a-z0-9_-]{2,32}$'),
  auth_method           text not null check (auth_method in ('api_key', 'oauth_pkce')),
  model                 text not null check (char_length(model) between 1 and 200),
  credential_ciphertext text not null,                 -- "v1:<iv>:<ciphertext>", see supabase/functions/ai-proxy/credentials.js
  key_hint              text not null default '••••',  -- last 4 characters only, for display
  status                text not null default 'active' check (status in ('active', 'invalid', 'expired')),
  last_error_code       text,
  last_verified_at      timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (user_id, provider)
);
comment on table public.ai_provider_connections is 'AI provider credentials saved to an account, encrypted by the ai-proxy Edge Function. Clients may read only non-secret columns of their own rows.';

drop trigger if exists trg_ai_provider_connections_updated_at on public.ai_provider_connections;
create trigger trg_ai_provider_connections_updated_at before update on public.ai_provider_connections
  for each row execute function public.set_updated_at();

alter table public.ai_provider_connections enable row level security;

-- Column-level privileges: clients can never select the ciphertext and can
-- never insert or update (the service role used by ai-proxy bypasses these
-- grants and RLS). Deleting their own row — i.e. revoking the connection —
-- is allowed directly, so Disconnect and Delete Cloud Data work even if the
-- Edge Function is unavailable.
revoke all on table public.ai_provider_connections from anon, authenticated;
grant select (id, user_id, provider, auth_method, model, key_hint, status, last_error_code, last_verified_at, created_at, updated_at)
  on table public.ai_provider_connections to authenticated;
grant delete on table public.ai_provider_connections to authenticated;

drop policy if exists "ai_provider_connections_select_own" on public.ai_provider_connections;
create policy "ai_provider_connections_select_own" on public.ai_provider_connections
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "ai_provider_connections_delete_own" on public.ai_provider_connections;
create policy "ai_provider_connections_delete_own" on public.ai_provider_connections
  for delete to authenticated using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------

create table if not exists public.ai_usage_records (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  provider            text not null check (provider ~ '^[a-z0-9_-]{2,32}$'),
  model               text not null check (char_length(model) between 1 and 200),
  feature             text not null default 'other' check (feature in ('coach', 'recipe', 'meal_plan', 'other')),
  status              text not null check (status in ('success', 'error')),
  error_code          text check (error_code is null or char_length(error_code) <= 64),
  input_tokens        integer not null default 0 check (input_tokens >= 0),
  output_tokens       integer not null default 0 check (output_tokens >= 0),
  total_tokens        integer generated always as (input_tokens + output_tokens) stored,
  token_source        text not null check (token_source in ('provider', 'estimated')),
  estimated_cost_usd  numeric(14, 6) check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  cost_source         text not null check (cost_source in ('provider', 'estimated', 'unavailable')),
  recorded_by         text not null check (recorded_by in ('server', 'client')),
  latency_ms          integer check (latency_ms is null or latency_ms >= 0),
  created_at          timestamptz not null default now()
);
comment on table public.ai_usage_records is 'Per-request AI token usage. Never contains prompts or responses. recorded_by=server rows come from ai-proxy; recorded_by=client rows from the app for device-stored keys.';
create index if not exists ai_usage_records_user_created_idx on public.ai_usage_records(user_id, created_at desc);

alter table public.ai_usage_records enable row level security;

revoke all on table public.ai_usage_records from anon, authenticated;
grant select, insert, delete on table public.ai_usage_records to authenticated;

drop policy if exists "ai_usage_records_select_own" on public.ai_usage_records;
create policy "ai_usage_records_select_own" on public.ai_usage_records
  for select to authenticated using (auth.uid() = user_id);

-- Clients may only add their OWN client-recorded rows, never 'server' rows.
drop policy if exists "ai_usage_records_insert_own_client" on public.ai_usage_records;
create policy "ai_usage_records_insert_own_client" on public.ai_usage_records
  for insert to authenticated with check (auth.uid() = user_id and recorded_by = 'client');

-- Lets "Delete Cloud Data" remove the user's usage history. No UPDATE policy:
-- usage rows are append-only.
drop policy if exists "ai_usage_records_delete_own" on public.ai_usage_records;
create policy "ai_usage_records_delete_own" on public.ai_usage_records
  for delete to authenticated using (auth.uid() = user_id);

-- ============================================================================
-- Verify (optional):
--   select tablename, rowsecurity from pg_tables where tablename like 'ai_%';
--   -- as an authenticated user, this must fail with "permission denied":
--   select credential_ciphertext from public.ai_provider_connections;
-- ============================================================================
