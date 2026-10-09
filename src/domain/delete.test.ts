import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { loadAnalysis } from './analysis';
import { addPrintRun, deleteEvent, deleteItem, prepareEvent, restoreEvent, restoreItem, saveEventInfo, saveItem, saveOwner } from './catalog';
import { confirmClosing } from './closing';
import { stockByLocation } from './ledger';
import { recordSale } from './record';
import { createCircle } from './setup';

async function setup() {
  const db = freshDb('delete');
  const ctx = await createCircle(db, 'テスト');
  const self = (await db.owners.filter((o) => o.is_self).first())!;
  const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
  const a = await saveItem(db, ctx, { name: '新刊A', kind: 'book', price: 800, ownerId: self.id, lowThreshold: 3 });
  const b = await saveItem(db, ctx, { name: '既刊B', kind: 'book', price: 500, ownerId: self.id, lowThreshold: 3 });
  const friend = await saveOwner(db, ctx, { name: 'サークルB', feeRate: 0 });
  const fb = await saveItem(db, ctx, { name: '友人の本', kind: 'book', price: 600, ownerId: friend.id, lowThreshold: 3 });
  await addPrintRun(db, ctx, { itemId: a.id, qty: 50, totalCost: 30000, printedOn: null, toLocationId: home.id });
  const ev = await saveEventInfo(db, ctx, { name: 'コミティア', heldOn: '2026-05-01' });
  await prepareEvent(db, ctx, ev.id, [
    { itemId: a.id, included: true, bring: 30, priceOverride: null },
    { itemId: fb.id, included: true, bring: 10, priceOverride: null },
  ], { storageId: home.id });
  const homeStock = async (id: string) =>
    stockByLocation(await db.stock_movements.toArray(), await db.transactions.toArray()).get(`${id}|${home.id}`) ?? 0;
  return { db, ctx, self, home, a, b, fb, ev, homeStock };
}

describe('イベントと品目の削除', () => {
  it('終了処理をしていないイベントを削除すると、残りの在庫が戻り、記録は残る。元に戻せる', async () => {
    const { db, ctx, home, a, ev, homeStock } = await setup();
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a.id, qty: 4 }] });
    const r = await deleteEvent(db, ctx, ev.id, { storageId: home.id });
    expect(r.returned).toBe(26 + 10);
    expect(await homeStock(a.id)).toBe(50 - 4);
    expect((await db.events.get(ev.id))?.deleted_at).toBeTruthy();
    expect(await db.transactions.where('event_id').equals(ev.id).count()).toBe(1);

    await restoreEvent(db, ev.id);
    expect((await db.events.get(ev.id))?.deleted_at).toBeNull();
  });

  it('削除したイベントは、刷り部数の目安の材料に使わない', async () => {
    const { db, ctx, home, a, ev } = await setup();
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a.id, qty: 10 }] });
    await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });
    expect((await loadAnalysis(db, ctx.circleId)).histories.get(a.id)?.observations).toHaveLength(1);
    await deleteEvent(db, ctx, ev.id, { storageId: home.id });
    expect((await loadAnalysis(db, ctx.circleId)).histories.get(a.id)?.observations).toHaveLength(0);
  });

  it('持ち込み中の品目やセットの中身は消せない。外したり確定したりすれば消せて、元に戻せる', async () => {
    const { db, ctx, self, home, a, b, ev } = await setup();
    await expect(deleteItem(db, a.id)).rejects.toThrow('持ち込み中');
    const set = await saveItem(db, ctx, { name: 'セット', kind: 'set', price: 1200, ownerId: self.id, lowThreshold: 3, components: [{ itemId: a.id, qty: 1 }, { itemId: b.id, qty: 1 }] });
    await expect(deleteItem(db, b.id)).rejects.toThrow('セット「セット」の中身');

    await deleteItem(db, set.id);
    await deleteItem(db, b.id);
    expect((await db.items.get(b.id))?.deleted_at).toBeTruthy();
    // 編集しても削除の印は消えない
    await saveItem(db, ctx, { id: b.id, name: '既刊B(改)', kind: 'book', price: 500, ownerId: self.id, lowThreshold: 3 });
    expect((await db.items.get(b.id))?.deleted_at).toBeTruthy();

    await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });
    await deleteItem(db, a.id);
    expect((await loadAnalysis(db, ctx.circleId)).ownItems.map((i) => i.name)).not.toContain('新刊A');

    await restoreItem(db, a.id);
    expect((await db.items.get(a.id))?.deleted_at).toBeNull();
  });
});
