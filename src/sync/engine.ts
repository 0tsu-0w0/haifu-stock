import { getMeta, setMeta, type HaifuDB } from '../db/local';
import { SERVER_COLUMNS, TABLES, dexieKey, keyFromOutbox } from '../db/tables';

// 同期の本体。送る: 送信待ちの行を親テーブルから順に送る。受け取る: テーブルごとに server_seq の続きから取る。
// 通信相手は Remote として差し替えられる(本番は Supabase、テストはメモリ上の偽物)

export type Row = Record<string, unknown>;

export interface Remote {
  /** 台帳は同じ主キーがあれば無視、マスタは後勝ちで書き込む */
  push(table: string, rows: Row[]): Promise<void>;
  /** server_seq が since より大きい行を、小さい順に limit 件まで返す */
  pull(table: string, since: number, limit: number): Promise<Row[]>;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
}

const PULL_LIMIT = 500;

function stripServerColumns(row: Row): Row {
  const out: Row = { ...row };
  for (const c of SERVER_COLUMNS) delete out[c];
  return out;
}

export async function pushOutbox(db: HaifuDB, remote: Remote): Promise<number> {
  const entries = await db.outbox.orderBy('seq').toArray();
  if (entries.length === 0) return 0;

  let pushed = 0;
  for (const spec of TABLES) {
    const mine = entries.filter((e) => e.table === spec.name);
    if (mine.length === 0) continue;
    // 同じ行が何度も積まれていても、送るのは最新の内容を1回だけ
    const keys = [...new Set(mine.map((e) => e.key))];
    const rows = (await Promise.all(keys.map((k) => db.table(spec.name).get(keyFromOutbox(spec.name, k) as never))))
      .filter((r): r is Row => r != null)
      .map(stripServerColumns);
    if (rows.length > 0) await remote.push(spec.name, rows);
    // 送っている間に積まれた新しい記録は消さない
    await db.outbox.bulkDelete(mine.map((e) => e.seq!));
    pushed += rows.length;
  }
  return pushed;
}

export async function pullChanges(db: HaifuDB, remote: Remote): Promise<number> {
  let pulled = 0;
  for (const spec of TABLES) {
    let since = (await getMeta<number>(db, `cursor:${spec.name}`)) ?? 0;
    for (;;) {
      const rows = await remote.pull(spec.name, since, PULL_LIMIT);
      if (rows.length === 0) break;
      // 端末でまだ送っていない変更がある行は、端末側を残す(次の送信で後勝ちに任せる)
      const pending = new Set(
        (await db.outbox.where('table').equals(spec.name).toArray()).map((e) => JSON.stringify(keyFromOutbox(spec.name, e.key))),
      );
      const fresh = rows.filter((r) => !pending.has(JSON.stringify(dexieKey(spec.name, r))));
      await db.table(spec.name).bulkPut(fresh);
      pulled += fresh.length;
      since = Math.max(since, ...rows.map((r) => Number(r.server_seq)));
      await setMeta(db, `cursor:${spec.name}`, since);
      if (rows.length < PULL_LIMIT) break;
    }
  }
  return pulled;
}

const running = new WeakMap<HaifuDB, Promise<SyncResult>>();

/** 送ってから受け取る。同じ端末で同時に2回走らないようにする */
export function syncOnce(db: HaifuDB, remote: Remote): Promise<SyncResult> {
  const current = running.get(db);
  if (current) return current;
  const p = (async () => {
    try {
      const pushed = await pushOutbox(db, remote);
      const pulled = await pullChanges(db, remote);
      await setMeta(db, 'last_synced_at', new Date().toISOString());
      return { pushed, pulled };
    } finally {
      running.delete(db);
    }
  })();
  running.set(db, p);
  return p;
}
