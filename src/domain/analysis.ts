import type { HaifuDB } from '../db/local';
import type { EventRow, Item, PrintRun } from '../db/types';
import { activeTxnIds, eventItemSummary, lineAmount, stockByLocation, type ItemAtEvent } from './ledger';

// 刷り部数の目安(要件 §6.1〜6.5)と損益分岐(§6.6)。
// 機械学習は使わず、途中の値をすべて画面に見せられる計算にする

export interface ForecastOptions {
  /** 何回先のイベントまでを見るか */
  plannedEvents: number;
  /** 安全率(0.1 = 10%増し) */
  safety: number;
  /** イベント以外で確保したい部数(通販用など) */
  reserve: number;
  /** 完売補正の上限(販売数の何倍まで) */
  capFactor: number;
  /** 新刊の期待度(続編 1.1 / 通常 1.0 / 新ジャンル 0.7) */
  expectation: number;
  /** 既刊の減衰率の既定値(実績がないとき) */
  defaultDecay: number;
  /** 終了時刻が未入力のときの開催時間 */
  defaultHours: number;
}

export const DEFAULT_FORECAST: ForecastOptions = {
  plannedEvents: 3, safety: 0.1, reserve: 0, capFactor: 2, expectation: 1, defaultDecay: 0.5, defaultHours: 5,
};

/** 累積販売曲線の既定値: 序盤に偏る形(開始1時間で約4割、2時間で約6.5割、3時間で約8割) */
export const defaultCurve = (t: number) => 1 - (1 - Math.min(Math.max(t, 0), 1)) ** 2;

export interface Observation {
  eventId: string;
  eventName: string;
  heldOn: string;
  brought: number;
  sold: number;
  /** 完売した時刻の、開催時間に対する割合(0〜1)。完売しなければ null */
  soldOutAt: string | null;
  soldOutFraction: number | null;
  /** 推定需要 D */
  demand: number;
  /** 完売補正で販売数より大きくした */
  corrected: boolean;
}

export interface ItemHistory {
  item: Item;
  observations: Observation[];
}

export interface AnalysisData {
  events: EventRow[];
  items: Item[];
  ownItems: Item[];
  /** 品目ごとの、過去のイベントでの観測(古い順) */
  histories: Map<string, ItemHistory>;
  /** 保管場所(自宅など)にある在庫 */
  storageStock: Map<string, number>;
  printRuns: PrintRun[];
  productionCosts: Map<string, number>;
  /** 品目ごとの累計の販売部数と売上(セットで売れた分は通常価格の比で按分) */
  soldTotals: Map<string, { qty: number; amount: number }>;
  /** 累積販売曲線 F(t) と、その作り方 */
  curve: (t: number) => number;
  curveSource: 'data' | 'default';
  curveSamples: number;
}

/** イベントの開始〜終了の時刻(ミリ秒)。未入力なら最初の販売から既定の時間 */
function eventWindow(ev: EventRow, firstSale: number | null, hours: number): [number, number] | null {
  const start = ev.starts_at ? Date.parse(ev.starts_at) : firstSale;
  if (start === null) return null;
  const end = ev.ends_at ? Date.parse(ev.ends_at) : start + hours * 3600_000;
  return end > start ? [start, end] : null;
}

