import { describe, expect, it } from 'vitest';
import { simulate, tierCost } from './simulation';

const TIERS = [{ qty: 50, total_cost: 18000 }, { qty: 100, total_cost: 24000 }, { qty: 200, total_cost: 33000 }];

describe('印刷所の価格表(F-108)', () => {
  it('間の部数は前後の値から直線で補間する', () => {
    expect(tierCost(TIERS, 50)).toBe(18000);
    expect(tierCost(TIERS, 75)).toBe(21000);
    expect(tierCost(TIERS, 150)).toBe(28500);
  });

  it('いちばん少ない部数より少なくても、その値段はかかる。いちばん多い部数より上は最後の傾きで延ばす', () => {
    expect(tierCost(TIERS, 10)).toBe(18000);
    expect(tierCost(TIERS, 300)).toBe(42000);
    expect(tierCost([{ qty: 100, total_cost: 20000 }], 150)).toBe(30000);
    expect(tierCost([], 10)).toBeNull();
  });
});

describe('刷り部数のシミュレーション(F-1105)', () => {
  const sim = simulate({
    tiers: TIERS, price: 500, fixed: 0, lot: 10,
    demands: [{ key: 'conservative', demand: 60 }, { key: 'standard', demand: 120 }, { key: 'aggressive', demand: 180 }],
  })!;

  it('利益 = 価格 × min(刷り部数, 需要) − 印刷費 − 制作費', () => {
    const std = sim.lines.find((l) => l.key === 'standard')!;
    expect(std.profit(100)).toBe(500 * 100 - 24000);
    expect(std.profit(200)).toBe(500 * 120 - 33000);
  });

  it('標準案で利益が最大になる部数は、需要ちょうどのあたり', () => {
    // 100→120部: 売上 +10,000、印刷費 +1,800 なので増やすほど得。120部より上は売れないので損
    expect(sim.best).toEqual({ q: 120, profit: 500 * 120 - (24000 + 90 * 20) });
  });

  it('3案のどれかで赤字になる範囲を、続いている範囲にまとめて出す', () => {
    // 控えめ(60部): 10〜30部は印刷費18,000円に届かない。多く刷りすぎると控えめ案で赤字
    expect(sim.lossRanges[0]).toEqual([10, 30]);
    const last = sim.lossRanges[sim.lossRanges.length - 1];
    expect(last[1]).toBe(sim.xMax - (sim.xMax % 10));
    expect(sim.step).toBe(10);
  });

  it('価格表がなければ出さない', () => {
    expect(simulate({ tiers: [], price: 500, fixed: 0, lot: null, demands: [{ key: 'standard', demand: 10 }] })).toBeNull();
  });
});
