import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { addPrintRun, prepareEvent, saveEventInfo, saveExpense, saveItem, saveOwner, saveProductionCost } from './catalog';
import { confirmClosing } from './closing';
import { recordSale } from './record';
import { createCircle } from './setup';
import { loadYearSummary, yearCsv, yearsWithData } from './yearly';

describe('確定申告用の年間の集計(Issue #38)', () => {
  it('その年のイベントの売上・受託手数料・経費と、その年に刷った印刷費・制作費を足す', async () => {
    const db = freshDb('yearly');
    const ctx = await createCircle(db, 'テスト');
    const self = (await db.owners.filter((o) => o.is_self).first())!;
    const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
    const friend = await saveOwner(db, ctx, { name: '友だち', feeRate: 0.1 });
    const a = await saveItem(db, ctx, { name: '新刊A', kind: 'book', price: 1000, ownerId: self.id, lowThreshold: 3 });
    const b = await saveItem(db, ctx, { name: '既刊B', kind: 'book', price: 500, ownerId: self.id, lowThreshold: 3 });
    const f = await saveItem(db, ctx, { name: '友だちの本', kind: 'book', price: 600, ownerId: friend.id, lowThreshold: 3 });
    await addPrintRun(db, ctx, { itemId: b.id, qty: 50, totalCost: 15000, printedOn: '2025-06-01', toLocationId: home.id });
    await addPrintRun(db, ctx, { itemId: a.id, qty: 100, totalCost: 40000, printedOn: '2026-02-10', toLocationId: home.id });
    await addPrintRun(db, ctx, { itemId: b.id, qty: 30, totalCost: 9000, printedOn: null, toLocationId: home.id });
    await saveProductionCost(db, ctx, a.id, 20000);

    const ev = async (name: string, date: string, sales: [string, number, 'cash' | 'qr'][]) => {
      const e = await saveEventInfo(db, ctx, { name, heldOn: date });
      await prepareEvent(db, ctx, e.id, [
        { itemId: a.id, included: true, bring: 20, priceOverride: null },
        { itemId: b.id, included: true, bring: 20, priceOverride: null },
        { itemId: f.id, included: true, bring: 10, priceOverride: null },
      ], { storageId: home.id });
      for (const [id, qty, pm] of sales) await recordSale(db, ctx, { eventId: e.id, lines: [{ itemId: id, qty }], paymentMethod: pm });
      await saveExpense(db, ctx, { eventId: e.id, category: 'booth_fee', planned: 8000, actual: null });
      await saveExpense(db, ctx, { eventId: e.id, category: 'transport', planned: null, actual: 2000 });
      await confirmClosing(db, ctx, e.id, { returnLocationId: home.id });
    };
    await ev('去年のイベント', '2025-11-03', [[b.id, 4, 'cash']]);
    await ev('春', '2026-03-15', [[a.id, 10, 'cash'], [f.id, 5, 'cash']]);
    await ev('秋', '2026-11-01', [[a.id, 5, 'qr'], [b.id, 2, 'cash']]);

    expect(await yearsWithData(db, ctx.circleId)).toEqual(expect.arrayContaining([2026, 2025]));
    const y = await loadYearSummary(db, ctx.circleId, 2026);
    expect(y.events.map((e) => e.name)).toEqual(['春', '秋']);
    expect(y.totals.own).toBe(10000 + 5000 + 1000);
    expect(y.totals.consigned).toBe(3000);
    expect(y.totals.fee).toBe(300);
    expect(y.totals.cashless).toBe(5000);
    expect(y.totals.expenses).toBe(2 * (8000 + 2000));
    expect(y.expensesByCategory.map((c) => [c.label, c.amount])).toEqual([['出展費', 16000], ['交通費', 4000]]);
    // 印刷費は2026年に刷った新刊Aの分だけ。制作費は新刊Aの初版(2026年)の分
    expect(y.totals.printing).toBe(40000);
    expect(y.totals.production).toBe(20000);
    expect(y.undated.printRuns).toHaveLength(1);
    // 売れた分の原価: 新刊A 15部 × 400円 + 既刊B 2部 × (24000÷80=300円)
    expect(y.totals.cost).toBe(15 * 400 + 2 * 300);
    expect(y.net.byPrinting).toBe(16000 + 300 - 20000 - 40000 - 20000);
    expect(y.net.byCost).toBe(16000 + 300 - 20000 - 6600);
    expect(y.months[2].own).toBe(10000);
    expect(y.months[10].own).toBe(6000);

    const csv = yearCsv(y);
    expect(csv).toContain('自分の分の売上');
    expect(csv).toContain('刷った日がない');
  });
});
