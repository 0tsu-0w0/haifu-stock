import { describe, expect, it } from 'vitest';
import type { EventRow, Item } from '../db/types';
import { DEFAULT_FORECAST, type AnalysisData, type Observation } from './analysis';
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
    events, items: [a, b], ownItems: [a, b],
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

  it('種別の材料が足りなければ補正しない', () => {
    const d = data();
    d.events.push(ev('new', '2026-05-01', 'NEW'));
    const plain = bringHints(d, undefined, DEFAULT_FORECAST).get('b')!;
    const hint = bringHints(d, undefined, DEFAULT_FORECAST, undefined, 1, 'NEW').get('b')!;
    expect(hint).toEqual(plain);
  });
});