export async function loadAnalysis(db: HaifuDB, circleId: string, opts: ForecastOptions = DEFAULT_FORECAST): Promise<AnalysisData> {
  const [events, items, owners, locations, setComponents, txns, lines, movements, printRuns, prodCosts, closings] = await Promise.all([
    db.events.where('circle_id').equals(circleId).toArray(),
    db.items.where('circle_id').equals(circleId).toArray(),
    db.owners.where('circle_id').equals(circleId).toArray(),
    db.locations.where('circle_id').equals(circleId).toArray(),
    db.set_components.toArray(),
    db.transactions.toArray(),
    db.transaction_lines.toArray(),
    db.stock_movements.toArray(),
    db.print_runs.toArray(),
    db.production_costs.toArray(),
    db.event_closings.toArray(),
  ]);
  const selfIds = new Set(owners.filter((o) => o.is_self).map((o) => o.id));
  // 削除した品目・イベントは、目安や損益分岐の対象にしない
  const ownItems = items.filter((i) => selfIds.has(i.owner_id) && i.kind !== 'set' && !i.deleted_at);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const active = activeTxnIds(txns);
  const today = new Date().toISOString().slice(0, 10);
  const closedEvents = new Set(closings.filter((c) => !c.reopened_at).map((c) => c.event_id));
  // 需要の材料にするのは、終わったイベントだけ(確定済みか、開催日を過ぎたもの)
  const past = events
    .filter((e) => !e.deleted_at && (closedEvents.has(e.id) || e.held_on < today))
    .sort((a, b) => a.held_on.localeCompare(b.held_on));

  const perEvent = past.map((ev) => {
    const loc = locations.find((l) => l.event_id === ev.id);
    const evTxns = txns.filter((t) => t.event_id === ev.id);
    const summary: Map<string, ItemAtEvent> = loc
      ? eventItemSummary({ eventLocationId: loc.id, items, setComponents, movements: movements.filter((m) => m.event_id === ev.id), txns: evTxns })
      : new Map();
    const sales = movements.filter((m) => m.event_id === ev.id && m.reason === 'sale' && m.transaction_id && active.has(m.transaction_id));
    const first = sales.length ? Math.min(...sales.map((m) => Date.parse(m.recorded_at))) : null;
    return { ev, summary, sales, window: eventWindow(ev, first, opts.defaultHours) };
  });

  // 累積販売曲線: 完売しなかった品目の販売が、開催時間のどの時点で起きたか(要件 §6.1)
  const fractions: { f: number; q: number }[] = [];
  for (const p of perEvent) {
    if (!p.window) continue;
    const [s, e] = p.window;
    for (const m of p.sales) {
      if (p.summary.get(m.item_id)?.soldOutAt) continue;
      fractions.push({ f: Math.min(Math.max((Date.parse(m.recorded_at) - s) / (e - s), 0), 1), q: m.qty });
    }
  }
  const samples = fractions.reduce((a, x) => a + x.q, 0);
  const curveSource: 'data' | 'default' = samples >= 30 ? 'data' : 'default';
  const curve = curveSource === 'data'
    ? (t: number) => fractions.filter((x) => x.f <= t).reduce((a, x) => a + x.q, 0) / samples
    : defaultCurve;

  const histories = new Map<string, ItemHistory>();
  for (const item of ownItems) {
    const observations: Observation[] = [];
    for (const p of perEvent) {
      const s = p.summary.get(item.id);
      if (!s || s.brought <= 0) continue;
      let fraction: number | null = null;
      let demand = s.sold;
      if (s.soldOutAt && p.window) {
        const [st, en] = p.window;
        fraction = Math.min(Math.max((Date.parse(s.soldOutAt) - st) / (en - st), 0), 1);
        if (fraction < 1 && s.sold > 0) {
          demand = Math.min(s.sold / Math.max(curve(fraction), 0.05), s.sold * opts.capFactor);
        }
      }
      demand = Math.round(demand * 10) / 10;
      observations.push({
        eventId: p.ev.id, eventName: p.ev.name, heldOn: p.ev.held_on, brought: s.brought, sold: s.sold,
        soldOutAt: s.soldOutAt, soldOutFraction: fraction, demand, corrected: demand > s.sold,
      });
    }
    histories.set(item.id, { item, observations });
  }

  const storageIds = locations.filter((l) => l.kind === 'storage').map((l) => l.id);
  const stock = stockByLocation(movements, txns);
  const storageStock = new Map(items.map((i) => [i.id, storageIds.reduce((a, l) => a + (stock.get(`${i.id}|${l}`) ?? 0), 0)]));

  const productionCosts = new Map<string, number>();
  for (const c of prodCosts) {
    const id = c.item_id as string;
    productionCosts.set(id, (productionCosts.get(id) ?? 0) + Number(c.amount ?? 0));
  }

  // 累計の販売(損益分岐の「いまどこまで来たか」)
  const saleIds = new Set(txns.filter((t) => t.type === 'sale' && active.has(t.id)).map((t) => t.id));
  const soldTotals = new Map<string, { qty: number; amount: number }>();
  const add = (id: string, qty: number, amount: number) => {
    const x = soldTotals.get(id) ?? { qty: 0, amount: 0 };
    soldTotals.set(id, { qty: x.qty + qty, amount: x.amount + amount });
  };
  for (const l of lines) {
    if (!saleIds.has(l.transaction_id)) continue;
    const it = itemById.get(l.item_id);
    if (!it) continue;
    if (it.kind !== 'set') {
      add(it.id, l.qty, lineAmount(l));
      continue;
    }
    const comps = setComponents.filter((c) => c.set_item_id === it.id);
    const base = comps.reduce((a, c) => a + (itemById.get(c.component_item_id)?.price ?? 0) * c.qty, 0);
    for (const c of comps) {
      const share = base > 0 ? ((itemById.get(c.component_item_id)?.price ?? 0) * c.qty) / base : 1 / comps.length;
      add(c.component_item_id, l.qty * c.qty, lineAmount(l) * share);
    }
  }

  return { events: events.filter((e) => !e.deleted_at), items, ownItems, histories, storageStock, printRuns, productionCosts, soldTotals, curve, curveSource, curveSamples: samples };
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const i = (s.length - 1) * q;
  return s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i - Math.floor(i));
};

