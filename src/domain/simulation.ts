import type { Item } from '../db/types';
import { newBookPlan, reprintPlans, type AnalysisData, type ForecastOptions, type ScenarioKey } from './analysis';

// 刷り部数のシミュレーション(F-1105)。印刷所の価格表(F-108)と需要予測の3案から、
// 刷り部数 q ごとの予想利益 π(q) = 価格 × min(q, 予測需要) − 印刷費(q) − 制作費 を出す

export interface Tier {
  qty: number;
  total_cost: number;
}

/**
 * 価格表から q 部の印刷費を出す。間の部数は前後の値から直線で補間する(要件 F-108)。
 * いちばん少ない部数より少なく刷っても、その部数の値段はかかるものとする。いちばん多い部数より上は、最後の区間の傾きで延ばす
 */
export function tierCost(tiers: Tier[], q: number): number | null {
  const t = [...tiers].sort((a, b) => a.qty - b.qty);
  if (t.length === 0) return null;
  if (q <= t[0].qty) return t[0].total_cost;
  for (let i = 1; i < t.length; i++) {
    if (q <= t[i].qty) {
      const a = t[i - 1], b = t[i];
      return a.total_cost + ((b.total_cost - a.total_cost) * (q - a.qty)) / (b.qty - a.qty);
    }
  }
  const last = t[t.length - 1];
  if (t.length === 1) return (last.total_cost / last.qty) * q; // 1つだけなら1部あたりの値段で延ばす
  const prev = t[t.length - 2];
  return last.total_cost + ((last.total_cost - prev.total_cost) * (q - last.qty)) / (last.qty - prev.qty);
}

export interface SimLine {
  key: ScenarioKey;
  /** その案で売れると見込む部数(刷った分のうち) */
  demand: number;
  profit: (q: number) => number;
}

export interface Simulation {
  lines: SimLine[];
  /** グラフの右端 */
  xMax: number;
  /** 線が折れる部数(価格表の部数と、各案の需要) */
  breaks: number[];
  /** 標準案で利益が最大になる部数(刻みに合わせる) */
  best: { q: number; profit: number } | null;
  /** 3案のどれかで赤字になる部数の範囲(刻みごとに調べ、続いている範囲にまとめる) */
  lossRanges: [number, number][];
  step: number;
}

export function simulate(input: {
  tiers: Tier[];
  price: number;
  /** 制作費(新刊のときだけ。再版では払い終えているので 0) */
  fixed: number;
  demands: { key: ScenarioKey; demand: number }[];
  lot: number | null;
}): Simulation | null {
  const { tiers, price, fixed, demands } = input;
  if (tiers.length === 0) return null;
  const cost = (q: number) => tierCost(tiers, q) ?? 0;
  const lines: SimLine[] = demands.map(({ key, demand }) => ({
    key, demand: Math.max(0, demand),
    profit: (q: number) => price * Math.min(q, Math.max(0, demand)) - cost(q) - fixed,
  }));
  const maxTier = Math.max(...tiers.map((t) => t.qty));
  const maxDemand = Math.max(0, ...lines.map((l) => l.demand));
  const xMax = Math.max(maxTier, Math.ceil(maxDemand * 1.3), 10);
  const step = Math.max(1, input.lot ?? 0, niceStep(xMax));
  const breaks = [...new Set([...tiers.map((t) => t.qty), ...lines.map((l) => l.demand)])].filter((x) => x > 0 && x < xMax).sort((a, b) => a - b);

  const qs: number[] = [];
  for (let q = step; q <= xMax; q += step) qs.push(q);
  const std = lines.find((l) => l.key === 'standard') ?? lines[0];
  let best: Simulation['best'] = null;
  for (const q of qs) {
    const p = std.profit(q);
    if (!best || p > best.profit) best = { q, profit: Math.round(p) };
  }
  const lossRanges: [number, number][] = [];
  for (const q of qs) {
    if (!lines.some((l) => l.profit(q) < 0)) continue;
    const last = lossRanges[lossRanges.length - 1];
    if (last && last[1] === q - step) last[1] = q;
    else lossRanges.push([q, q]);
  }
  return { lines, xMax, breaks, best, lossRanges, step };
}

/** 刻みの指定がないときに調べる部数の間隔(グラフの幅の 1/100 くらいを、きりのよい数にする) */
function niceStep(xMax: number): number {
  const raw = xMax / 100;
  if (raw <= 1) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
}

export interface ItemSimulation {
  /** reprint: 売った実績のある品目の再版。new: まだ売っていない本(新刊の目安を使う) */
  basis: 'reprint' | 'new';
  sim: Simulation;
  /** 自宅などの在庫(再版のときは、需要からこの分を引いて刷る分の需要にする) */
  stock: number;
  fixed: number;
  /** 需要を出した材料が少ない(参考値) */
  reference: boolean;
}

/**
 * 品目の刷り部数のシミュレーション。売った実績があれば再版の目安(在庫を引いた分)、
 * まだ売っていない本なら次の新刊の目安と制作費で計算する。どちらもなければ null
 */
export function simulateItem(data: AnalysisData, item: Item, tiers: Tier[], opts: ForecastOptions): ItemSimulation | null {
  const plan = reprintPlans(data, opts).find((p) => p.item.id === item.id);
  if (plan) {
    const sim = simulate({
      tiers, price: item.price, fixed: 0, lot: item.print_lot,
      demands: plan.scenarios.map((s) => ({ key: s.key, demand: s.need - plan.stock })),
    });
    return sim && { basis: 'reprint', sim, stock: plan.stock, fixed: 0, reference: plan.reference };
  }
  if (item.kind !== 'book') return null;
  const nb = newBookPlan(data, opts);
  if (!nb) return null;
  const fixed = data.productionCosts.get(item.id) ?? 0;
  const sim = simulate({
    tiers, price: item.price, fixed, lot: item.print_lot,
    demands: nb.scenarios.map((s) => ({ key: s.key, demand: s.need })),
  });
  return sim && { basis: 'new', sim, stock: 0, fixed, reference: nb.reference };
}
