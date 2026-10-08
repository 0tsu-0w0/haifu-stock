import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { addPrintRun, createItemForEvent, prepareEvent, preparedQty, saveEventInfo, saveExpense, saveFloat, saveItem, saveOwner } from './catalog';
import { confirmClosing, planCounts } from './closing';
import { stockByLocation } from './ledger';
import { recordSale } from './record';
import { createCircle } from './setup';
import { deriveEvent, loadEventSnapshot } from './snapshot';

async function setup() {
  const db = freshDb('catalog');
  const ctx = await createCircle(db, 'テストサークル');
  const self = (await db.owners.filter((o) => o.is_self).first())!;
  const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
  const stockAt = async (itemId: string, loc: string) =>
    stockByLocation(await db.stock_movements.toArray(), await db.transactions.toArray()).get(`${itemId}|${loc}`) ?? 0;
  return { db, ctx, self, home, stockAt };
}

describe('品目と刷り記録', () => {
  it('品目を登録し、刷り記録をつけると自宅に在庫が入る。版は自動で数える', async () => {
    const { db, ctx, self, home, stockAt } = await setup();
    const item = await saveItem(db, ctx, { name: '新刊A', kind: 'book', price: 800, ownerId: self.id, lowThreshold: 3 });
    const r1 = await addPrintRun(db, ctx, { itemId: item.id, qty: 50, totalCost: 30000, printedOn: '2026-10-01', toLocationId: home.id });
    const r2 = await addPrintRun(db, ctx, { itemId: item.id, qty: 30, totalCost: 15000, printedOn: null, toLocationId: home.id });
    expect([r1.edition, r2.edition]).toEqual([1, 2]);
    expect(await stockAt(item.id, home.id)).toBe(80);
  });

  it('入力が正しくないときは保存しない', async () => {
    const { db, ctx, self } = await setup();
    await expect(saveItem(db, ctx, { name: ' ', kind: 'book', price: 800, ownerId: self.id, lowThreshold: 3 })).rejects.toThrow('品目名');
    await expect(saveItem(db, ctx, { name: 'A', kind: 'book', price: -1, ownerId: self.id, lowThreshold: 3 })).rejects.toThrow('価格');
    const a = await saveItem(db, ctx, { name: 'A', kind: 'book', price: 500, ownerId: self.id, lowThreshold: 3 });
    await expect(saveItem(db, ctx, { name: 'S', kind: 'set', price: 900, ownerId: self.id, lowThreshold: 3, components: [{ itemId: a.id, qty: 1 }] }))
      .rejects.toThrow('2つ以上');
    await expect(saveItem(db, ctx, { id: a.id, name: 'A', kind: 'goods', price: 500, ownerId: self.id, lowThreshold: 3 })).rejects.toThrow('種類');
    await expect(saveOwner(db, ctx, { name: 'B', feeRate: 1.5 })).rejects.toThrow('0〜100%');
  });
});

