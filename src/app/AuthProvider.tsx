import type { Session } from '@supabase/supabase-js';
import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getRole, type AuthBackend, type Role } from '../auth/account';
import { SupabaseAuthBackend } from '../auth/supabaseBackend';
import { supabase } from '../sync/supabaseRemote';
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
const backend = supabase
  ? new SupabaseAuthBackend(supabase, import.meta.env.VITE_SUPABASE_URL as string, import.meta.env.VITE_SUPABASE_ANON_KEY as string)
  : null;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(supabase ? undefined : null);
  const role = useLiveQuery(() => getRole(db), [], 'owner' as Role);

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const value = useMemo<AuthApi>(() => ({
    configured: !!supabase,
    backend,
    session,
    role,
    // ログアウトしても端末のデータは消さない(会場ではオフラインでも記録を続けられるように)
    signOut: async () => {
      await supabase?.auth.signOut();
    },
  }), [session, role]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider の外では使えません');
  return v;
}
