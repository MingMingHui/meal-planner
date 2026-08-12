-- ============================================================================
-- Health Meal Planning Agent — Row Level Security policies
-- ----------------------------------------------------------------------------
-- Run this AFTER schema.sql. This is what actually enforces "users can only
-- ever read/write their own data" — enforced by PostgreSQL itself, not by
-- application code. The frontend only ever uses the public anon key; RLS is
-- what makes that safe.
-- ============================================================================

alter table public.profiles             enable row level security;
alter table public.meal_plans           enable row level security;
alter table public.recipes              enable row level security;
alter table public.shopping_lists       enable row level security;
alter table public.shopping_list_items  enable row level security;
alter table public.progress_entries     enable row level security;
alter table public.achievements         enable row level security;
alter table public.user_settings        enable row level security;

-- ----------------------------------------------------------------------------
-- profiles
-- ----------------------------------------------------------------------------
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = user_id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = user_id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "profiles_delete_own" on public.profiles;
create policy "profiles_delete_own" on public.profiles
  for delete using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- meal_plans
-- ----------------------------------------------------------------------------
drop policy if exists "meal_plans_select_own" on public.meal_plans;
create policy "meal_plans_select_own" on public.meal_plans
  for select using (auth.uid() = user_id);

drop policy if exists "meal_plans_insert_own" on public.meal_plans;
create policy "meal_plans_insert_own" on public.meal_plans
  for insert with check (auth.uid() = user_id);

drop policy if exists "meal_plans_update_own" on public.meal_plans;
create policy "meal_plans_update_own" on public.meal_plans
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "meal_plans_delete_own" on public.meal_plans;
create policy "meal_plans_delete_own" on public.meal_plans
  for delete using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- recipes
-- ----------------------------------------------------------------------------
drop policy if exists "recipes_select_own" on public.recipes;
create policy "recipes_select_own" on public.recipes
  for select using (auth.uid() = user_id);

drop policy if exists "recipes_insert_own" on public.recipes;
create policy "recipes_insert_own" on public.recipes
  for insert with check (auth.uid() = user_id);

drop policy if exists "recipes_update_own" on public.recipes;
create policy "recipes_update_own" on public.recipes
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "recipes_delete_own" on public.recipes;
create policy "recipes_delete_own" on public.recipes
  for delete using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- shopping_lists
-- ----------------------------------------------------------------------------
drop policy if exists "shopping_lists_select_own" on public.shopping_lists;
create policy "shopping_lists_select_own" on public.shopping_lists
  for select using (auth.uid() = user_id);

drop policy if exists "shopping_lists_insert_own" on public.shopping_lists;
create policy "shopping_lists_insert_own" on public.shopping_lists
  for insert with check (auth.uid() = user_id);

drop policy if exists "shopping_lists_update_own" on public.shopping_lists;
create policy "shopping_lists_update_own" on public.shopping_lists
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "shopping_lists_delete_own" on public.shopping_lists;
create policy "shopping_lists_delete_own" on public.shopping_lists
  for delete using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- shopping_list_items
-- ----------------------------------------------------------------------------
drop policy if exists "shopping_list_items_select_own" on public.shopping_list_items;
create policy "shopping_list_items_select_own" on public.shopping_list_items
  for select using (auth.uid() = user_id);

drop policy if exists "shopping_list_items_insert_own" on public.shopping_list_items;
create policy "shopping_list_items_insert_own" on public.shopping_list_items
  for insert with check (auth.uid() = user_id);

drop policy if exists "shopping_list_items_update_own" on public.shopping_list_items;
create policy "shopping_list_items_update_own" on public.shopping_list_items
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "shopping_list_items_delete_own" on public.shopping_list_items;
create policy "shopping_list_items_delete_own" on public.shopping_list_items
  for delete using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- progress_entries
-- ----------------------------------------------------------------------------
drop policy if exists "progress_entries_select_own" on public.progress_entries;
create policy "progress_entries_select_own" on public.progress_entries
  for select using (auth.uid() = user_id);

drop policy if exists "progress_entries_insert_own" on public.progress_entries;
create policy "progress_entries_insert_own" on public.progress_entries
  for insert with check (auth.uid() = user_id);

drop policy if exists "progress_entries_update_own" on public.progress_entries;
create policy "progress_entries_update_own" on public.progress_entries
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "progress_entries_delete_own" on public.progress_entries;
create policy "progress_entries_delete_own" on public.progress_entries
  for delete using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- achievements
-- ----------------------------------------------------------------------------
drop policy if exists "achievements_select_own" on public.achievements;
create policy "achievements_select_own" on public.achievements
  for select using (auth.uid() = user_id);

drop policy if exists "achievements_insert_own" on public.achievements;
create policy "achievements_insert_own" on public.achievements
  for insert with check (auth.uid() = user_id);

drop policy if exists "achievements_delete_own" on public.achievements;
create policy "achievements_delete_own" on public.achievements
  for delete using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- user_settings
-- ----------------------------------------------------------------------------
drop policy if exists "user_settings_select_own" on public.user_settings;
create policy "user_settings_select_own" on public.user_settings
  for select using (auth.uid() = user_id);

drop policy if exists "user_settings_insert_own" on public.user_settings;
create policy "user_settings_insert_own" on public.user_settings
  for insert with check (auth.uid() = user_id);

drop policy if exists "user_settings_update_own" on public.user_settings;
create policy "user_settings_update_own" on public.user_settings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "user_settings_delete_own" on public.user_settings;
create policy "user_settings_delete_own" on public.user_settings
  for delete using (auth.uid() = user_id);

-- ============================================================================
-- Verify (run manually, optional):
--   select tablename, rowsecurity from pg_tables where schemaname = 'public';
-- Every app table above should show rowsecurity = true.
-- ============================================================================
