import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import {
  DEFAULT_FORECAST, decayRates, defaultCurve, eventBreakEven, itemBreakEven, loadAnalysis, newBookPlan, reprintPlans,
} from './analysis';
import { addPrintRun, prepareEvent, saveEventInfo, saveItem } from './catalog';
import { confirmClosing } from './closing';
import { recordSale } from './record';
import { createCircle } from './setup';

/** 11:00 開始・5時間のイベント。at は開始からの分 */
async function setup() {
  const db = freshDb('analysis');
  const ctx = await createCircle(db, 'テスト');
  const self = (await db.owners.filter((o) => o.is_self).first())!;
  const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
  const a = await saveItem(db, ctx, { name: '新刊A', kind: 'book', price: 800, ownerId: self.id, lowThreshold: 3 });
  const b = await saveItem(db, ctx, { name: '既刊B', kind: 'book', price: 500, ownerId: self.id, lowThreshold: 3 });
  await addPrintRun(db, ctx, { itemId: a.id, qty: 100, totalCost: 40000, printedOn: null, toLocationId: home.id });
  await addPrintRun(db, ctx, { itemId: b.id, qty: 60, totalCost: 18000, printedOn: null, toLocationId: home.id });

  async function event(name: string, date: string, bring: { a: number; b: number }, sales: { item: 'a' | 'b'; at: number; qty: number }[]) {
    const ev = await saveEventInfo(db, ctx, { name, heldOn: date, startsAt: new Date(`${date}T11:00:00+09:00`).toISOString() });
    await prepareEvent(db, ctx, ev.id, [
      { itemId: a.id, included: true, bring: bring.a, priceOverride: null },
      { itemId: b.id, included: true, bring: bring.b, priceOverride: null },
    ], { storageId: home.id });
    for (const s of sales) {
      const at = new Date(Date.parse(`${date}T11:00:00+09:00`) + s.at * 60_000);
      await recordSale(db, { ...ctx, now: () => at }, { eventId: ev.id, lines: [{ itemId: (s.item === 'a' ? a : b).id, qty: s.qty }] });
    }
    await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });
    return ev;
  }
  return { db, ctx, home, a, b, event };
}

describe('需要の推定', () => {
  it('完売しなかったら販売数が需要。完売したら、完売した時刻で補正する(上限は販売数の2倍)', async () => {
    const { db, ctx, a, b, event } = await setup();
    // 新刊Aは30部を開始60分(開催時間の2割)で完売。既刊Bは20部中12部
    await event('イベント1', '2026-05-01', { a: 30, b: 20 }, [
      { item: 'a', at: 10, qty: 20 }, { item: 'a', at: 60, qty: 10 },
      { item: 'b', at: 30, qty: 6 }, { item: 'b', at: 200, qty: 6 },
    ]);
    const data = await loadAnalysis(db, ctx.circleId);
    expect(data.curveSource).toBe('default');
    const oa = data.histories.get(a.id)!.observations[0];
    expect(oa.soldOutFraction).toBeCloseTo(0.2);
    expect(oa.demand).toBeCloseTo(Math.min(30 / defaultCurve(0.2), 60), 0); // 30 ÷ 0.36 ≒ 83 → 上限60
    expect(oa.demand).toBe(60);
    expect(oa.corrected).toBe(true);
    expect(data.histories.get(b.id)!.observations[0]).toMatchObject({ sold: 12, demand: 12, corrected: false });
  });

  it('既刊の減衰率は、続けて出したときの需要の比から求める', async () => {
    const { db, ctx, a, b, event } = await setup();
    await event('イベント1', '2026-05-01', { a: 40, b: 20 }, [{ item: 'a', at: 30, qty: 20 }, { item: 'b', at: 30, qty: 10 }]);
    await event('イベント2', '2026-08-01', { a: 40, b: 20 }, [{ item: 'a', at: 30, qty: 10 }, { item: 'b', at: 30, qty: 6 }]);
    const data = await loadAnalysis(db, ctx.circleId);
    const r = decayRates(data, DEFAULT_FORECAST);
    expect(r.samples).toBe(2);
    expect(r.standard).toBeCloseTo((0.5 + 0.6) / 2);
    expect(data.histories.get(a.id)!.observations.map((o) => o.demand)).toEqual([20, 10]);
    expect(data.histories.get(b.id)!.observations).toHaveLength(2);
  });
});

