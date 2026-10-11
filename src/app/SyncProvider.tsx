import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getMeta } from '../db/local';
import { TABLE_BY_NAME } from '../db/tables';
import { syncOnce, type TableError } from '../sync/engine';
import { getSupabase, supabaseConfig } from '../sync/supabaseClient';
import { SupabaseRemote } from '../sync/supabaseRemote';
import { useAuth } from './AuthProvider';
import { db } from './db';

type SyncState =
  | { kind: 'local' }          // 同期先が設定されていない。端末の中だけで動く
  | { kind: 'signed-out' }     // 同期先はあるが、ログインしていない
  | { kind: 'idle'; lastSyncedAt: string | null }
  | { kind: 'syncing' }
  | { kind: 'offline' }
  | { kind: 'error'; message: string }
  // 一部の表だけ送れなかった・受け取れなかった(ほかの表は同期した)(#17)
  | { kind: 'partial'; failed: TableError[]; lastSyncedAt: string | null };

interface SyncApi {
  state: SyncState;
  pending: number;
  /** 送れなかった表に残っている送信待ちの件数 */
  stuck: number;
  syncNow: () => Promise<string>;
}

const Ctx = createContext<SyncApi | null>(null);
let remote: SupabaseRemote | null = null;
// 同期する間隔(軽量化): 変化があるあいだは20秒ごと、何も変わらなければ倍々に延ばして最長2分。
// 端末で記録したら、少し待ってすぐ送る。アプリが裏に回っている間は同期しない
const BASE_MS = 20_000;
const MAX_MS = 120_000;
const AFTER_WRITE_MS = 1_500;

export function SyncProvider({ children }: { children: ReactNode }) {
  const pending = useLiveQuery(() => db.outbox.count(), [], 0);
  const [state, setState] = useState<SyncState>(supabaseConfig ? { kind: 'signed-out' } : { kind: 'local' });
  const failedTables = state.kind === 'partial' ? state.failed.filter((f) => f.phase === 'push').map((f) => f.table) : [];
  const stuck = useLiveQuery(
    () => (failedTables.length ? db.outbox.where('table').anyOf(failedTables).count() : 0),
    [failedTables.join(',')],
    0,
  );

  // 何も変わらなかった同期が続いた回数(間隔を延ばすため)
  const quiet = useRef(0);

  const syncNow = useCallback(async (): Promise<string> => {
    const client = await getSupabase();
    if (!client) return '同期先が設定されていません。記録はこの端末に保存されています';
    remote ??= new SupabaseRemote(client);
    const { data } = await client.auth.getSession();
    if (!data.session) {
      setState({ kind: 'signed-out' });
      return 'ログインすると同期できます';
    }
    if (!navigator.onLine) {
      setState({ kind: 'offline' });
      return '通信できません。記録はこの端末に保存されています';
    }
    setState({ kind: 'syncing' });
    try {
      const r = await syncOnce(db, remote);
      quiet.current = r.pushed || r.pulled ? 0 : quiet.current + 1;
      const lastSyncedAt = (await getMeta<string>(db, 'last_synced_at')) ?? null;
      if (r.failed.length > 0) {
        setState({ kind: 'partial', failed: r.failed, lastSyncedAt });
        const names = [...new Set(r.failed.map((f) => TABLE_BY_NAME[f.table]?.label ?? f.table))].join('・');
        return `${r.pushed ? `${r.pushed}件を送信しました。` : ''}${names} は同期できませんでした(ほかは同期しました)。設定の「同期の状態」で理由を見られます`;
      }
      setState({ kind: 'idle', lastSyncedAt });
      return r.pushed ? `${r.pushed}件を送信しました` : '同期しました';
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setState({ kind: 'error', message });
      return `同期できませんでした: ${message}`;
    }
  }, []);

  // ログイン・ログアウトしたら、すぐに同期し直す
  const { session } = useAuth();
  const uid = session?.user.id;
  useEffect(() => {
    if (!supabaseConfig || session === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const loop = async () => {
      clearTimeout(timer);
      if (document.visibilityState === 'hidden') return; // 裏に回ったら止め、戻ってきたら再開する
      await syncNow();
      if (stopped) return;
      // 同期の途中で別のきっかけ(記録・復帰)が来ても、次の予定は1つだけにする
      clearTimeout(timer);
      timer = setTimeout(() => void loop(), Math.min(BASE_MS * 2 ** quiet.current, MAX_MS));
    };
    const now = () => {
      quiet.current = 0;
      void loop();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') now();
    };
    void loop();
    window.addEventListener('online', now);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener('online', now);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [syncNow, uid, session === undefined]); // ユーザーが変わったときだけ張り直す

  // 端末で記録したら(送信待ちが増えたら)、少し待ってすぐ送る。続けて記録したときは、まとめて1回
  const lastPending = useRef(pending);
  useEffect(() => {
    const grew = pending > lastPending.current;
    lastPending.current = pending;
    if (!grew || !supabaseConfig) return;
    const t = setTimeout(() => {
      quiet.current = 0;
      void syncNow();
    }, AFTER_WRITE_MS);
    return () => clearTimeout(t);
  }, [pending, syncNow]);

  const value = useMemo(() => ({ state, pending, stuck, syncNow }), [state, pending, stuck, syncNow]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSync(): SyncApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('SyncProvider の外では使えません');
  return v;
}
