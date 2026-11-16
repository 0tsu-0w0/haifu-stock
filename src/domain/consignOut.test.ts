import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { addPrintRun, saveItem } from './catalog';
import {
  consignAnalysis, consigneeState, recordConsignReport, returnFromConsignee, saveConsignee, sendToConsignee,
  setConsigneeArchived, setConsignReportVoided,
} from './consignOut';
import { storageStock } from './stock';
import { createCircle } from './setup';

async function setup() {
  const db = freshDb('consign-out');
  const ctx = await createCircle(db, 'テストサークル');
  const self = (await db.owners.filter((o) => o.is_self).first())!;
  const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
  const a = await saveItem(db, ctx, { name: '新刊A', kind: 'book', price: 800, ownerId: self.id, lowThreshold: 3 });
  const b = await saveItem(db, ctx, { name: '既刊B', kind: 'book', price: 500, ownerId: self.id, lowThreshold: 3 });
  await addPrintRun(db, ctx, { itemId: a.id, qty: 50, totalCost: 30000, printedOn: '2026-10-01', toLocationId: home.id });
  const shop = await saveConsignee(db, ctx, { name: '書店X', feeRate: 0.3 });
  return { db, ctx, home, a, b, shop };
}

describe('委託に出す(F-601〜603)', () => {
  it('預けると自宅から委託先へ動き、報告で売れた分だけ委託先の残りが減る', async () => {
    const { db, ctx, home, a, shop } = await setup();
    await sendToConsignee(db, ctx, { to: shop.id, from: home.id, lines: [{ itemId: a.id, qty: 10 }] });
    expect((await storageStock(db, ctx.circleId)).get(`${a.id}|${home.id}`)).toBe(40);

    const r = await recordConsignReport(db, ctx, { locationId: shop.id, reportedOn: '2026-11-30', lines: [{ itemId: a.id, qty: 4, unitPrice: 800 }] });
    expect(r.sales_amount).toBe(3200);
    expect(r.fee_amount).toBe(960); // 3,200 × 30%

    const s = (await consigneeState(db, ctx.circleId)).get(shop.id)!;
    expect([s.sent, s.sold, s.left, s.sales, s.fee, s.net]).toEqual([10, 4, 6, 3200, 960, 2240]);

    await returnFromConsignee(db, ctx, { from: shop.id, to: home.id, lines: [{ itemId: a.id, qty: 6 }] });
    const after = (await consigneeState(db, ctx.circleId)).get(shop.id)!;
    expect([after.returned, after.left]).toEqual([6, 0]);
    expect((await storageStock(db, ctx.circleId)).get(`${a.id}|${home.id}`)).toBe(46);
  });

  it('預けた数より多くは、売れた・返ってきたにできない', async () => {
    const { db, ctx, home, a, b, shop } = await setup();
    await sendToConsignee(db, ctx, { to: shop.id, from: home.id, lines: [{ itemId: a.id, qty: 3 }] });
    await expect(recordConsignReport(db, ctx, { locationId: shop.id, reportedOn: '2026-11-30', lines: [{ itemId: a.id, qty: 4, unitPrice: 800 }] }))
      .rejects.toThrow('3部しか預けていません');
    await expect(recordConsignReport(db, ctx, { locationId: shop.id, reportedOn: '2026-11-30', lines: [{ itemId: b.id, qty: 1, unitPrice: 500 }] }))
      .rejects.toThrow('0部しか預けていません');
    await expect(returnFromConsignee(db, ctx, { from: shop.id, to: home.id, lines: [{ itemId: a.id, qty: 4 }] }))
      .rejects.toThrow('3部しか残っていません');
  });

  it('手数料は直せる。報告を取り消すと、売れた分が委託先に戻る', async () => {
    const { db, ctx, home, a, shop } = await setup();
    await sendToConsignee(db, ctx, { to: shop.id, from: home.id, lines: [{ itemId: a.id, qty: 5 }] });
    const r = await recordConsignReport(db, ctx, { locationId: shop.id, reportedOn: '2026-11-30', lines: [{ itemId: a.id, qty: 2, unitPrice: 900 }], fee: 500 });
    expect(r.fee_amount).toBe(500);
    await expect(recordConsignReport(db, ctx, { locationId: shop.id, reportedOn: '2026-11-30', lines: [{ itemId: a.id, qty: 1, unitPrice: 100 }], fee: 200 }))
      .rejects.toThrow('手数料が売上より多く');
    await setConsignReportVoided(db, r.id, true);
    expect((await consigneeState(db, ctx.circleId)).get(shop.id)!.left).toBe(5);
    expect(await db.outbox.where('table').equals('consignment_reports').count()).toBeGreaterThan(0);
  });

  it('預けたままの委託先はしまえない', async () => {
    const { db, ctx, home, a, shop } = await setup();
    await sendToConsignee(db, ctx, { to: shop.id, from: home.id, lines: [{ itemId: a.id, qty: 1 }] });
    await expect(setConsigneeArchived(db, shop.id, true)).rejects.toThrow('1部預けたまま');
    await recordConsignReport(db, ctx, { locationId: shop.id, reportedOn: '2026-11-30', lines: [{ itemId: a.id, qty: 1, unitPrice: 800 }] });
    await setConsigneeArchived(db, shop.id, true);
    expect((await db.locations.get(shop.id))!.archived_at).not.toBeNull();
  });

  it('イベントの売上と委託の売上を分けて並べ、年で絞れる', async () => {
    const { db, ctx, home, a, shop } = await setup();
    await sendToConsignee(db, ctx, { to: shop.id, from: home.id, lines: [{ itemId: a.id, qty: 10 }] });
    await recordConsignReport(db, ctx, { locationId: shop.id, reportedOn: '2026-12-31', lines: [{ itemId: a.id, qty: 2, unitPrice: 800 }] });
    await recordConsignReport(db, ctx, { locationId: shop.id, reportedOn: '2027-01-31', lines: [{ itemId: a.id, qty: 3, unitPrice: 800 }] });
    const states = await consigneeState(db, ctx.circleId);
    const ev = new Map([[a.id, { qty: 20, sales: 16000 }]]);
    const all = consignAnalysis(states, [a], ev);
    expect(all.totals).toEqual({ eventSales: 16000, shopSales: 4000, shopFee: 1200, shopNet: 2800, shopLeft: 5 });
    expect(all.items[0]).toMatchObject({ eventQty: 20, shopQty: 5 });
    const y2026 = consignAnalysis(states, [a], ev, 2026);
    expect(y2026.shops[0]).toMatchObject({ sold: 2, sales: 1600, fee: 480 });
  });
});
