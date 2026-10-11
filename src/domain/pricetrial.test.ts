import { describe, expect, it } from 'vitest';
import { priceRange, priceTrial, type ItemBreakEven } from './analysis';

const be = (over: Partial<ItemBreakEven> = {}): ItemBreakEven => ({
  item: { id: 'i', price: 800 } as ItemBreakEven['item'],
  fixedCost: 30000, printed: 50, breakEvenQty: 38, soldQty: 20, soldAmount: 16000, unitRevenue: 800,
  remainingAmount: 14000, cannotRecover: false, ...over,
});

describe('価格を変えたときの試算(F-1106)', () => {
  it('損益分岐部数と、回収までに残り何部かを、その価格で出し直す', () => {
    const t = priceTrial(be(), 1000);
    expect(t.breakEvenQty).toBe(30);
    expect(t.remainingQty).toBe(14); // 残り14,000円 ÷ 1,000円
    expect(t.allSoldProfit).toBe(16000 + 30 * 1000 - 30000);
  });

  it('値下げすると回収に必要な部数が増え、刷った分では足りなくなることもある', () => {
    const t = priceTrial(be(), 400);
    expect(t.breakEvenQty).toBe(75);
    expect(t.remainingQty).toBe(35);
    expect(t.allSoldProfit).toBeLessThan(0);
  });

  it('回収済みなら残りは0部。価格0では部数を出さない', () => {
    expect(priceTrial(be({ remainingAmount: 0, soldAmount: 31000 }), 800).remainingQty).toBe(0);
    expect(priceTrial(be(), 0)).toMatchObject({ breakEvenQty: null, remainingQty: null });
  });

  it('スライダーは定価の半分〜2倍を、きりのよい刻みで動く', () => {
    expect(priceRange(800)).toEqual({ min: 400, max: 1600, step: 50 });
    expect(priceRange(1500)).toEqual({ min: 700, max: 3000, step: 100 });
    expect(priceRange(200)).toEqual({ min: 100, max: 400, step: 10 });
  });
});
