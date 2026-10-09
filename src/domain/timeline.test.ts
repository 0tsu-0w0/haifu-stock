import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { editionsOf, itemBreakEven, loadAnalysis } from './analysis';
import { addPrintRun, prepareEvent, saveEventInfo, saveExpense, saveItem, saveOwner } from './catalog';
import { recordSale, voidTransaction, type Ctx } from './record';
import { deviceBreakdown, profitTimeline } from './report';
import { createCircle } from './setup';
import { loadEventSnapshot } from './snapshot';

const at = (hhmm: string) => () => new Date(`2026-05-01T${hhmm}:00+09:00`);

async function setup() {
  const db = freshDb('timeline');
  const ctx = await createCircle(db, 'テスト');
  const self = (await db.owners.filter((o) => o.is_self).first())!;
  const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
  const a = await saveItem(db, ctx, { name: '新刊A', kind: 'book', price: 800, ownerId: self.id, lowThreshold: 3 });
  const friend = await saveOwner(db, ctx, { name: 'サークルB', feeRate: 0.1 });
  const fb = await saveItem(db, ctx, { name: '友人の本', kind: 'book', price: 600, ownerId: friend.id, lowThreshold: 3 });
  // 1部あたりの原価 400円
  await addPrintRun(db, ctx, { itemId: a.id, qty: 50, totalCost: 20000, printedOn: null, toLocationId: home.id });
  const ev = await saveEventInfo(db, ctx, { name: 'コミティア', heldOn: '2026-05-01', startsAt: '2026-05-01T11:00:00+09:00' });
  await prepareEvent(db, ctx, ev.id, [
    { itemId: a.id, included: true, bring: 10, priceOverride: null },
    { itemId: fb.id, included: true, bring: 5, priceOverride: null },
  ], { storageId: home.id });
  await saveExpense(db, ctx, { eventId: ev.id, category: 'booth_fee', planned: 1000, actual: null });
  return { db, ctx, a, fb, ev, home, self };
}

describe('当日の時刻ごとの収支(F-1104)', () => {
  it('経費のぶんマイナスから始まり、自分の分は売上 − 原価、受託分は手数料だけ増える。0 を超えた時刻を黒字化とする', async () => {
    const { db, ctx, a, fb, ev } = await setup();
    const c = (t: string): Ctx => ({ ...ctx, now: at(t) });
    await recordSale(db, c('11:05'), { eventId: ev.id, lines: [{ itemId: a.id, qty: 2 }] });
    await recordSale(db, c('11:20'), { eventId: ev.id, lines: [{ itemId: fb.id, qty: 1 }] });
    await recordSale(db, c('12:10'), { eventId: ev.id, lines: [{ itemId: a.id, qty: 1 }] });
    const pt = profitTimeline((await loadEventSnapshot(db, ev.id))!);
    expect(pt.fixed).toBe(1000);
    expect(pt.points.map((p) => p.value)).toEqual([-1000, -200, -140, 260]);
    expect(pt.points[0].at).toBe(new Date('2026-05-01T11:00:00+09:00').toISOString());
    expect(pt.blackAt).toBe(at('12:10')().toISOString());
    expect(pt.current).toBe(260);
  });
});

describe('端末ごとの内訳(F-710)', () => {
  it('販売・部数・売上を端末ごとに出し、取り消された販売は数えない', async () => {
    const { db, ctx, a, fb, ev } = await setup();
    const staff: Ctx = { ...ctx, deviceId: 'staff-device' };
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a.id, qty: 2 }] });
    await recordSale(db, staff, { eventId: ev.id, lines: [{ itemId: fb.id, qty: 1 }] });
    const wrong = await recordSale(db, staff, { eventId: ev.id, lines: [{ itemId: a.id, qty: 1 }] });
    await voidTransaction(db, staff, wrong.id);
    const rows = deviceBreakdown((await loadEventSnapshot(db, ev.id))!);
    expect(rows.map((r) => [r.deviceId, r.sales, r.qty, r.amount, r.voids])).toEqual([
      [ctx.deviceId, 1, 2, 1600, 0],
      ['staff-device', 1, 1, 600, 1],
    ]);
  });
});

describe('版ごとの損益分岐(F-1107)', () => {
  it('「その版だけ」は、その版の印刷費(制作費は初版だけ)と、古い版から売れた順に数えた販売で出す', async () => {
    const db = freshDb('edition');
    const ctx = await createCircle(db, 'テスト');
    const self = (await db.owners.filter((o) => o.is_self).first())!;
    const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
    const b = await saveItem(db, ctx, { name: '既刊B', kind: 'book', price: 500, ownerId: self.id, lowThreshold: 3 });
    await addPrintRun(db, ctx, { itemId: b.id, qty: 20, totalCost: 10000, printedOn: null, toLocationId: home.id });
    await addPrintRun(db, ctx, { itemId: b.id, qty: 10, totalCost: 4000, printedOn: null, toLocationId: home.id });
    await db.production_costs.put({ id: 'pc-1', circle_id: ctx.circleId, item_id: b.id, amount: 3000 });
    const ev = await saveEventInfo(db, ctx, { name: 'イベント', heldOn: '2026-05-01' });
    await prepareEvent(db, ctx, ev.id, [{ itemId: b.id, included: true, bring: 25, priceOverride: null }], { storageId: home.id });
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: b.id, qty: 25 }] });

    const data = await loadAnalysis(db, ctx.circleId);
    const item = (await db.items.get(b.id))!;
    expect(editionsOf(data, b.id)).toEqual([1, 2]);
    const all = itemBreakEven(data, item);
    expect([all.fixedCost, all.printed, all.soldQty, all.breakEvenQty]).toEqual([17000, 30, 25, 34]);
    const first = itemBreakEven(data, item, 1);
    expect([first.fixedCost, first.printed, first.soldQty, first.breakEvenQty]).toEqual([13000, 20, 20, 26]);
    const second = itemBreakEven(data, item, 2);
    expect([second.fixedCost, second.printed, second.soldQty, second.soldAmount, second.remainingAmount, second.breakEvenQty])
      .toEqual([4000, 10, 5, 2500, 1500, 8]);
  });
});
