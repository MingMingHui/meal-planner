-- ============================================================================
-- delete_account.sql
-- ----------------------------------------------------------------------------
-- Purpose: Lets a signed-in user permanently delete their OWN account (their
--          auth.users row) from inside the app, as Google Play's account
--          deletion policy requires for apps that let users create accounts.
--
--          Every table in schema.sql references auth.users(id) ON DELETE
--          CASCADE, so deleting the auth user also deletes all of that
--          user's profiles / meal_plans / recipes / shopping_lists /
--          shopping_list_items / progress_entries / achievements /
--          user_settings rows in the same transaction.
--
-- Security: SECURITY DEFINER is required because the authenticated role
--           cannot delete from auth.users directly. The function takes NO
--           arguments and only ever deletes auth.uid() — the caller's own,
--           JWT-verified id — so one user can never delete another. EXECUTE
--           is revoked from anon/public and granted to authenticated only.
--
-- Run order: after schema.sql and policies.sql, in the Supabase SQL Editor.
--            Safe to re-run.
-- Called by: cloudStorage.js → deleteAccount() via client.rpc('delete_my_account').
-- ============================================================================

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_my_account() from public;
revoke all on function public.delete_my_account() from anon;
grant execute on function public.delete_my_account() to authenticated;
