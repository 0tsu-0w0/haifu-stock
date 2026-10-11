import { getMeta, setMeta, type HaifuDB } from '../db/local';
import { SERVER_COLUMNS, TABLES, TABLE_BY_NAME, dexieKey, keyFromOutbox } from '../db/tables';

// 同期の本体。送る: 送信待ちの行を親テーブルから順に送る。受け取る: テーブルごとに server_seq の続きから取る。
// 通信相手は Remote として差し替えられる(本番は Supabase、テストはメモリ上の偽物)。
// 1つの表でエラーが出ても止めず、ほかの表は続ける(#17)。親の表が送れなかったときは、その子の表は送らない

export type Row = Record<string, unknown>;

export interface Remote {
  /** 台帳は同じ主キーがあれば無視、マスタは後勝ちで書き込む */
  push(table: string, rows: Row[]): Promise<void>;
  /** server_seq が since より大きい行を、小さい順に limit 件まで返す */
  pull(table: string, since: number, limit: number): Promise<Row[]>;
  /**
   * 表ごとの最新の server_seq(見える行だけ)。変わった表だけを受け取りに行くために使う(軽量化)。
   * 使えないときは null を返し、そのときは全部の表を受け取りに行く
   */
  heads?(): Promise<Record<string, number> | null>;
}

/** 同期できなかった表 */
export interface TableError {
  table: string;
  phase: 'push' | 'pull';
  message: string;
  /** 親の表が送れなかったので、送らずに待っている */
  blockedBy?: string;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  failed: TableError[];
  /** 受け取りでサーバーに問い合わせた回数(軽量化の確認用) */
  pullRequests: number;
}

const PULL_LIMIT = 500;
export const SYNC_ERRORS_KEY = 'sync_errors';

function stripServerColumns(row: Row): Row {
  const out: Row = { ...row };
  for (const c of SERVER_COLUMNS) delete out[c];
  return out;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : String(e));

/** 表 name の親(さかのぼって)のうち、送れなかったものがあればその名前 */
function blockedParent(name: string, broken: Set<string>): string | undefined {
  for (const p of TABLE_BY_NAME[name].parents) {
    if (broken.has(p)) return p;
    const up = blockedParent(p, broken);
    if (up) return up;
  }
  return undefined;
}

export async function pushOutbox(db: HaifuDB, remote: Remote): Promise<{ pushed: number; failed: TableError[]; attempted: number }> {
  const entries = await db.outbox.orderBy('seq').toArray();
  const failed: TableError[] = [];
  if (entries.length === 0) return { pushed: 0, failed, attempted: 0 };

  let pushed = 0;
  let attempted = 0;
  // 送れなかった表(とその子)。その子の表は、この回は送らない
  const broken = new Set<string>();

  // 終了処理のやり直し(reopened_at を入れた確定の記録)は、ほかより先に送る。
  // サーバーは確定中のイベントへの追記を拒むので、先に解除しておかないと、
  // やり直しの取り消しや、確定し直したときの記録が受け付けられない
  const reopenKeys = new Set<string>();
  for (const e of entries.filter((x) => x.table === 'event_closings')) {
    const row = await db.event_closings.get(keyFromOutbox('event_closings', e.key) as string);
    if (row?.reopened_at) reopenKeys.add(e.key);
  }
  if (reopenKeys.size > 0) {
    const rows = (await Promise.all([...reopenKeys].map((k) => db.event_closings.get(keyFromOutbox('event_closings', k) as string))))
      .filter((r): r is NonNullable<typeof r> => r != null)
      .map((r) => stripServerColumns(r as unknown as Row));
    attempted++;
    try {
      await remote.push('event_closings', rows);
      await db.outbox.bulkDelete(entries.filter((e) => e.table === 'event_closings' && reopenKeys.has(e.key)).map((e) => e.seq!));
      pushed += rows.length;
    } catch (e) {
      // やり直しが届かないと、そのイベントの販売の記録も受け付けられないので、台帳は送らずに待つ
      failed.push({ table: 'event_closings', phase: 'push', message: messageOf(e) });
      broken.add('event_closings');
      for (const t of ['transactions', 'transaction_lines', 'stock_movements']) broken.add(t);
    }
  }

  for (const spec of TABLES) {
    const mine = entries.filter((e) => e.table === spec.name && !(spec.name === 'event_closings' && reopenKeys.has(e.key)));
    if (mine.length === 0) continue;
    const parent = broken.has(spec.name) ? undefined : blockedParent(spec.name, broken);
    if (broken.has(spec.name) || parent) {
      // 送信待ちは消さずに残し、次の同期で送る
      if (parent) failed.push({ table: spec.name, phase: 'push', message: '親の表が送れていないので待っています', blockedBy: parent });
      broken.add(spec.name);
      continue;
    }
    // 同じ行が何度も積まれていても、送るのは最新の内容を1回だけ
    const keys = [...new Set(mine.map((e) => e.key))];
    const rows = (await Promise.all(keys.map((k) => db.table(spec.name).get(keyFromOutbox(spec.name, k) as never))))
      .filter((r): r is Row => r != null)
      .map(stripServerColumns);
    attempted++;
    try {
      if (rows.length > 0) await remote.push(spec.name, rows);
    } catch (e) {
      failed.push({ table: spec.name, phase: 'push', message: messageOf(e) });
      broken.add(spec.name);
      continue;
    }
    // 送っている間に積まれた新しい記録は消さない
    await db.outbox.bulkDelete(mine.map((e) => e.seq!));
    pushed += rows.length;
  }
  return { pushed, failed, attempted };
}

