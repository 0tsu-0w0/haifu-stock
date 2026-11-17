import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { DEFAULT_FORECAST, consignPaces, loadAnalysis, reprintPlans } from './analysis';
import { addPrintRun, prepareEvent, saveEventInfo, saveItem } from './catalog';
import { confirmClosing } from './closing';
import { consigneeState, recordConsignReport, saveConsignee, sendToConsignee, setConsignReportVoided } from './consignOut';
import { recordSale } from './record';
import { createCircle } from './setup';

// 再版の目安に委託を入れる(決定事項 #20)。委託の売れ方はイベントの需要と分けて数える

async function setup() {
  const db = freshDb('consign-forecast');
  const ctx = await createCircle(db, 'テスト');
  const self = (await db.owners.filter((o) => o.is_self).first())!;
  const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
  const a = await saveItem(db, ctx, { name: '既刊A', kind: 'book', price: 800, ownerId: self.id, lowThreshold: 3 });
  await addPrintRun(db, ctx, { itemId: a.id, qty: 100, totalCost: 30000, printedOn: null, toLocationId: home.id });
  // イベントで20部売れた実績
  const date = '2026-09-01';
  const ev = await saveEventInfo(db, ctx, { name: 'イベント', heldOn: date, startsAt: new Date(`${date}T11:00:00+09:00`).toISOString() });
  await prepareEvent(db, ctx, ev.id, [{ itemId: a.id, included: true, bring: 40, priceOverride: null }], { storageId: home.id });
  for (let i = 0; i < 20; i++) {
    const at = new Date(Date.parse(`${date}T11:00:00+09:00`) + i * 10 * 60_000);
    await recordSale(db, { ...ctx, now: () => at }, { eventId: ev.id, lines: [{ itemId: a.id, qty: 1 }] });
  }
  await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });
  const shop = await saveConsignee(db, ctx, { name: '書店X', feeRate: 0.3 });
  return { db, ctx, home, a, shop };
}

describe('再版の目安と委託', () => {
  it('直近1年の報告から1か月あたりの部数を出す。取り消した報告と1年より前の報告は数えない', async () => {
    const { db, ctx, home, a, shop } = await setup();
    await sendToConsignee(db, ctx, { to: shop.id, from: home.id, lines: [{ itemId: a.id, qty: 15 }] });
    await recordConsignReport(db, ctx, { locationId: shop.id, reportedOn: '2026-10-01', lines: [{ itemId: a.id, qty: 4, unitPrice: 800 }] });
    await recordConsignReport(db, ctx, { locationId: shop.id, reportedOn: '2025-01-01', lines: [{ itemId: a.id, qty: 9, unitPrice: 800 }] });
    const v = await recordConsignReport(db, ctx, { locationId: shop.id, reportedOn: '2026-11-01', lines: [{ itemId: a.id, qty: 2, unitPrice: 800 }] });
    await setConsignReportVoided(db, v.id, true);

    // 初めて預けたのは今日なので、期間は最短の1か月
    const today = new Date().toISOString().slice(0, 10);
    const p = consignPaces(await consigneeState(db, ctx.circleId), today).get(a.id)!;
    expect(p.sold).toBe(4);
    expect(p.months).toBe(1);
    expect(p.perMonth).toBe(4);
    // 預けた15 − 売れた(取り消しを除く 4 + 9)= 2
    expect(p.left).toBe(2);
  });

  it('委託の見込みのうち、委託先にある分で足りない部数だけを必要な部数に足す。委託先の在庫は手元の在庫に入れない', async () => {
    const { db, ctx, home, a, shop } = await setup();
    await sendToConsignee(db, ctx, { to: shop.id, from: home.id, lines: [{ itemId: a.id, qty: 10 }] });
    await recordConsignReport(db, ctx, { locationId: shop.id, reportedOn: new Date().toISOString().slice(0, 10), lines: [{ itemId: a.id, qty: 6, unitPrice: 800 }] });

    const data = await loadAnalysis(db, ctx.circleId);
    const off = reprintPlans(data, { ...DEFAULT_FORECAST, consignMonths: 0 }).find((x) => x.item.id === a.id)!;
    const on = reprintPlans(data, { ...DEFAULT_FORECAST, consignMonths: 6 }).find((x) => x.item.id === a.id)!;
    expect(off.consign).toBeNull();
    // 1か月あたり6部 × 6か月 = 36部。委託先に4部あるので、足りないのは32部
    expect(on.consign).toMatchObject({ months: 6, expected: 36, short: 32 });
    expect(on.stock).toBe(off.stock);
    for (let i = 0; i < 3; i++) expect(on.scenarios[i].need).toBe(off.scenarios[i].need + 32);
  });

  it('委託したことのない品目は、いままでどおり', async () => {
    const { db, ctx, a } = await setup();
    const data = await loadAnalysis(db, ctx.circleId);
    expect(data.consign.size).toBe(0);
    expect(reprintPlans(data, DEFAULT_FORECAST).find((x) => x.item.id === a.id)!.consign).toBeNull();
  });
});
