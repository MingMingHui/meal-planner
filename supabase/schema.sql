-- ============================================================================
-- Health Meal Planning Agent — Supabase schema
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL editor (Project → SQL Editor → New query)
-- after enabling Google/Microsoft auth providers, then run policies.sql.
--
-- Design notes:
--   * Every table carries a user_id referencing auth.users(id) — this is how
--     Row Level Security scopes every row to its owner (see policies.sql).
--   * Most app state (profile, active meal plan, active shopping list,
--     settings) maps 1:1 with the user, so those tables use user_id as the
--     primary key and store their payload as jsonb — this mirrors the
--     browser's localStorage shape exactly, which keeps the sync engine
--     (js/syncManager.js) simple: it's the same JSON on both sides.
--   * Progress data benefits from true row-level granularity (one row per
--     logged day, per metric) so entries can be merged instead of blindly
--     overwritten when syncing two devices — see progress_entries below.
--   * created_at / updated_at on every table back the "latest updated_at
--     wins" conflict resolution rule used by syncManager.js.
-- ============================================================================

-- Requires pgcrypto for gen_random_uuid() — already enabled by default on
-- Supabase projects, but included here for completeness.
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- profiles: one row per user — mirrors storage.js's DEFAULT_PROFILE shape.
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.profiles is 'Health/lifestyle profile for one user (weight, height, goals, allergies, etc), stored as jsonb matching the local profile shape.';

-- ----------------------------------------------------------------------------
-- meal_plans: the user's current generated daily meal plan.
-- ----------------------------------------------------------------------------
create table if not exists public.meal_plans (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb, -- { meals:[...], generatedAt, source }
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.meal_plans is 'The user''s current active meal plan, including per-meal nutrition, stored as jsonb.';

-- ----------------------------------------------------------------------------
-- recipes: append-only log of AI-generated / saved recipes per user.
-- ----------------------------------------------------------------------------
create table if not exists public.recipes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb, -- generated recipe object
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.recipes is 'History of AI-generated or saved recipes for a user.';
create index if not exists recipes_user_id_idx on public.recipes(user_id);
create index if not exists recipes_created_at_idx on public.recipes(created_at desc);

-- ----------------------------------------------------------------------------
-- shopping_lists: the user's current shopping list.
-- ----------------------------------------------------------------------------
create table if not exists public.shopping_lists (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb, -- { items: [...] }
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.shopping_lists is 'The user''s current shopping list (grouped items), stored as jsonb.';

-- ----------------------------------------------------------------------------
-- shopping_list_items: normalized view of individual items (optional, used
-- for potential future multi-list support / analytics). The app currently
-- reads/writes the jsonb payload in shopping_lists for simplicity, but this
-- table is provided so per-item history/analytics can be added later without
-- a schema change.
-- ----------------------------------------------------------------------------
create table if not exists public.shopping_list_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  category    text not null default 'Miscellaneous',
  qty         numeric not null default 1,
  unit        text default '',
  checked     boolean not null default false,
  from_recipe text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.shopping_list_items is 'Optional per-item rows mirroring shopping_lists.data.items, for future analytics.';
create index if not exists shopping_list_items_user_id_idx on public.shopping_list_items(user_id);

-- ----------------------------------------------------------------------------
-- progress_entries: one row per (user, metric type, date) — true row-level
-- granularity so syncing two devices merges entries instead of overwriting.
-- ----------------------------------------------------------------------------
create table if not exists public.progress_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  entry_type  text not null check (entry_type in ('weight', 'calories', 'water')),
  entry_date  date not null,
  value       numeric not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, entry_type, entry_date)
);
comment on table public.progress_entries is 'One row per logged metric per day (weight in kg, calories in kcal, water in cups). Unique per user/type/date so re-syncing upserts rather than duplicates.';
create index if not exists progress_entries_user_id_idx on public.progress_entries(user_id);
create index if not exists progress_entries_date_idx on public.progress_entries(entry_date desc);

-- ----------------------------------------------------------------------------
-- achievements: unlocked milestone badges.
-- ----------------------------------------------------------------------------
create table if not exists public.achievements (
  user_id       uuid not null references auth.users(id) on delete cascade,
  achievement_id text not null,
  label         text not null,
  unlocked_at   timestamptz not null default now(),
  primary key (user_id, achievement_id)
);
comment on table public.achievements is 'Unlocked achievement badges per user.';

-- ----------------------------------------------------------------------------
-- user_settings: theme/units/language/AI provider *choice* only.
-- Deliberately excludes the AI API key — see README "API Key Security":
-- provider API keys stay in localStorage only and are never synced to the
-- cloud database.
-- ----------------------------------------------------------------------------
create table if not exists public.user_settings (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb, -- { theme, units, language, aiProvider, aiModel } — no apiKey
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.user_settings is 'Non-sensitive user preferences. API keys are intentionally never stored here.';

-- ----------------------------------------------------------------------------
-- Keep updated_at current automatically on every UPDATE.
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists trg_meal_plans_updated_at on public.meal_plans;
create trigger trg_meal_plans_updated_at before update on public.meal_plans
  for each row execute function public.set_updated_at();

drop trigger if exists trg_recipes_updated_at on public.recipes;
create trigger trg_recipes_updated_at before update on public.recipes
  for each row execute function public.set_updated_at();

drop trigger if exists trg_shopping_lists_updated_at on public.shopping_lists;
create trigger trg_shopping_lists_updated_at before update on public.shopping_lists
  for each row execute function public.set_updated_at();

drop trigger if exists trg_shopping_list_items_updated_at on public.shopping_list_items;
create trigger trg_shopping_list_items_updated_at before update on public.shopping_list_items
  for each row execute function public.set_updated_at();

drop trigger if exists trg_progress_entries_updated_at on public.progress_entries;
create trigger trg_progress_entries_updated_at before update on public.progress_entries
  for each row execute function public.set_updated_at();

drop trigger if exists trg_user_settings_updated_at on public.user_settings;
create trigger trg_user_settings_updated_at before update on public.user_settings
  for each row execute function public.set_updated_at();
