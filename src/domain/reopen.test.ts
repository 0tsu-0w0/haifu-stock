import { describe, expect, it } from 'vitest';
import { syncOnce, type Remote, type Row } from '../sync/engine';
import { MemoryRemote } from '../sync/memoryRemote';
import { freshDb, itemId } from '../test/helpers';
import { preparedQty } from './catalog';
import { computeMoney, confirmClosing, isEventClosed, planCounts, reopenClosing, saveCountFrom } from './closing';
import { stockByLocation } from './ledger';
import { recordSale } from './record';
import { addSampleData, createCircle } from './setup';
import { deriveEvent, loadEventSnapshot } from './snapshot';

async function setup() {
  const db = freshDb('reopen');
  const ctx = await createCircle(db, 'テスト');
  const ev = await addSampleData(db, ctx);
  const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
  const snap = async () => (await loadEventSnapshot(db, ev.id))!;
  const row = async (name: string) => planCounts(await snap()).find((r) => r.item.name === name)!;
  const stock = async () => stockByLocation(await db.stock_movements.toArray(), await db.transactions.toArray());
  return { db, ctx, ev, home, snap, row, stock };
}

describe('終了処理のやり直し', () => {
  it('確定で入れた販売の追加・持ち込み数の修正・持ち帰り・返却をすべて打ち消し、確定前の状態に戻る', async () => {
    const { db, ctx, ev, home, snap, row, stock } = await setup();
    const id = (n: string) => itemId(db, n);
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: await id('新刊A'), qty: 3 }, { itemId: await id('友人の本'), qty: 2 }] });
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: await id('既刊C'), qty: 10 }] });
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: await id('既刊C'), qty: 1 }], zeroStockOverride: true });
    await saveCountFrom(db, ctx, ev.id, await row('既刊B'), 10); // 2部足りない → 販売を追加
    await saveCountFrom(db, ctx, ev.id, await row('既刊C'), 0);  // 持ち込み数を直す

    const before = deriveEvent(await snap());
    const stockBefore = await stock();
    const preparedBefore = await preparedQty(db, ev.id);

    await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });
    expect(deriveEvent(await snap()).totals.amount).toBe(before.totals.amount + 1000);

    const r = await reopenClosing(db, ctx, ev.id);
    expect(r.voided).toBe(1);
    expect(await isEventClosed(db, ev.id)).toBe(false);

    const after = deriveEvent(await snap());
    expect(after.totals).toEqual(before.totals);
    for (const [k, v] of before.summary) expect(after.summary.get(k)?.remaining).toBe(v.remaining);
    const stockAfter = await stock();
    for (const [k, v] of stockBefore) expect(stockAfter.get(k) ?? 0).toBe(v);
    expect(Object.fromEntries(await preparedQty(db, ev.id))).toEqual(Object.fromEntries(preparedBefore));

    // 数えた値は残っているので、そのまま確定し直せる
    expect((await row('既刊B')).counted).toBe(10);
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: await id('新刊A'), qty: 1 }] });
    const again = await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });
    const closings = await db.event_closings.where('event_id').equals(ev.id).toArray();
    expect(closings.filter((c) => !c.reopened_at).map((c) => c.id)).toEqual([again.id]);
    const m = computeMoney(await snap(), planCounts(await snap()));
    expect(again.summary.sales).toBe(before.totals.amount + 1000 + 800);
    expect(m.total).toBe(again.summary.sales);
  });

  it('確定していないイベントはやり直せない', async () => {
    const { db, ctx, ev } = await setup();
    await expect(reopenClosing(db, ctx, ev.id)).rejects.toThrow('確定済みの終了処理がありません');
  });

  it('同期では、やり直しをほかの記録より先に送る(サーバーが確定中のイベントへの追記を拒むため)', async () => {
    const { db, ctx, ev, home } = await setup();
    const remote = new MemoryRemote();
    await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });
    await syncOnce(db, remote);

    await reopenClosing(db, ctx, ev.id);
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: await itemId(db, '新刊A'), qty: 1 }] });
    await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });

    const order: string[] = [];
    const spy: Remote = {
      push: async (t: string, rows: Row[]) => {
        order.push(rows.map((r) => `${t}${t === 'event_closings' ? (r.reopened_at ? ':reopen' : ':close') : ''}`)[0]);
        return remote.push(t, rows);
      },
      pull: (t, s, l) => remote.pull(t, s, l),
    };
    await syncOnce(db, spy);
    expect(order[0]).toBe('event_closings:reopen');
    expect(order.indexOf('transactions')).toBeLessThan(order.indexOf('event_closings:close'));
    expect(await db.outbox.count()).toBe(0);
  });
});
