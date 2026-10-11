import type { Session } from '@supabase/supabase-js';
import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getRole, type AuthBackend, type Role } from '../auth/account';
import { SupabaseAuthBackend } from '../auth/supabaseBackend';
import { getSupabase, supabaseConfig } from '../sync/supabaseClient';
import { db } from './db';

interface AuthApi {
  /** 同期先(Supabase)が設定されているか */
  configured: boolean;
  backend: AuthBackend | null;
  /** 読み込み中は undefined、未ログインは null */
  session: Session | null | undefined;
  role: Role;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthApi | null>(null);
const backend = supabaseConfig
  ? new SupabaseAuthBackend(() => getSupabase()!, supabaseConfig.url, supabaseConfig.anonKey)
  : null;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(supabaseConfig ? undefined : null);
  const role = useLiveQuery(() => getRole(db), [], 'owner' as Role);

  useEffect(() => {
    const client = getSupabase();
    if (!client) return;
    let stop = false;
    let unsubscribe = () => {};
    void client.then((c) => {
      if (stop) return;
      void c.auth.getSession().then(({ data }) => setSession(data.session));
      const { data } = c.auth.onAuthStateChange((_event, s) => setSession(s));
      unsubscribe = () => data.subscription.unsubscribe();
    }, () => setSession(null)); // ライブラリを読み込めなかったら、ログインしていないものとして端末の中だけで動く
    return () => {
      stop = true;
      unsubscribe();
    };
  }, []);

  const value = useMemo<AuthApi>(() => ({
    configured: !!supabaseConfig,
    backend,
    session,
    role,
    // ログアウトしても端末のデータは消さない(会場ではオフラインでも記録を続けられるように)
    signOut: async () => {
      await (await getSupabase())?.auth.signOut();
    },
  }), [session, role]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider の外では使えません');
  return v;
}
