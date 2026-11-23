// @vitest-environment jsdom
/** cloudStorage.deleteAccount() — the Google Play account-deletion path. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
let currentUser = { id: 'user-1' };

vi.mock('../../js/auth.js', () => ({
  getSupabaseClient: () => ({ rpc }),
  getCurrentUser: () => currentUser,
  isCloudConfigured: () => true,
}));

const { deleteAccount } = await import('../../js/cloudStorage.js');

beforeEach(() => { rpc.mockReset(); currentUser = { id: 'user-1' }; });

describe('deleteAccount', () => {
  it('calls the delete_my_account RPC (which only ever deletes auth.uid())', async () => {
    rpc.mockResolvedValue({ error: null });
    await expect(deleteAccount()).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('delete_my_account');
  });

  it('explains when supabase/delete_account.sql has not been run', async () => {
    rpc.mockResolvedValue({ error: { code: 'PGRST202', message: 'Could not find the function public.delete_my_account' } });
    await expect(deleteAccount()).rejects.toThrow(/Run supabase\/delete_account\.sql/);
  });

  it('reports other server errors', async () => {
    rpc.mockResolvedValue({ error: { code: '28000', message: 'Not authenticated' } });
    await expect(deleteAccount()).rejects.toThrow('Account deletion failed: Not authenticated');
  });

  it('refuses when nobody is signed in', async () => {
    currentUser = null;
    await expect(deleteAccount()).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('supabase/delete_account.sql', () => {
  it('is restricted to the caller and to authenticated users', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const sql = fs.readFileSync(path.resolve(__dirname, '../../supabase/delete_account.sql'), 'utf8');
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    expect(sql).toMatch(/delete from auth\.users where id = uid;/);
    expect(sql).toMatch(/uid uuid := auth\.uid\(\)/);
    expect(sql).toMatch(/revoke all on function public\.delete_my_account\(\) from anon;/);
    expect(sql).toMatch(/grant execute on function public\.delete_my_account\(\) to authenticated;/);
    expect(sql).not.toMatch(/delete_my_account\([^)]+\)/); // takes no arguments
  });

  it('every user table cascades from auth.users so deletion removes all data', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const schema = fs.readFileSync(path.resolve(__dirname, '../../supabase/schema.sql'), 'utf8');
    const tables = [...schema.matchAll(/create table if not exists public\.(\w+)/g)].map(m => m[1]);
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      const body = schema.slice(schema.indexOf(`public.${table} (`));
      const block = body.slice(0, body.indexOf(');'));
      expect(block, table).toMatch(/references auth\.users\(id\) on delete cascade/);
    }
  });
});
