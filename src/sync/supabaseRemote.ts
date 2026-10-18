import type { SupabaseClient } from '@supabase/supabase-js';
import { TABLE_BY_NAME } from '../db/tables';
import type { Remote, Row } from './engine';

/** Supabase の無料プランでプロジェクトが一時停止しているとき、サーバーは HTTP 540 を返す(Issue #18) */
export const PAUSED_STATUS = 540;
export const PAUSED_MESSAGE = '同期先(Supabase)が一時停止しています。サークル主が Supabase の管理画面で「Resume project」を押すと再開します。記録はこの端末に残っていて、再開すれば送られます';

/** 応答がエラーなら投げる。一時停止は、理由が分かる言葉にする */
function check(res: { error: unknown; status: number }): void {
  if (res.status === PAUSED_STATUS) throw new Error(PAUSED_MESSAGE);
  if (res.error) throw res.error;
}

export class SupabaseRemote implements Remote {
  constructor(private client: SupabaseClient) {}

  async push(table: string, rows: Row[]): Promise<void> {
    if (table === 'circles') {
      // サークルは作成と同時にサークル主を登録する必要があるため、専用の関数で作る
      // 作ったあとの名前の変更は update で送る(サークルの insert は create_circle だけに許しているので、upsert は権限で断られる)
      for (const r of rows) {
        check(await this.client.rpc('create_circle', { p_id: r.id, p_name: r.name }));
        check(await this.client.from('circles')
          .update({ name: r.name, client_updated_at: r.client_updated_at })
          .eq('id', r.id as string));
      }
      return;
    }
    const spec = TABLE_BY_NAME[table];
    check(await this.client
      .from(table)
      // 古い版の端末が送る行に新しい列がなくても、列の既定値で入るようにする
      .upsert(rows, { onConflict: spec.pk.join(','), ignoreDuplicates: spec.ledger, defaultToNull: false }));
  }

  async heads(): Promise<Record<string, number> | null> {
    const { data, error, status } = await this.client.rpc('sync_heads');
    if (status === PAUSED_STATUS) throw new Error(PAUSED_MESSAGE);
    // サーバーにまだ関数がないとき(古いサーバー)は、全部の表を見に行く
    if (error) return null;
    return data as Record<string, number>;
  }

  async pull(table: string, since: number, limit: number): Promise<Row[]> {
    const res = await this.client
      .from(table)
      .select('*')
      .gt('server_seq', since)
      .order('server_seq', { ascending: true })
      .limit(limit);
    check(res);
    return (res.data ?? []) as Row[];
  }
}