export interface DecayRates {
  conservative: number;
  standard: number;
  aggressive: number;
  /** 計算に使った比 Dₙ/Dₙ₋₁ の数。0 なら既定値 */
  samples: number;
}

/** 既刊の減衰率: 同じ品目を続けて出したときの需要の比(要件 §6.3) */
export function decayRates(data: AnalysisData, opts: ForecastOptions): DecayRates {
  const ratios: number[] = [];
  for (const h of data.histories.values()) {
    for (let i = 1; i < h.observations.length; i++) {
      const prev = h.observations[i - 1].demand;
      if (prev > 0) ratios.push(Math.min(h.observations[i].demand / prev, 2));
    }
  }
  if (ratios.length === 0) {
    const r = opts.defaultDecay;
    return { conservative: r * 0.8, standard: r, aggressive: Math.min(r * 1.2, 1), samples: 0 };
  }
  if (ratios.length === 1) {
    const r = ratios[0];
    return { conservative: r * 0.8, standard: r, aggressive: Math.min(r * 1.2, 2), samples: 1 };
  }
  return { conservative: quantile(ratios, 0.25), standard: quantile(ratios, 0.5), aggressive: quantile(ratios, 0.75), samples: ratios.length };
}

export type ScenarioKey = 'conservative' | 'standard' | 'aggressive';
export const SCENARIO_LABEL: Record<ScenarioKey, string> = { conservative: '控えめ', standard: '標準', aggressive: '強気' };

export interface Scenario {
  key: ScenarioKey;
  /** 予定イベントごとの予測需要 */
  perEvent: number[];
  need: number;
  /** 推奨刷り部数(0 なら再版不要) */
  print: number;
  /** 全部刷ったときに余りそうな部数と、その原価 */
  leftover: number;
  leftoverCost: number;
}

export interface ReprintPlan {
  item: Item;
  history: ItemHistory;
  stock: number;
  base: number;
  lot: number;
  unitCost: number | null;
  scenarios: Scenario[];
  /** データ不足(同じ品目の実績が2回未満) */
  reference: boolean;
}

const roundUp = (n: number, lot: number) => Math.ceil(n / lot) * lot;

function unitCostOf(data: AnalysisData, itemId: string): number | null {
  const runs = data.printRuns.filter((r) => r.item_id === itemId).sort((a, b) => b.edition - a.edition);
  return runs[0] ? runs[0].total_cost / runs[0].qty : null;
}

/** 既刊ごとの再版の目安(F-801、F-803、F-806、要件 §6.5) */
export function reprintPlans(data: AnalysisData, opts: ForecastOptions): ReprintPlan[] {
  const rates = decayRates(data, opts);
  const out: ReprintPlan[] = [];
  for (const h of data.histories.values()) {
    if (h.observations.length === 0) continue;
    const base = h.observations[h.observations.length - 1].demand;
    const stock = Math.max(data.storageStock.get(h.item.id) ?? 0, 0);
    const lot = h.item.print_lot ?? 1;
    const unitCost = unitCostOf(data, h.item.id);
    const scenarios = (['conservative', 'standard', 'aggressive'] as const).map((key): Scenario => {
      const r = rates[key];
      const perEvent = Array.from({ length: opts.plannedEvents }, (_, k) => Math.round(base * r ** (k + 1) * 10) / 10);
      const need = perEvent.reduce((a, x) => a + x, 0) + opts.reserve;
      const short = Math.ceil(need * (1 + opts.safety)) - stock;
      const print = short > 0 ? roundUp(short, lot) : 0;
      const leftover = Math.max(Math.round(stock + print - need), 0);
      return { key, perEvent, need: Math.round(need), print, leftover, leftoverCost: Math.round(leftover * (unitCost ?? 0)) };
    });
    out.push({ item: h.item, history: h, stock, base, lot, unitCost, scenarios, reference: h.observations.length < 2 });
  }
  return out.sort((a, b) => b.scenarios[1].print - a.scenarios[1].print || a.item.name.localeCompare(b.item.name, 'ja'));
}

export interface NewBookPlan {
  /** 材料にした新刊(初めて出したイベントでの推定需要。新しい順) */
  basis: { item: Item; eventName: string; heldOn: string; demand: number; weight: number }[];
  scenarios: { key: ScenarioKey; firstEvent: number; need: number; print: number }[];
  reference: boolean;
}

