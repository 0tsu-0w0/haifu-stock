import { TABLE_BY_NAME } from '../db/tables';
import type { Remote, Row } from './engine';

/**
 * メモリ上の偽のサーバー。db/schema.sql と同じ規則で振る舞う:
 * 台帳は同じ主キーなら無視、マスタは client_updated_at の後勝ち、書き込むたびに server_seq を振る
 */
export class MemoryRemote implements Remote {
  private seq = 0;
  readonly tables = new Map<string, Map<string, Row>>();
  /** true にすると通信できない状態をまねる */
  offline = false;

  private table(name: string) {
    let t = this.tables.get(name);
    if (!t) this.tables.set(name, (t = new Map()));
    return t;
  }

  async push(table: string, rows: Row[]): Promise<void> {
    if (this.offline) throw new Error('offline');
    const spec = TABLE_BY_NAME[table];
    const t = this.table(table);
    for (const r of rows) {
      const key = JSON.stringify(spec.pk.map((k) => r[k]));
      const old = t.get(key);
      if (old && spec.ledger) continue;
      if (old && String(r.client_updated_at ?? '') < String(old.client_updated_at ?? '')) continue;
      t.set(key, { ...old, ...r, server_seq: ++this.seq });
    }
  }

  async pull(table: string, since: number, limit: number): Promise<Row[]> {
    if (this.offline) throw new Error('offline');
    return [...this.table(table).values()]
      .filter((r) => Number(r.server_seq) > since)
      .sort((a, b) => Number(a.server_seq) - Number(b.server_seq))
      .slice(0, limit);
  }

  count(table: string): number {
    return this.table(table).size;
  }
}
