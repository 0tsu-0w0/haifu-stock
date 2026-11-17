import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { addPrintRun, deliverableEvents, directDelivered, prepareEvent, preparedQty, saveItem } from './catalog';
import { confirmClosing } from './closing';
import { createCircle, createEvent } from './setup';
import { storageStock } from './stock';

async function setup() {
  const db = freshDb('direct');
  const ctx = await createCircle(db, 'テストサークル');
  const self = (await db.owners.filter((o) => o.is_self).first())!;
  const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
  const a = await saveItem(db, ctx, { name: '新刊A', kind: 'book', price: 800, ownerId: self.id, lowThreshold: 3 });
  const b = await saveItem(db, ctx, { name: '既刊B', kind: 'book', price: 500, ownerId: self.id, lowThreshold: 3 });
  await addPrintRun(db, ctx, { itemId: b.id, qty: 20, totalCost: 10000, printedOn: '2026-01-01', toLocationId: home.id });
  const ev = await createEvent(db, ctx, { name: 'イベント', heldOn: '2026-12-01' });
  return { db, ctx, home, a, b, ev };
}

describe('直接搬入(F-302)', () => {
  it('刷り上がりを会場に入れ、持ち込みに加える。家の在庫は動かない', async () => {
    const { db, ctx, home, a, b, ev } = await setup();
    await prepareEvent(db, ctx, ev.id, [{ itemId: b.id, included: true, bring: 10, priceOverride: null }], { storageId: home.id });
    await addPrintRun(db, ctx, { itemId: a.id, qty: 50, totalCost: 30000, printedOn: '2026-11-20', toLocationId: home.id, toEventId: ev.id });

    expect((await preparedQty(db, ev.id)).get(a.id)).toBe(50);
    expect((await directDelivered(db, ev.id)).get(a.id)).toBe(50);
    expect((await storageStock(db, ctx.circleId)).get(`${a.id}|${home.id}`) ?? 0).toBe(0);
    const ei = (await db.event_items.get([ev.id, a.id]))!;
    expect(ei).toMatchObject({ planned_qty: 50, removed_at: null, sort_order: 1 });
  });

  it('あとで持ち込みを反映しても、直接搬入した分は家から引かない。自己搬入を足した分だけ家から出す', async () => {
    const { db, ctx, home, a, ev } = await setup();
    await addPrintRun(db, ctx, { itemId: a.id, qty: 50, totalCost: 30000, printedOn: null, toLocationId: home.id });
    await addPrintRun(db, ctx, { itemId: a.id, qty: 30, totalCost: 15000, printedOn: null, toLocationId: home.id, toEventId: ev.id });
    await prepareEvent(db, ctx, ev.id, [{ itemId: a.id, included: true, bring: 40, priceOverride: null }], { storageId: home.id });
    expect((await preparedQty(db, ev.id)).get(a.id)).toBe(40);
    expect((await storageStock(db, ctx.circleId)).get(`${a.id}|${home.id}`)).toBe(40);
  });

  it('終了処理で、残った分は戻し先に入る', async () => {
    const { db, ctx, home, a, ev } = await setup();
    await addPrintRun(db, ctx, { itemId: a.id, qty: 30, totalCost: 15000, printedOn: null, toLocationId: home.id, toEventId: ev.id });
    await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });
    expect((await storageStock(db, ctx.circleId)).get(`${a.id}|${home.id}`)).toBe(30);
    await expect(addPrintRun(db, ctx, { itemId: a.id, qty: 5, totalCost: 0, printedOn: null, toLocationId: home.id, toEventId: ev.id }))
      .rejects.toThrow();
    expect(await db.print_runs.where('item_id').equals(a.id).count()).toBe(1);
  });

  it('届け先に選べるのは、終了処理をしておらず、最終日が今日より前でないイベント', async () => {
    const { db, ctx, home, ev } = await setup();
    const past = await createEvent(db, ctx, { name: '過去', heldOn: '2026-01-10' });
    const closed = await createEvent(db, ctx, { name: '確定済み', heldOn: '2026-12-20' });
    await confirmClosing(db, ctx, closed.id, { returnLocationId: home.id });
    const list = await deliverableEvents(db, ctx.circleId, '2026-11-16');
    expect(list.map((e) => e.id)).toEqual([ev.id]);
    expect(list.some((e) => e.id === past.id)).toBe(false);
  });
});

describe('再版の目安の在庫(直接搬入)', () => {
  it('これからのイベントに直接搬入した分は、手元の在庫として数える', async () => {
    const { db, ctx, home, a, ev } = await setup();
    await addPrintRun(db, ctx, { itemId: a.id, qty: 30, totalCost: 15000, printedOn: null, toLocationId: home.id, toEventId: ev.id });
    const { loadAnalysis } = await import('./analysis');
    // ev の開催日(2026-12-01)が今日より前の環境でも数えられるよう、先の日付のイベントにも入れておく
    const far = await createEvent(db, ctx, { name: '先のイベント', heldOn: '2099-01-01' });
    await addPrintRun(db, ctx, { itemId: a.id, qty: 20, totalCost: 10000, printedOn: null, toLocationId: home.id, toEventId: far.id });
    const data = await loadAnalysis(db, ctx.circleId);
    expect(data.upcoming.some((e) => e.id === far.id)).toBe(true);
    expect(data.upcomingStock.get(a.id)).toBeGreaterThanOrEqual(20);
    expect(data.storageStock.get(a.id) ?? 0).toBe(0);
  });
});