describe('イベントの準備', () => {
  async function withEvent() {
    const s = await setup();
    const { db, ctx, self, home } = s;
    const a = await saveItem(db, ctx, { name: '新刊A', kind: 'book', price: 800, ownerId: self.id, lowThreshold: 3 });
    const b = await saveItem(db, ctx, { name: '既刊B', kind: 'book', price: 500, ownerId: self.id, lowThreshold: 3 });
    const set = await saveItem(db, ctx, {
      name: 'A+Bセット', kind: 'set', price: 1200, ownerId: self.id, lowThreshold: 3,
      components: [{ itemId: a.id, qty: 1 }, { itemId: b.id, qty: 1 }],
    });
    const friend = await saveOwner(db, ctx, { name: 'サークルB', feeRate: 0.1 });
    const fb = await saveItem(db, ctx, { name: '友人の本', kind: 'book', price: 600, ownerId: friend.id, lowThreshold: 3 });
    await addPrintRun(db, ctx, { itemId: a.id, qty: 40, totalCost: 30000, printedOn: null, toLocationId: home.id });
    await addPrintRun(db, ctx, { itemId: b.id, qty: 20, totalCost: 12000, printedOn: null, toLocationId: home.id });
    const ev = await saveEventInfo(db, ctx, { name: 'コミティア', heldOn: '2026-11-01', spaceNo: 'A12a' });
    return { ...s, a, b, set, fb, ev };
  }

  it('持ち込み数との差だけ在庫が動く。受託品は預かりとして入る', async () => {
    const { db, ctx, home, stockAt, a, b, set, fb, ev } = await withEvent();
    const lines = (n: { a: number; b: number; fb: number }) => [
      { itemId: a.id, included: true, bring: n.a, priceOverride: null },
      { itemId: b.id, included: true, bring: n.b, priceOverride: 450 },
      { itemId: set.id, included: true, bring: 0, priceOverride: null },
      { itemId: fb.id, included: true, bring: n.fb, priceOverride: null },
    ];
    await prepareEvent(db, ctx, ev.id, lines({ a: 30, b: 10, fb: 12 }), { storageId: home.id });
    expect(await stockAt(a.id, home.id)).toBe(10);
    await prepareEvent(db, ctx, ev.id, lines({ a: 25, b: 10, fb: 10 }), { storageId: home.id });
    expect(await stockAt(a.id, home.id)).toBe(15);
    expect(Object.fromEntries(await preparedQty(db, ev.id))).toMatchObject({ [a.id]: 25, [b.id]: 10, [fb.id]: 10 });

    const snap = (await loadEventSnapshot(db, ev.id))!;
    const d = deriveEvent(snap);
    expect(snap.eventItems.map((e) => d.itemById.get(e.item_id)!.name)).toEqual(['新刊A', '既刊B', 'A+Bセット', '友人の本']);
    expect(d.summary.get(set.id)?.remaining).toBe(10);
    expect(d.priceOf(b)).toBe(450); // イベント限定価格
  });

  it('販売のあとに持ち込み数を変えても、売った分は在庫に戻らない', async () => {
    const { db, ctx, home, stockAt, a, ev } = await withEvent();
    const line = (n: number) => [{ itemId: a.id, included: true, bring: n, priceOverride: null }];
    await prepareEvent(db, ctx, ev.id, line(30), { storageId: home.id });
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a.id, qty: 5 }] });
    await prepareEvent(db, ctx, ev.id, line(32), { storageId: home.id }); // 2部追加で持ち込んだ
    const d = deriveEvent((await loadEventSnapshot(db, ev.id))!);
    expect(d.summary.get(a.id)).toMatchObject({ brought: 32, sold: 5, remaining: 27 });
    expect(await stockAt(a.id, home.id)).toBe(8);
  });

  it('イベントから外すと、在庫は戻り、レジには並ばない', async () => {
    const { db, ctx, home, stockAt, a, b, ev } = await withEvent();
    await prepareEvent(db, ctx, ev.id, [
      { itemId: a.id, included: true, bring: 10, priceOverride: null },
      { itemId: b.id, included: true, bring: 5, priceOverride: null },
    ], { storageId: home.id });
    await prepareEvent(db, ctx, ev.id, [
      { itemId: a.id, included: true, bring: 10, priceOverride: null },
      { itemId: b.id, included: false, bring: 5, priceOverride: null },
    ], { storageId: home.id });
    expect(await stockAt(b.id, home.id)).toBe(20);
    const snap = (await loadEventSnapshot(db, ev.id))!;
    expect(snap.eventItems.map((e) => e.item_id)).toEqual([a.id]);
    expect(planCounts(snap).map((r) => r.item.name)).toEqual(['新刊A']);
  });

  it('準備画面から新しい品目を作ると、刷り記録と持ち込みまで一度に入り、いまの品目の後ろに並ぶ', async () => {
    const { db, ctx, home, stockAt, a, ev } = await withEvent();
    await prepareEvent(db, ctx, ev.id, [{ itemId: a.id, included: true, bring: 10, priceOverride: null }], { storageId: home.id });

    const zine = await createItemForEvent(db, ctx, ev.id, {
      name: 'コピー本', kind: 'book', price: 300, owner: { id: (await db.owners.filter((o) => o.is_self).first())!.id },
      print: { qty: 20, totalCost: 2000 }, bring: 15,
    }, { storageId: home.id });
    expect(await stockAt(zine.id, home.id)).toBe(5);
    expect((await db.print_runs.where('item_id').equals(zine.id).first())?.total_cost).toBe(2000);

    const goods = await createItemForEvent(db, ctx, ev.id, {
      name: '友人のアクスタ', kind: 'goods', price: 1000, owner: { newName: 'サークルC', feeRate: 0.2 }, bring: 6,
    }, { storageId: home.id });
    const owner = (await db.owners.get(goods.owner_id))!;
    expect(owner).toMatchObject({ name: 'サークルC', default_fee_rate: 0.2, is_self: false });

    const snap = (await loadEventSnapshot(db, ev.id))!;
    const d = deriveEvent(snap);
    expect(snap.eventItems.map((e) => d.itemById.get(e.item_id)!.name)).toEqual(['新刊A', 'コピー本', '友人のアクスタ']);
    expect(d.summary.get(zine.id)?.brought).toBe(15);
    expect(d.summary.get(goods.id)?.brought).toBe(6);
  });

  it('新しい品目の入力が正しくなければ、受託元も品目も残らない', async () => {
    const { db, ctx, home, ev } = await withEvent();
    const before = { owners: await db.owners.count(), items: await db.items.count() };
    await expect(createItemForEvent(db, ctx, ev.id, {
      name: '', kind: 'book', price: 300, owner: { newName: 'サークルD', feeRate: 0 }, bring: 5,
    }, { storageId: home.id })).rejects.toThrow('品目名');
    expect({ owners: await db.owners.count(), items: await db.items.count() }).toEqual(before);
  });

  it('釣り銭と経費が集計に入り、確定後は準備を変えられない', async () => {
    const { db, ctx, home, a, ev } = await withEvent();
    await prepareEvent(db, ctx, ev.id, [{ itemId: a.id, included: true, bring: 10, priceOverride: null }], { storageId: home.id });
    await saveFloat(db, ctx, ev.id, 1000, 10);
    await saveFloat(db, ctx, ev.id, 100, 30);
    await saveExpense(db, ctx, { eventId: ev.id, category: 'booth_fee', planned: 7000, actual: null });
    const snap = (await loadEventSnapshot(db, ev.id))!;
    expect(deriveEvent(snap).float).toBe(13000);
    expect(snap.expenses[0]).toMatchObject({ label: '出展費', planned_amount: 7000 });

    await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });
    await expect(prepareEvent(db, ctx, ev.id, [{ itemId: a.id, included: true, bring: 12, priceOverride: null }], { storageId: home.id }))
      .rejects.toThrow('確定済み');
    await expect(saveFloat(db, ctx, ev.id, 1000, 1)).rejects.toThrow('確定済み');
  });
});
