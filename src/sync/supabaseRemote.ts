import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { TABLE_BY_NAME } from '../db/tables';
import type { Remote, Row } from './engine';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** ログインのリンクから戻ってきたときの印(Supabase が URL から消す前に読んでおく) */
export const authCodeInUrl = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('code');

// PKCE: メールのリンクや Google から戻ったとき、ログインを始めたこのブラウザでしか完了できない。
// メールのリンクを安全確認のソフトなどが先に開いても、そちらにログインの状態が渡らないようにするため
export const supabase: SupabaseClient | null = url && anonKey
  ? createClient(url, anonKey, { auth: { flowType: 'pkce' } })
  : null;

export class SupabaseRemote implements Remote {
  constructor(private client: SupabaseClient) {}

  async push(table: string, rows: Row[]): Promise<void> {
    if (table === 'circles') {
      // サークルは作成と同時にサークル主を登録する必要があるため、専用の関数で作る
      // 作ったあとの名前の変更は update で送る(サークルの insert は create_circle だけに許しているので、upsert は権限で断られる)
      for (const r of rows) {
        const { error } = await this.client.rpc('create_circle', { p_id: r.id, p_name: r.name });
        if (error) throw error;
        const { error: e2 } = await this.client.from('circles')
          .update({ name: r.name, client_updated_at: r.client_updated_at })
          .eq('id', r.id as string);
        if (e2) throw e2;
      }
      return;
    }
    const spec = TABLE_BY_NAME[table];
    const { error } = await this.client
      .from(table)
      // 古い版の端末が送る行に新しい列がなくても、列の既定値で入るようにする
      .upsert(rows, { onConflict: spec.pk.join(','), ignoreDuplicates: spec.ledger, defaultToNull: false });
    if (error) throw error;
  }

  async pull(table: string, since: number, limit: number): Promise<Row[]> {
    const { data, error } = await this.client
      .from(table)
      .select('*')
      .gt('server_seq', since)
      .order('server_seq', { ascending: true })
      .limit(limit);
    if (error) throw error;
    return (data ?? []) as Row[];
  }
}
