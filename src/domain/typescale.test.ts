import { describe, expect, it } from 'vitest';
import type { EventRow, Item } from '../db/types';
import { DEFAULT_FORECAST, newBookPlan, reprintPlans, type AnalysisData, type Observation } from './analysis';
import { bringHints, typeScales } from './bring';

// 種別の補正(要件 §6.2)。大規模(BIG)はオンリー(ONLY)の2倍売れるサークルを想定する

const ev = (id: string, heldOn: string, type: string | null) => ({ id, name: id, held_on: heldOn, event_type_id: type } as EventRow);
const ob = (eventId: string, heldOn: string, demand: number): Observation => ({
  eventId, eventName: eventId, heldOn, brought: demand + 10, sold: demand, demand, days: 1,
  soldOutAt: null, soldOutFraction: null, corrected: false,
});

function data(): AnalysisData {
  const a = { id: 'a', name: '既刊A', kind: 'book' } as Item;
  const b = { id: 'b', name: '既刊B', kind: 'book' } as Item;
  const events = [ev('big1', '2026-01-01', 'BIG'), ev('only1', '2026-02-01', 'ONLY'), ev('big2', '2026-03-01', 'BIG'), ev('only2', '2026-04-01', 'ONLY')];
  return {
    events, upcoming: [], items: [a, b], ownItems: [a, b],
    histories: new Map([
      ['a', { item: a, observations: [ob('big1', '2026-01-01', 40), ob('only1', '2026-02-01', 20), ob('big2', '2026-03-01', 40), ob('only2', '2026-04-01', 20)] }],
      // B はオンリーにしか出していない
      ['b', { item: b, observations: [ob('only1', '2026-02-01', 10), ob('only2', '2026-04-01', 10)] }],
    ]),
    storageStock: new Map(), printRuns: [], productionCosts: new Map(), soldTotals: new Map(), soldByYear: new Map(),
    curve: (t) => t, curveSource: 'default', curveSamples: 0,
  };
}

describe('イベント種別の補正(§6.2)', () => {
  it('種別ごとの規模は、終わったイベントの1日あたりの需要の合計を平均する', () => {
    const s = typeScales(data());
    expect(s.get('BIG')).toEqual({ perDay: 40, events: 2 });
    expect(s.get('ONLY')).toEqual({ perDay: 30, events: 2 });
  });

  it('同じ種別の実績があれば、それを優先する', () => {
    const d = data();
    const plain = bringHints(d, undefined, DEFAULT_FORECAST).get('a')!;
    const big = bringHints(d, undefined, DEFAULT_FORECAST, undefined, 1, 'BIG').get('a')!;
    expect(plain.basis).toContain('前回「only2」');
    expect(big.basis).toContain('同じ種別の前回「big2」');
    expect(big.expected).toBe(plain.expected * 2);
  });

  it('同じ種別の実績がなければ、種別の規模の比を掛ける', () => {
    const d = data();
    const plain = bringHints(d, undefined, DEFAULT_FORECAST).get('b')!;
    const big = bringHints(d, undefined, DEFAULT_FORECAST, undefined, 1, 'BIG').get('b')!;
    expect(big.basis).toContain('×1.33');
    expect(big.expected).toBe(Math.round(plain.expected * 40 / 30));
  });

  it('刷り部数の目安は、登録してあるこれからのイベントの日数と種別に合わせる。登録していない回は直近と同じ規模', () => {
    const d = data();
    const opts = { ...DEFAULT_FORECAST, plannedEvents: 2 };
    const plain = reprintPlans(d, opts).find((p) => p.item.id === 'b')!;
    d.upcoming = [{ ...ev('next', '2026-06-01', 'BIG'), days: 2 } as never];
    const plan = reprintPlans(d, opts).find((p) => p.item.id === 'b')!;
    const [s0, s1] = plain.scenarios[1].perEvent;
    // 1回目: 2日開催 × 種別の比 40/30。2回目は登録がないので変わらない
    expect(plan.scenarios[1].perEvent[0]).toBeCloseTo(s0 * 2 * (40 / 30), 1);
    expect(plan.scenarios[1].perEvent[1]).toBe(s1);
    expect(plan.planned.map((p) => [p.event?.id ?? null, p.days])).toEqual([['next', 2], [null, 1]]);
    expect(plan.planned[0].scale).toBeCloseTo(40 / 30);
  });

  it('次の新刊の目安は、登録してある次のイベントの日数と種別に、材料の需要をそろえる', () => {
    const d = data();
    // A の初回は big1(40)、B の初回は only1(10)。新しい順に B(重み3)・A(重み2)
    const plain = newBookPlan(d, DEFAULT_FORECAST)!;
    expect(plain.debut).toBeNull();
    expect(plain.basis.map((b) => b.adjusted)).toEqual([10, 40]);
    d.upcoming = [{ ...ev('next', '2026-06-01', 'BIG'), days: 2 } as never];
    const plan = newBookPlan(d, DEFAULT_FORECAST)!;
    expect(plan.debut?.id).toBe('next');
    // B: 10 × 2日 × 40/30 = 26.7、A: 40 × 2日 = 80
    expect(plan.basis.map((b) => b.adjusted)).toEqual([26.7, 80]);
    expect(plan.scenarios.find((s) => s.key === 'standard')!.firstEvent).toBe(Math.round((10 * 2 * (40 / 30) * 3 + 80 * 2) / 5));
    // 持ち込みの目安は、準備しているイベントを渡すので、次のイベントの登録には左右されない
    const c = { id: 'c', name: '新刊C', kind: 'book' } as Item;
    d.ownItems.push(c);
    expect(bringHints(d, undefined, DEFAULT_FORECAST).get('c')!.expected).toBe(plain.scenarios.find((s) => s.key === 'standard')!.firstEvent);
  });

  it('種別の材料が足りなければ補正しない', () => {
    const d = data();
    d.events.push(ev('new', '2026-05-01', 'NEW'));
    const plain = bringHints(d, undefined, DEFAULT_FORECAST).get('b')!;
    const hint = bringHints(d, undefined, DEFAULT_FORECAST, undefined, 1, 'NEW').get('b')!;
    expect(hint).toEqual(plain);
  });
});
