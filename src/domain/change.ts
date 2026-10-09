// お釣りの計算(レジのカート)。預かり金額の候補と、お釣りを何で渡すかの内訳

/** 渡すときに使うお札と硬貨(2千円札は使わない) */
export const CHANGE_DENOMS = [10000, 5000, 1000, 500, 100, 50, 10, 5, 1] as const;

/** お釣りを、大きいお札・硬貨から順に何枚ずつ渡すか */
export function changeBreakdown(amount: number): { denom: number; count: number }[] {
  const out: { denom: number; count: number }[] = [];
  let rest = Math.max(0, Math.round(amount));
  for (const d of CHANGE_DENOMS) {
    const count = Math.floor(rest / d);
    if (count > 0) {
      out.push({ denom: d, count });
      rest -= count * d;
    }
  }
  return out;
}

/**
 * 合計に対して、お客さんが出しそうな金額の候補(合計より大きいものだけ、小さい順に最大3つ)。
 * 例: 1,300円 → 1,500円・2,000円・5,000円 / 800円 → 1,000円・5,000円・10,000円
 */
export function paidSuggestions(total: number): number[] {
  if (total <= 0) return [1000, 5000, 10000];
  const up = (unit: number) => Math.ceil(total / unit) * unit;
  const cands = [up(500), up(1000), up(5000), 10000, up(10000)];
  return [...new Set(cands)].filter((v) => v > total).sort((a, b) => a - b).slice(0, 3);
}

export const denomLabel = (d: number) => `${d.toLocaleString('ja-JP')}円${d >= 1000 ? '札' : '玉'}`;
