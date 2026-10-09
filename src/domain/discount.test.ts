import { describe, expect, it } from 'vitest';
import { eventState, freshDb } from '../test/helpers';
import {
  addPrintRun, copyFloatAndExpenses, planFromEvent, prepareEvent, saveEventInfo, saveExpense, saveFloat, saveItem, saveOwner,
} from './catalog';
import { computeMoney, planCounts } from './closing';
import { historyRows } from './history';
import { allocateDiscount, recordSale } from './record';
import { createCircle } from './setup';
import { deriveEvent, loadEventSnapshot } from './snapshot';

async function setup() {
  const db = freshDb('discount');
  const ctx = await createCircle(db, 'テスト');
  const self = (await db.owners.filter((o) => o.is_self).first())!;
  const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
  const a = await saveItem(db, ctx, { name: '新刊A', kind: 'book', price: 800, ownerId: self.id, lowThreshold: 3 });
  const friend = await saveOwner(db, ctx, { name: 'サークルB', feeRate: 0 });
  const fb = await saveItem(db, ctx, { name: '友人の本', kind: 'book', price: 400, ownerId: friend.id, lowThreshold: 3 });
  await addPrintRun(db, ctx, { itemId: a.id, qty: 50, totalCost: 30000, printedOn: null, toLocationId: home.id });
  const ev = await saveEventInfo(db, ctx, { name: 'コミティア', heldOn: '2026-05-01' });
  await prepareEvent(db, ctx, ev.id, [
    { itemId: a.id, included: true, bring: 20, priceOverride: 700 },
    { itemId: fb.id, included: true, bring: 10, priceOverride: null },
  ], { storageId: home.id });
  return { db, ctx, home, a, fb, friend, ev };
}

describe('値引き(F-409)', () => {
  it('値引きを明細の金額の比で割り振り、合計がちょうど値引き額になる', () => {
    expect(allocateDiscount([1400, 400], 300)).toEqual([233, 67]);
    expect(allocateDiscount([500, 500, 500], 100)).toEqual([34, 33, 33]);
    expect(allocateDiscount([800], 800)).toEqual([800]);
    expect(allocateDiscount([800, 400], 0)).toEqual([0, 0]);
  });

  it('値引きした販売は、売上・持ち主別・受託の精算・履歴がすべて値引き後の金額になる', async () => {
    const { db, ctx, a, fb, friend, ev } = await setup();
    // 700×2 + 400 = 1800 を 1500 にする
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a.id, qty: 2 }, { itemId: fb.id, qty: 1 }], discount: 300, note: 'まとめ買い' });
    const { totals } = await eventState(db, ev.id);
    expect(totals.amount).toBe(1500);
    expect(totals.count).toBe(3);
    expect(totals.byOwner.get(friend.id)).toBe(400 - 67);

    const snap = (await loadEventSnapshot(db, ev.id))!;
    const money = computeMoney(snap, planCounts(snap));
    expect(money.total).toBe(1500);
    expect(money.settlements[0].amount).toBe(333);

    const d = deriveEvent(snap);
    const [row] = historyRows(snap.txns, d.linesByTxn, d.itemById);
    expect(row.amount).toBe(1500);
    expect(row.discount).toBe(300);
    expect(row.txn.note).toBe('まとめ買い');
  });

  it('合計を超える値引きや、負の値引きは記録しない', async () => {
    const { db, ctx, a, ev } = await setup();
    await expect(recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a.id, qty: 1 }], discount: 701 })).rejects.toThrow('値引きが合計を超えています');
    await expect(recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a.id, qty: 1 }], discount: -1 })).rejects.toThrow();
    expect(await db.transactions.count()).toBe(0);
  });
});

describe('前回のイベントからコピー(F-303)', () => {
  it('持ち込む品目・数・イベント価格を読み、釣り銭と経費は空のときだけ写す', async () => {
    const { db, ctx, a, fb, ev } = await setup();
    await saveFloat(db, ctx, ev.id, 100, 30);
    await saveFloat(db, ctx, ev.id, 1000, 5);
    await saveExpense(db, ctx, { eventId: ev.id, category: 'booth_fee', planned: 7000, actual: 7500 });

    const next = await saveEventInfo(db, ctx, { name: 'コミティア次回', heldOn: '2026-08-01' });
    const plan = await planFromEvent(db, ev.id);
    expect(plan.map((l) => [l.itemId, l.bring, l.priceOverride])).toEqual([[a.id, 20, 700], [fb.id, 10, null]]);
    // フォームに入れるだけなので、在庫はまだ動いていない
    expect(await db.stock_movements.where('event_id').equals(next.id).count()).toBe(0);

    expect(await copyFloatAndExpenses(db, ctx, ev.id, next.id)).toEqual({ float: true, expenses: 1 });
    const cash = await db.cash_counts.where('event_id').equals(next.id).toArray();
    expect(cash.map((c) => [c.denomination, c.count]).sort((x, y) => x[0] - y[0])).toEqual([[100, 30], [1000, 5]]);
    const exp = await db.expenses.where('event_id').equals(next.id).toArray();
    expect(exp.map((e) => [e.category, e.planned_amount, e.actual_amount])).toEqual([['booth_fee', 7500, null]]);

    // 2回目は、もう入っているので写さない
    expect(await copyFloatAndExpenses(db, ctx, ev.id, next.id)).toEqual({ float: false, expenses: 0 });
  });
});