export async function pullChanges(db: HaifuDB, remote: Remote): Promise<{ pulled: number; failed: TableError[]; requests: number }> {
  let pulled = 0;
  let requests = 0;
  const failed: TableError[] = [];
  // 変わった表だけを受け取る。1回の問い合わせで全部の表の最新の番号を見る
  let heads: Record<string, number> | null = null;
  if (remote.heads) {
    try {
      heads = await remote.heads();
      requests++;
    } catch {
      heads = null; // 調べられなければ、これまでどおり全部の表を見に行く
    }
  }
  for (const spec of TABLES) {
    try {
      let since = (await getMeta<number>(db, `cursor:${spec.name}`)) ?? 0;
      const head = heads?.[spec.name];
      if (typeof head === 'number' && head <= since) continue;
      for (;;) {
        const rows = await remote.pull(spec.name, since, PULL_LIMIT);
        requests++;
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
    } catch (e) {
      // 受け取りは表どうしの順番に頼らないので、ほかの表は続ける。続きは次の同期で、覚えている位置から取る
      failed.push({ table: spec.name, phase: 'pull', message: messageOf(e) });
    }
  }
  return { pulled, failed, requests };
}

/** すべてが失敗した(通信できない・サーバーが落ちている)ときは、同期そのものの失敗として投げる */
export class SyncFailedError extends Error {
  constructor(readonly failed: TableError[]) {
    super(failed.find((f) => !f.blockedBy)?.message ?? '同期できませんでした');
  }
}

const running = new WeakMap<HaifuDB, Promise<SyncResult>>();

/** 送ってから受け取る。同じ端末で同時に2回走らないようにする */
export function syncOnce(db: HaifuDB, remote: Remote): Promise<SyncResult> {
  const current = running.get(db);
  if (current) return current;
  const p = (async () => {
    try {
      const push = await pushOutbox(db, remote);
      const pull = await pullChanges(db, remote);
      const failed = [...push.failed, ...pull.failed];
      await setMeta(db, SYNC_ERRORS_KEY, failed);
      const pushAllFailed = push.attempted > 0 && push.failed.filter((f) => !f.blockedBy).length >= push.attempted;
      const pullAllFailed = pull.failed.length === TABLES.length;
      if (pullAllFailed && (push.attempted === 0 || pushAllFailed)) throw new SyncFailedError(failed);
      await setMeta(db, 'last_synced_at', new Date().toISOString());
      return { pushed: push.pushed, pulled: pull.pulled, failed, pullRequests: pull.requests };
    } finally {
      running.delete(db);
    }
  })();
  running.set(db, p);
  return p;
}
