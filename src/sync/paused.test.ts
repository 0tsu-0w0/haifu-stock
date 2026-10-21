import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { createCircle } from '../domain/setup';
import { syncOnce, SyncFailedError } from './engine';
import { PAUSED_MESSAGE, SupabaseRemote } from './supabaseRemote';

/** どの問い合わせにも同じ応答を返す、Supabase の client の代わり */
function fakeClient(res: { data: unknown; error: unknown; status: number }): SupabaseClient {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'select', 'gt', 'order', 'limit', 'upsert', 'update', 'eq']) chain[m] = () => chain;
  chain.then = (ok: (v: unknown) => unknown) => Promise.resolve(res).then(ok);
  chain.rpc = () => Promise.resolve(res);
  return chain as unknown as SupabaseClient;
}

describe('Supabase が一時停止しているとき(Issue #18)', () => {
  it('HTTP 540 なら、一時停止していて再開すればよいことを伝える', async () => {
    const remote = new SupabaseRemote(fakeClient({ data: null, error: { message: 'Project paused' }, status: 540 }));
    await expect(remote.pull('items', 0, 100)).rejects.toThrow(PAUSED_MESSAGE);
    await expect(remote.push('items', [{ id: 'x' }])).rejects.toThrow(PAUSED_MESSAGE);
    await expect(remote.heads()).rejects.toThrow(PAUSED_MESSAGE);
  });

  it('同期全体が失敗したときの知らせも、一時停止の言葉になる', async () => {
    const db = freshDb('paused');
    await createCircle(db, 'テスト');
    const remote = new SupabaseRemote(fakeClient({ data: null, error: { message: 'Project paused' }, status: 540 }));
    const err = await syncOnce(db, remote).catch((e) => e);
    expect(err).toBeInstanceOf(SyncFailedError);
    expect((err as Error).message).toBe(PAUSED_MESSAGE);
    expect(await db.outbox.count()).toBeGreaterThan(0); // 記録は送れるまで端末に残る
  });

  it('サーバーで消した表は、受け取るものがないとして扱う。送るほうはエラーのまま', async () => {
    const missing = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.old' in the schema cache" }, status: 404 };
    const remote = new SupabaseRemote(fakeClient(missing));
    expect(await remote.pull('old', 0, 100)).toEqual([]);
    await expect(remote.push('items', [{ id: 'x' }])).rejects.toMatchObject({ code: 'PGRST205' });
  });

  it('ふつうのエラーは、これまでどおりそのまま投げる', async () => {
    const remote = new SupabaseRemote(fakeClient({ data: null, error: { message: 'permission denied' }, status: 403 }));
    await expect(remote.pull('items', 0, 100)).rejects.toMatchObject({ message: 'permission denied' });
    expect(await new SupabaseRemote(fakeClient({ data: null, error: { message: 'no fn' }, status: 404 })).heads()).toBeNull();
  });
});
