import type { ItemHistory } from './analysis';

// 頒布物の横断レポート(F-705)。品目ごとに、イベントをまたいだ販売の推移を並べる。
// イベントの長さが違っても比べられるよう、初回との比べは1日あたりの推定需要(完売補正つき)で出す

export interface TrendRow {
  eventId: string;
  eventName: string;
  heldOn: string;
  /** 何回目に出したか(1 = 初めて出したイベント) */
  nth: number;
  brought: number;
  sold: number;
  /** 推定需要(完売したときは補正して販売数より大きい) */
  demand: number;
  corrected: boolean;
  days: number;
  /** 消化率(販売 ÷ 持ち込み) */
  sellThrough: number;
  /** 1日あたりの推定需要が、初回の何倍か。初回の需要が0なら null */
  vsFirst: number | null;
}

const perDay = (demand: number, days: number) => demand / Math.max(1, days);

export function itemTrend(h: ItemHistory): TrendRow[] {
  const obs = h.observations;
  if (obs.length === 0) return [];
  const first = perDay(obs[0].demand, obs[0].days);
  return obs.map((o, i) => ({
    eventId: o.eventId, eventName: o.eventName, heldOn: o.heldOn, nth: i + 1,
    brought: o.brought, sold: o.sold, demand: o.demand, corrected: o.corrected, days: o.days,
    sellThrough: o.brought > 0 ? o.sold / o.brought : 0,
    vsFirst: first > 0 ? perDay(o.demand, o.days) / first : null,
  }));
}

export interface DecayPoint {
  /** 何回目か(2以上) */
  nth: number;
  /** 初回に対する比(中央値) */
  ratio: number;
  /** 材料にした品目の数 */
  samples: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * 新刊から既刊になったあとの落ち方を、品目をまたいでまとめる。
 * n 回目の1日あたりの需要 ÷ 初回の1日あたりの需要 の中央値を、n = 2〜maxNth で出す(材料がない回は出さない)
 */
export function decayByAppearance(histories: Iterable<ItemHistory>, maxNth = 6): DecayPoint[] {
  const byNth = new Map<number, number[]>();
  for (const h of histories) {
    for (const r of itemTrend(h)) {
      if (r.nth < 2 || r.nth > maxNth || r.vsFirst === null) continue;
      byNth.set(r.nth, [...(byNth.get(r.nth) ?? []), r.vsFirst]);
    }
  }
  return [...byNth.entries()]
    .sort(([a], [b]) => a - b)
    .map(([nth, xs]) => ({ nth, ratio: median(xs), samples: xs.length }));
}
