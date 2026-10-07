import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { TABLE_BY_NAME } from '../db/tables';
import type { Remote, Row } from './engine';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient | null = url && anonKey ? createClient(url, anonKey) : null;

export class SupabaseRemote implements Remote {
  constructor(private client: SupabaseClient) {}

  async push(table: string, rows: Row[]): Promise<void> {
    if (table === 'circles') {
      // サークルは作成と同時にサークル主を登録する必要があるため、専用の関数で作る
      for (const r of rows) {
        const { error } = await this.client.rpc('create_circle', { p_id: r.id, p_name: r.name });
        if (error) throw error;
      }
      const { error } = await this.client.from('circles').upsert(rows, { onConflict: 'id' });
      if (error) throw error;
      return;
    }
    const spec = TABLE_BY_NAME[table];
    const { error } = await this.client
      .from(table)
      .upsert(rows, { onConflict: spec.pk.join(','), ignoreDuplicates: spec.ledger });
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
