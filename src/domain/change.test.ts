import { describe, expect, it } from 'vitest';
import { changeBreakdown, paidSuggestions } from './change';

describe('お釣りの計算', () => {
  it('お釣りを、大きいお札・硬貨から順に何枚ずつ渡すかに分ける', () => {
    expect(changeBreakdown(700)).toEqual([{ denom: 500, count: 1 }, { denom: 100, count: 2 }]);
    expect(changeBreakdown(8650)).toEqual([
      { denom: 5000, count: 1 }, { denom: 1000, count: 3 }, { denom: 500, count: 1 }, { denom: 100, count: 1 }, { denom: 50, count: 1 },
    ]);
    expect(changeBreakdown(0)).toEqual([]);
    expect(changeBreakdown(-100)).toEqual([]);
  });

  it('合計より大きい、ありそうな預かり金額を小さい順に3つまで出す', () => {
    expect(paidSuggestions(1300)).toEqual([1500, 2000, 5000]);
    expect(paidSuggestions(800)).toEqual([1000, 5000, 10000]);
    expect(paidSuggestions(1000)).toEqual([5000, 10000]); // ちょうどは「ちょうど」ボタンで
    expect(paidSuggestions(5300)).toEqual([5500, 6000, 10000]);
    expect(paidSuggestions(12000)).toEqual([15000, 20000]);
  });
});
