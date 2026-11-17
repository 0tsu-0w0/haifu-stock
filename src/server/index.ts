import { createSupabaseServer } from './supabase';
import type { ServerBackend } from './types';

export type { AuthSession, ServerBackend } from './types';

// どのサーバーに同期するかを選ぶ、ただ1つの場所(Issue #45)。
// 別のサービスを足すときは、VITE_SERVER の値で分ける(いまは supabase だけ)。
// 設定がなければ null で、アプリは端末の中だけで動く

function pick(): ServerBackend | null {
  const kind = (import.meta.env.VITE_SERVER as string | undefined) ?? 'supabase';
  switch (kind) {
    case 'supabase':
      return createSupabaseServer();
    case 'none':
      return null;
    default:
      console.warn(`VITE_SERVER=${kind} は知らない同期先です。端末の中だけで動きます`);
      return null;
  }
}

export const server: ServerBackend | null = pick();
