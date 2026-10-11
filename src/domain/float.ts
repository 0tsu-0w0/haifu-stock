import type { Txn, TxnLine } from '../db/types';
import { changeBreakdown } from './change';
import { activeTxnIds, lineAmount } from './ledger';

// 釣り銭の目安(F-306)。価格の構成と、過去の預かり金額(F-402)から、必要な硬貨・お札の枚数を見積もる。
// 例: 700円の本が多いと、1,000円札で払われるたびに100円玉が3枚要る

/** 1人あたりの平均の購入部数 */
const COPIES_PER_BUYER = 1.5;
/** 準備金から出す割合(残りは、ほかのお客さんから受け取ったお金をお釣りに回せると見る) */
const NEED_SHARE = 0.4;
/** 過去の記録がないときの、ちょうど払う人・1万円札で払う人の割合 */
export const DEFAULT_PAY = { exactShare: 0.3, bigBillShare: 0.08 };
const MIN_SAMPLES = 10;

export interface PayStats {
  /** ちょうど払った人の割合 */
  exactShare: number;
  /** 合計が1万円未満なのに1万円札以上で払った人の割合 */
  bigBillShare: number;
  samples: number;
}

/** 過去の販売の預かり金額から、払い方の割合を出す。預かり金額を入れた販売が少なければ null */
export function payStats(txns: Txn[], lines: TxnLine[]): PayStats | null {
  const active = activeTxnIds(txns);
  const totals = new Map<string, number>();
  for (const l of lines) totals.set(l.transaction_id, (totals.get(l.transaction_id) ?? 0) + lineAmount(l));
  const paid = txns.filter((t) => t.type === 'sale' && active.has(t.id) && t.paid_amount !== null && (totals.get(t.id) ?? 0) > 0);
  if (paid.length < MIN_SAMPLES) return null;
  const exact = paid.filter((t) => t.paid_amount === totals.get(t.id)).length;
  const big = paid.filter((t) => (totals.get(t.id) ?? 0) < 10000 && (t.paid_amount ?? 0) >= 10000).length;
  return { exactShare: exact / paid.length, bigBillShare: big / paid.length, samples: paid.length };
}

export interface FloatSuggestion {
  /** 金種 → 枚数(1万円札は含めない) */
  counts: Map<number, number>;
  total: number;
  buyers: number;
  exactShare: number;
  bigBillShare: number;
  fromHistory: boolean;
}

/** 持ち込む品目の価格と部数から、釣り銭の目安を出す */
export function floatSuggestion(lines: { price: number; qty: number }[], stats: PayStats | null): FloatSuggestion | null {
  const sold = lines.filter((l) => l.qty > 0 && l.price > 0);
  const copies = sold.reduce((a, l) => a + l.qty, 0);
  if (copies === 0) return null;
  const { exactShare, bigBillShare } = stats ?? DEFAULT_PAY;
  const buyers = Math.ceil(copies / COPIES_PER_BUYER);
  const need = new Map<number, number>();
  const add = (amount: number, weight: number) => {
    for (const { denom, count } of changeBreakdown(amount)) {
      if (denom >= 10000) continue;
      need.set(denom, (need.get(denom) ?? 0) + count * weight);
    }
  };
  for (const l of sold) {
    const w = l.qty / copies; // その品目を買う人の割合
    // 合計より大きい、いちばん小さいお札で払う人
    const bill = [1000, 5000, 10000].find((b) => b > l.price) ?? Math.ceil(l.price / 10000) * 10000 + 10000;
    add(bill - (l.price % bill), w * (1 - exactShare - bigBillShare));
    if (l.price < 10000) add(10000 - l.price, w * bigBillShare);
  }
  const counts = new Map<number, number>();
  for (const [d, n] of need) {
    const c = Math.ceil(n * buyers * NEED_SHARE);
    // 硬貨は5枚単位にそろえる(数えやすくする)
    const rounded = d < 1000 ? Math.ceil(c / 5) * 5 : c;
    if (rounded > 0) counts.set(d, rounded);
  }
  const total = [...counts].reduce((a, [d, n]) => a + d * n, 0);
  return { counts, total, buyers, exactShare, bigBillShare, fromHistory: !!stats };
}
