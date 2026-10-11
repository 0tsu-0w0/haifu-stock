import { describe, expect, it } from 'vitest';
import { getMeta } from '../db/local';
import { TABLES, TABLE_BY_NAME } from '../db/tables';
import { startBreak } from '../domain/breaks';
import { saveItem } from '../domain/catalog';
import { recordSale } from '../domain/record';
import { addSampleData, createCircle } from '../domain/setup';
import { freshDb, itemId } from '../test/helpers';
import { SYNC_ERRORS_KEY, SyncFailedError, syncOnce, type Row, type TableError } from './engine';
import { MemoryRemote } from './memoryRemote';

/** 決めた表だけエラーにする偽のサーバー(権限が足りない表や、サーバーにまだない表をまねる) */
class FlakyRemote extends MemoryRemote {
  constructor(public broken: Set<string>) {
    super();
  }
  async push(table: string, rows: Row[]) {
    if (this.broken.has(table)) throw new Error(`permission denied for table ${table}`);
    return super.push(table, rows);
  }
  async pull(table: string, since: number, limit: number) {
    if (this.broken.has(table)) throw new Error(`relation "${table}" does not exist`);
    return super.pull(table, since, limit);
  }
}

async function setup(broken: string[]) {
  const remote = new FlakyRemote(new Set(broken));
  const db = freshDb('partial');
  const ctx = await createCircle(db, 'テスト');
  const ev = await addSampleData(db, ctx);
  return { remote, db, ctx, ev };
}

describe('同期で1つの表がエラーになっても続ける(#17)', () => {
  it('関係のない表が送れなくても、販売の記録は送られる', async () => {
    const { remote, db, ctx, ev } = await setup(['event_breaks']);
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: await itemId(db, '新刊A'), qty: 1 }] });
    await startBreak(db, ctx, ev.id);
    const r = await syncOnce(db, remote);
    expect(remote.count('transactions')).toBe(1);
    expect(remote.count('transaction_lines')).toBe(1);
    expect(remote.count('items')).toBeGreaterThan(0);
    // 送れなかった表の送信待ちは残し、次の同期で送る
    expect(await db.outbox.where('table').equals('event_breaks').count()).toBe(1);
    expect(await db.outbox.where('table').equals('transactions').count()).toBe(0);
    expect(r.failed.map((f) => [f.table, f.phase])).toEqual([['event_breaks', 'push'], ['event_breaks', 'pull']]);
    expect(await getMeta<TableError[]>(db, SYNC_ERRORS_KEY)).toHaveLength(2);

    // 直ったら送られ、エラーの記録も消える
    remote.broken.clear();
    const again = await syncOnce(db, remote);
    expect(again.failed).toEqual([]);
    expect(remote.count('event_breaks')).toBe(1);
    expect(await getMeta<TableError[]>(db, SYNC_ERRORS_KEY)).toEqual([]);
  });

  it('親の表が送れなかったら、その子の表は送らずに待つ', async () => {
    const { remote, db, ctx, ev } = await setup(['items']);
    const self = (await db.owners.filter((o) => o.is_self).first())!;
    await saveItem(db, ctx, { name: '新しい本', kind: 'book', price: 500, ownerId: self.id, lowThreshold: 3 });
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: await itemId(db, '新刊A'), qty: 1 }] });
    const r = await syncOnce(db, remote);
    const blocked = r.failed.filter((f) => f.blockedBy);
    // 明細は品目を参照するので待つ。販売の記録(取引)は品目を参照しないので送る
    expect(blocked.map((f) => f.table)).toContain('transaction_lines');
    expect(blocked.find((f) => f.table === 'transaction_lines')!.blockedBy).toBe('items');
    expect(remote.count('transactions')).toBe(1);
    expect(remote.count('transaction_lines')).toBe(0);
    expect(await db.outbox.where('table').equals('transaction_lines').count()).toBe(1);
    expect(remote.count('owners')).toBeGreaterThan(0);
  });

  it('すべて失敗したとき(通信できない)は、同期そのものの失敗として投げる', async () => {
    const { remote, db } = await setup([]);
    remote.offline = true;
    await expect(syncOnce(db, remote)).rejects.toBeInstanceOf(SyncFailedError);
  });

  it('表の親は、一覧で自分より前にある', () => {
    TABLES.forEach((t, i) => {
      for (const p of t.parents) {
        expect(TABLE_BY_NAME[p], `${t.name} の親 ${p}`).toBeDefined();
        expect(TABLES.findIndex((x) => x.name === p), `${t.name} の親 ${p} は前に`).toBeLessThan(i);
      }
    });
  });
});
