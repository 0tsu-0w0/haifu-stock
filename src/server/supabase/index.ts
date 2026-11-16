import type { Session } from '@supabase/supabase-js';
import type { AuthSession, ServerBackend } from '../types';
import { SupabaseAuthBackend } from './auth';
import { authCodeInUrl, getSupabase, supabaseConfig } from './client';
import { SupabaseRemote } from './remote';

// Supabase を同期先にする。Supabase のライブラリを使うのは src/server/supabase の中だけ

const toSession = (s: Session | null): AuthSession | null =>
  s ? { userId: s.user.id, email: s.user.email ?? null, anonymous: !!s.user.is_anonymous } : null;

/** 設定(VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY)がなければ null */
export function createSupabaseServer(): ServerBackend | null {
  if (!supabaseConfig) return null;
  const client = () => getSupabase()!;
  let remote: SupabaseRemote | null = null;
  return {
    name: 'Supabase',
    auth: new SupabaseAuthBackend(client, supabaseConfig.url, supabaseConfig.anonKey),
    returnedFromLogin: authCodeInUrl,
    async remote() {
      remote ??= new SupabaseRemote(await client());
      return remote;
    },
    async getSession() {
      const { data } = await (await client()).auth.getSession();
      return toSession(data.session);
    },
    onSessionChange(cb) {
      let stop = false;
      let unsubscribe = () => {};
      void client().then((c) => {
        if (stop) return;
        const { data } = c.auth.onAuthStateChange((_event, s) => cb(toSession(s)));
        unsubscribe = () => data.subscription.unsubscribe();
      }, () => {});
      return () => {
        stop = true;
        unsubscribe();
      };
    },
    async signOut() {
      await (await client()).auth.signOut();
    },
  };
}
