import { describe, expect, it } from 'vitest';
import type { Txn, TxnLine } from '../db/types';
import { DEFAULT_PAY, floatSuggestion, payStats } from './float';

describe('釣り銭の目安(F-306)', () => {
  it('700円の本が多いと、100円玉が多めに要る', () => {
    const s700 = floatSuggestion([{ price: 700, qty: 60 }], null)!;
    const s500 = floatSuggestion([{ price: 500, qty: 60 }], null)!;
    expect(s700.counts.get(100)!).toBeGreaterThan(s500.counts.get(100) ?? 0);
    expect(s500.counts.get(500)!).toBeGreaterThan(0);
    expect(s700.buyers).toBe(40);
    expect(s700.fromHistory).toBe(false);
    expect(s700.exactShare).toBe(DEFAULT_PAY.exactShare);
  });

  it('1万円札で払う人の分の千円札・5千円札も見込み、硬貨は5枚単位にそろえる', () => {
    const s = floatSuggestion([{ price: 800, qty: 30 }, { price: 1500, qty: 10 }], null)!;
    expect(s.counts.get(1000)!).toBeGreaterThan(0);
    expect(s.counts.get(5000)!).toBeGreaterThan(0);
    for (const [d, n] of s.counts) if (d < 1000) expect(n % 5).toBe(0);
    expect(s.total).toBe([...s.counts].reduce((a, [d, n]) => a + d * n, 0));
  });

  it('持ち込む部数がなければ出さない', () => {
    expect(floatSuggestion([{ price: 500, qty: 0 }], null)).toBeNull();
  });

  it('過去の預かり金額から、ちょうど払う人と1万円札の割合を出す(10件未満なら出さない)', () => {
    const txns: Txn[] = [];
    const lines: TxnLine[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `t${i}`;
      txns.push({ id, type: 'sale', paid_amount: i < 4 ? 700 : i < 6 ? 10000 : 1000 } as Txn);
      lines.push({ id: `l${i}`, transaction_id: id, qty: 1, unit_price: 700, discount: 0 } as TxnLine);
    }
    expect(payStats(txns, lines)).toEqual({ exactShare: 0.4, bigBillShare: 0.2, samples: 10 });
    expect(payStats(txns.slice(0, 9), lines)).toBeNull();
  });
});