describe('刷り部数の目安', () => {
  it('予定イベントの予測需要の合計 × (1 + 安全率) − 在庫 を、印刷所の部数の刻みに切り上げる', async () => {
    const { db, ctx, a, b, event } = await setup();
    await event('イベント1', '2026-05-01', { a: 40, b: 20 }, [{ item: 'a', at: 30, qty: 20 }, { item: 'b', at: 30, qty: 10 }]);
    await event('イベント2', '2026-08-01', { a: 40, b: 20 }, [{ item: 'a', at: 30, qty: 10 }, { item: 'b', at: 30, qty: 6 }]);
    await saveItem(db, ctx, { id: a.id, name: '新刊A', kind: 'book', price: 800, ownerId: a.owner_id, lowThreshold: 3, printLot: 50 });
    const data = await loadAnalysis(db, ctx.circleId);
    const opts = { ...DEFAULT_FORECAST, plannedEvents: 2, safety: 0 };
    const plan = reprintPlans(data, opts).find((p) => p.item.id === a.id)!;
    // 自宅の在庫: 100 − 20 − 10 = 70。標準の減衰率 0.55、直近の需要 10 → 5.5 + 3.0 ≒ 9
    expect(plan.stock).toBe(70);
    const std = plan.scenarios.find((s) => s.key === 'standard')!;
    expect(std.perEvent).toEqual([5.5, 3]);
    expect(std.print).toBe(0); // 在庫で足りる
    expect(plan.reference).toBe(false);

    const big = reprintPlans(data, { ...opts, reserve: 100 }).find((p) => p.item.id === a.id)!;
    // 必要 8.5 + 100 = 108.5 → 109 − 70 = 39 → 50部単位に切り上げ
    expect(big.scenarios.find((s) => s.key === 'standard')!.print).toBe(50);
    expect(big.scenarios.find((s) => s.key === 'standard')!.leftover).toBe(Math.round(70 + 50 - 108.5));
    void b;
  });

  it('実績が1回だけの品目は「参考値」になる。新刊の目安は直近の新刊の初回の需要から出す', async () => {
    const { db, ctx, a, event } = await setup();
    await event('イベント1', '2026-05-01', { a: 40, b: 20 }, [{ item: 'a', at: 30, qty: 24 }, { item: 'b', at: 30, qty: 8 }]);
    const data = await loadAnalysis(db, ctx.circleId);
    expect(reprintPlans(data, DEFAULT_FORECAST).find((p) => p.item.id === a.id)!.reference).toBe(true);
    const nb = newBookPlan(data, { ...DEFAULT_FORECAST, plannedEvents: 1, safety: 0, expectation: 1 })!;
    expect(nb.basis.map((x) => x.demand).sort()).toEqual([24, 8].sort());
    // 同じイベントが初回の2冊: 3:2 の加重平均
    const std = nb.scenarios.find((s) => s.key === 'standard')!;
    expect([Math.round((24 * 3 + 8 * 2) / 5), Math.round((8 * 3 + 24 * 2) / 5)]).toContain(std.firstEvent);
    expect(std.print % 10).toBe(0);
    expect(nb.scenarios.find((s) => s.key === 'conservative')!.firstEvent).toBe(8);
  });
});

describe('損益分岐', () => {
  it('頒布物別: 固定費 ÷ 1部あたりの売上。累計の販売との差で、あと何円かを出す', async () => {
    const { db, ctx, a, event } = await setup();
    await event('イベント1', '2026-05-01', { a: 40, b: 0 }, [{ item: 'a', at: 30, qty: 30 }]);
    const data = await loadAnalysis(db, ctx.circleId);
    const be = itemBreakEven(data, a);
    expect(be).toMatchObject({ fixedCost: 40000, printed: 100, breakEvenQty: 50, soldQty: 30, soldAmount: 24000, remainingAmount: 16000, cannotRecover: false });
  });

  it('イベント別: (経費 − 受託手数料) ÷ 粗利率。売上がないときは前回の粗利率を使う', () => {
    const be = eventBreakEven({ own: 20000, fee: 200, expenses: 8200, cost: 5000, profit: 7000 }, null);
    expect(be.margin).toBeCloseTo(0.75);
    expect(be.breakEvenSales).toBe(Math.ceil(8000 / 0.75));
    const before = eventBreakEven({ own: 0, fee: 0, expenses: 9000, cost: 0, profit: -9000 }, 0.6);
    expect(before).toMatchObject({ marginSource: 'previous', breakEvenSales: 15000 });
    expect(eventBreakEven({ own: 0, fee: 0, expenses: 9000, cost: 0, profit: -9000 }, null).breakEvenSales).toBeNull();
  });
});
