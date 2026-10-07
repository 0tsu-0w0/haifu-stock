import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getMeta } from '../db/local';
import { syncOnce } from '../sync/engine';
import { SupabaseRemote, supabase } from '../sync/supabaseRemote';
import { useAuth } from './AuthProvider';
import { db } from './db';

type SyncState =
  | { kind: 'local' }          // 同期先が設定されていない。端末の中だけで動く
  | { kind: 'signed-out' }     // 同期先はあるが、ログインしていない
  | { kind: 'idle'; lastSyncedAt: string | null }
  | { kind: 'syncing' }
  | { kind: 'offline' }
  | { kind: 'error'; message: string };

interface SyncApi {
  state: SyncState;
  pending: number;
  syncNow: () => Promise<string>;
}

const Ctx = createContext<SyncApi | null>(null);
const remote = supabase ? new SupabaseRemote(supabase) : null;
const INTERVAL_MS = 20_000;

export function SyncProvider({ children }: { children: ReactNode }) {
  const pending = useLiveQuery(() => db.outbox.count(), [], 0);
  const [state, setState] = useState<SyncState>(remote ? { kind: 'signed-out' } : { kind: 'local' });

  const syncNow = useCallback(async (): Promise<string> => {
    if (!remote || !supabase) return '同期先が設定されていません。記録はこの端末に保存されています';
    const { data } = await supabase.auth.getSession();
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
      setState({ kind: 'idle', lastSyncedAt: (await getMeta<string>(db, 'last_synced_at')) ?? null });
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
    if (!remote || session === undefined) return;
    void syncNow();
    const timer = setInterval(() => void syncNow(), INTERVAL_MS);
    const online = () => void syncNow();
    window.addEventListener('online', online);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', online);
    };
  }, [syncNow, uid, session === undefined]); // ユーザーが変わったときだけ張り直す

  const value = useMemo(() => ({ state, pending, syncNow }), [state, pending, syncNow]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSync(): SyncApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('SyncProvider の外では使えません');
  return v;
}
