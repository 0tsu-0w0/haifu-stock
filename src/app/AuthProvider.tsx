import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getRole, type AuthBackend, type Role } from '../auth/account';
import { server, type AuthSession } from '../server';
import { db } from './db';

interface AuthApi {
  /** 同期先のサーバーが設定されているか */
  configured: boolean;
  backend: AuthBackend | null;
  /** 読み込み中は undefined、未ログインは null */
  session: AuthSession | null | undefined;
  role: Role;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null | undefined>(server ? undefined : null);
  const role = useLiveQuery(() => getRole(db), [], 'owner' as Role);

  useEffect(() => {
    if (!server) return;
    let stop = false;
    // ライブラリを読み込めなかったら、ログインしていないものとして端末の中だけで動く
    void server.getSession().then((s) => !stop && setSession(s), () => !stop && setSession(null));
    const unsubscribe = server.onSessionChange((s) => setSession(s));
    return () => {
      stop = true;
      unsubscribe();
    };
  }, []);

  const value = useMemo<AuthApi>(() => ({
    configured: !!server,
    backend: server?.auth ?? null,
    session,
    role,
    // ログアウトしても端末のデータは消さない(会場ではオフラインでも記録を続けられるように)
    signOut: async () => {
      await server?.signOut();
    },
  }), [session, role]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider の外では使えません');
  return v;
}
