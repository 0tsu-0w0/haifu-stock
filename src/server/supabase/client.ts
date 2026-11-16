import type { SupabaseClient } from '@supabase/supabase-js';

// Supabase のクライアント。ライブラリ(大きい)は最初の画面を出したあとに読み込む(軽量化)。
// 設定がなければ null を返し、アプリは端末の中だけで動く

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** 同期先が設定されているか(ライブラリを読み込まずに分かる) */
export const supabaseConfig = url && anonKey ? { url, anonKey } : null;

/** ログインのリンクから戻ってきたときの印(Supabase が URL から消す前に、起動時に読んでおく) */
export const authCodeInUrl = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('code');

let client: Promise<SupabaseClient> | null = null;

/**
 * クライアントを返す(初めて呼んだときにライブラリを読み込む)。設定がなければ null。
 * PKCE: メールのリンクや Google から戻ったとき、ログインを始めたこのブラウザでしか完了できない。
 * メールのリンクを安全確認のソフトなどが先に開いても、そちらにログインの状態が渡らないようにするため
 */
export function getSupabase(): Promise<SupabaseClient> | null {
  if (!supabaseConfig) return null;
  client ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(supabaseConfig.url, supabaseConfig.anonKey, { auth: { flowType: 'pkce' } }));
  return client;
}