/** 次の新刊の目安(F-802、要件 §6.4)。直近3冊の、初めて出したイベントでの需要を 3:2:1 で加重平均する */
export function newBookPlan(data: AnalysisData, opts: ForecastOptions): NewBookPlan | null {
  const firsts = [...data.histories.values()]
    .filter((h) => h.item.kind === 'book' && h.observations.length > 0)
    .map((h) => ({ item: h.item, obs: h.observations[0] }))
    .sort((a, b) => b.obs.heldOn.localeCompare(a.obs.heldOn))
    .slice(0, 3);
  if (firsts.length === 0) return null;
  const weights = [3, 2, 1].slice(0, firsts.length);
  const wsum = weights.reduce((a, w) => a + w, 0);
  const demands = firsts.map((f) => f.obs.demand);
  const weighted = firsts.reduce((a, f, i) => a + f.obs.demand * weights[i], 0) / wsum;
  const rates = decayRates(data, opts);
  const scenarioBase: Record<ScenarioKey, number> = {
    conservative: Math.min(...demands), standard: weighted, aggressive: Math.max(...demands),
  };
  const scenarios = (['conservative', 'standard', 'aggressive'] as const).map((key) => {
    const first = scenarioBase[key] * opts.expectation;
    const r = rates[key];
    const need = Array.from({ length: opts.plannedEvents }, (_, k) => first * r ** k).reduce((a, x) => a + x, 0) + opts.reserve;
    return { key, firstEvent: Math.round(first), need: Math.round(need), print: roundUp(Math.ceil(need * (1 + opts.safety)), 10) };
  });
  return {
    basis: firsts.map((f, i) => ({ item: f.item, eventName: f.obs.eventName, heldOn: f.obs.heldOn, demand: f.obs.demand, weight: weights[i] })),
    scenarios,
    reference: firsts.length < 2,
  };
}

export interface ItemBreakEven {
  item: Item;
  fixedCost: number;
  printed: number;
  /** 損益分岐部数(価格0なら null) */
  breakEvenQty: number | null;
  soldQty: number;
  soldAmount: number;
  /** 実際の1部あたりの売上(セットの按分やイベント価格を含む)。売れていなければ定価 */
  unitRevenue: number;
  /** 回収までにあと何円 */
  remainingAmount: number;
  /** 刷った部数を全部売っても回収できない */
  cannotRecover: boolean;
}

/** 頒布物別の損益分岐(F-1101、F-1102)。MVPは変動費0なので、固定費 = 印刷費 + 制作費 */
export function itemBreakEven(data: AnalysisData, item: Item): ItemBreakEven {
  const runs = data.printRuns.filter((r) => r.item_id === item.id);
  const fixedCost = runs.reduce((a, r) => a + r.total_cost, 0) + (data.productionCosts.get(item.id) ?? 0);
  const printed = runs.reduce((a, r) => a + r.qty, 0);
  const sold = data.soldTotals.get(item.id) ?? { qty: 0, amount: 0 };
  const unitRevenue = sold.qty > 0 ? sold.amount / sold.qty : item.price;
  const breakEvenQty = unitRevenue > 0 ? Math.ceil(fixedCost / unitRevenue) : null;
  return {
    item, fixedCost, printed, breakEvenQty, soldQty: sold.qty, soldAmount: Math.round(sold.amount), unitRevenue,
    remainingAmount: Math.max(Math.round(fixedCost - sold.amount), 0),
    cannotRecover: breakEvenQty !== null && printed > 0 && breakEvenQty > printed,
  };
}

export interface EventBreakEven {
  fixed: number;
  fee: number;
  /** 粗利率(自分の分の売上に対する、売上 − 原価の割合) */
  margin: number | null;
  marginSource: 'this' | 'previous' | 'none';
  /** 損益分岐売上(自分の分) */
  breakEvenSales: number | null;
  ownSales: number;
  profit: number;
}

/**
 * イベント別の損益分岐(F-1103、要件 §6.6)。
 * 損益分岐売上(自分の分)= (経費 − 受託手数料)÷ 粗利率。売上がまだないときは前回までの粗利率を使う
 */
export function eventBreakEven(money: { own: number; fee: number; expenses: number; cost: number; profit: number }, previousMargin: number | null): EventBreakEven {
  const thisMargin = money.own > 0 ? (money.own - money.cost) / money.own : null;
  const margin = thisMargin ?? previousMargin;
  const marginSource = thisMargin !== null ? 'this' : previousMargin !== null ? 'previous' : 'none';
  const breakEvenSales = margin !== null && margin > 0 ? Math.max(Math.ceil((money.expenses - money.fee) / margin), 0) : null;
  return { fixed: money.expenses, fee: money.fee, margin, marginSource, breakEvenSales, ownSales: money.own, profit: money.profit };
}
