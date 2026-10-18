import type { HaifuDB } from '../db/local';
import type { EventClosing, EventRow, Item, Location, Movement, PrintRun, SetComponent, Txn, TxnLine } from '../db/types';
import { activeTxnIds, eventItemSummary, lineAmount, type ItemAtEvent } from './ledger';
import { storageStock as loadStorageStock } from './stock';
import { activeFractionDays, dayWindows, daysOf, lastDayOf } from './eventDays';

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
  /** 推定需要 D(イベント全体。2日開催なら2日分) */
  demand: number;
  /** 開催日数 */
  days: number;
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

/**
 * 1つのイベントの集計(品目ごとの持ち込み・販売・完売の時刻、販売の時刻、品目ごとの売上)。
 * 終了処理を確定したイベントは記録が変わらないので、一度計算したら控えておく(Issue #31)
 */
interface EventDigest {
  summary: Map<string, ItemAtEvent>;
  /** 販売(取り消されていないもの)の [時刻, 部数, 品目] */
  sales: [number, number, string][];
  /** 品目ごとの販売部数と売上(セットはセットの品目のまま) */
  sold: Map<string, { qty: number; amount: number }>;
}

/** 確定済みのイベントの控え。キーが変われば(やり直し・イベントや休憩の修正)計算し直す */
const digestCache = new Map<string, { key: string; digest: EventDigest }>();

/** 控えを捨てる(テスト用) */
export function clearAnalysisCache() {
  digestCache.clear();
}

interface EventRows {
  loc: Location | undefined;
  txns: Txn[];
  movements: Movement[];
  /** 取り消されていない販売の明細 */
  lines: TxnLine[];
}

/** 1つのイベントの行を、索引で読む(計算し直すイベントが少ないとき) */
async function readEventRows(db: HaifuDB, ev: EventRow): Promise<EventRows> {
  const [loc, txns, movements] = await Promise.all([
    db.locations.where('event_id').equals(ev.id).first(),
    db.transactions.where('event_id').equals(ev.id).toArray(),
    db.stock_movements.where('event_id').equals(ev.id).toArray(),
  ]);
  // 取り消しは同じイベントの取引だけが対象なので、イベントの中だけで数えられる
  const active = activeTxnIds(txns);
  const saleIds = txns.filter((t) => t.type === 'sale' && active.has(t.id)).map((t) => t.id);
  const lines = saleIds.length ? await db.transaction_lines.where('transaction_id').anyOf(saleIds).toArray() : [];
  return { loc, txns, movements, lines };
}

/** 全部のイベントの行を、まとめて読んでイベントごとに分ける(はじめて開いたときなど、計算し直すイベントが多いとき) */
async function readAllEventRows(db: HaifuDB, eventIds: Set<string>): Promise<Map<string, EventRows>> {
  const [locs, txns, movements, lines] = await Promise.all([
    db.locations.toArray(), db.transactions.toArray(), db.stock_movements.toArray(), db.transaction_lines.toArray(),
  ]);
  const out = new Map<string, EventRows>();
  for (const id of eventIds) out.set(id, { loc: undefined, txns: [], movements: [], lines: [] });
  for (const l of locs) if (l.event_id && out.has(l.event_id)) out.get(l.event_id)!.loc = l;
  const txnEvent = new Map<string, string>();
  for (const t of txns) {
    if (!out.has(t.event_id)) continue;
    out.get(t.event_id)!.txns.push(t);
    txnEvent.set(t.id, t.event_id);
  }
  for (const m of movements) if (m.event_id && out.has(m.event_id)) out.get(m.event_id)!.movements.push(m);
  const activeSales = new Set<string>();
  for (const r of out.values()) {
    const active = activeTxnIds(r.txns);
    for (const t of r.txns) if (t.type === 'sale' && active.has(t.id)) activeSales.add(t.id);
  }
  for (const l of lines) if (activeSales.has(l.transaction_id)) out.get(txnEvent.get(l.transaction_id)!)!.lines.push(l);
  return out;
}

function digestOf(rows: EventRows, items: Item[], setComponents: SetComponent[]): EventDigest {
  const { loc, txns, movements, lines } = rows;
  const active = activeTxnIds(txns);
  const summary = loc ? eventItemSummary({ eventLocationId: loc.id, items, setComponents, movements, txns }) : new Map<string, ItemAtEvent>();
  const sales = movements
    .filter((m) => m.reason === 'sale' && m.transaction_id && active.has(m.transaction_id))
    .map((m): [number, number, string] => [Date.parse(m.recorded_at), m.qty, m.item_id]);
  const sold = new Map<string, { qty: number; amount: number }>();
  for (const l of lines) {
    const x = sold.get(l.item_id) ?? { qty: 0, amount: 0 };
    sold.set(l.item_id, { qty: x.qty + l.qty, amount: x.amount + lineAmount(l) });
  }
  return { summary, sales, sold };
}

export async function loadAnalysis(db: HaifuDB, circleId: string, opts: ForecastOptions = DEFAULT_FORECAST): Promise<AnalysisData> {
  const [events, items, owners, setComponents, printRuns, prodCosts, closings, breaks, storageStock] = await Promise.all([
    db.events.where('circle_id').equals(circleId).toArray(),
    db.items.where('circle_id').equals(circleId).toArray(),
    db.owners.where('circle_id').equals(circleId).toArray(),
    db.set_components.toArray(),
    db.print_runs.toArray(),
    db.production_costs.toArray(),
    db.event_closings.toArray(),
    db.event_breaks.toArray(),
    // 保管場所の在庫は、保管場所に出入りした行だけ読んで出す(#31 の前の軽量化と同じ)
    loadStorageStock(db, circleId).then((m) => {
      const byItem = new Map<string, number>();
      for (const [k, n] of m) {
        const id = k.slice(0, k.indexOf('|'));
        byItem.set(id, (byItem.get(id) ?? 0) + n);
      }
      return byItem;
    }),
  ]);
  const selfIds = new Set(owners.filter((o) => o.is_self).map((o) => o.id));
  // 削除した品目・イベントは、目安や損益分岐の対象にしない
  const ownItems = items.filter((i) => selfIds.has(i.owner_id) && i.kind !== 'set' && !i.deleted_at);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const today = new Date().toISOString().slice(0, 10);
  const closingOf = new Map<string, EventClosing>(closings.filter((c) => !c.reopened_at).map((c) => [c.event_id, c]));

  // イベントごとの集計。確定済みは控えを使い、まだのイベントだけ、そのイベントの行を読んで計算する
  const digests = new Map<string, EventDigest>();
  const missing: { ev: EventRow; key: string | null }[] = [];
  for (const ev of events) {
    const closing = closingOf.get(ev.id);
    const evBreaks = breaks.filter((b) => b.event_id === ev.id);
    const key = closing
      ? [closing.id, ev.client_updated_at, evBreaks.length, evBreaks.reduce((a, b) => (b.client_updated_at > a ? b.client_updated_at : a), '')].join('|')
      : null;
    const hit = key ? digestCache.get(ev.id) : undefined;
    if (hit && hit.key === key) digests.set(ev.id, hit.digest);
    else missing.push({ ev, key });
  }
  // 計算し直すイベントが多ければ表をまとめて読み、少なければそのイベントの行だけを索引で読む
  const bulk = missing.length > 3 ? await readAllEventRows(db, new Set(missing.map((m) => m.ev.id))) : null;
  await Promise.all(missing.map(async ({ ev, key }) => {
    const rows = bulk ? bulk.get(ev.id)! : await readEventRows(db, ev);
    const digest = digestOf(rows, items, setComponents);
    if (key) digestCache.set(ev.id, { key, digest });
    digests.set(ev.id, digest);
  }));

  // 需要の材料にするのは、終わったイベントだけ(確定済みか、最終日を過ぎたもの)
  const past = events
    .filter((e) => !e.deleted_at && (closingOf.has(e.id) || lastDayOf(e) < today))
    .sort((a, b) => a.held_on.localeCompare(b.held_on));

  const perEvent = past.map((ev) => {
    const d = digests.get(ev.id)!;
    // 日ごとの開催時間(2日開催なら2つ)。休憩・離席の時間と、日と日のあいだの夜は数えない(F-411、Issue #19)
    const windows = dayWindows(ev, d.sales.map(([t]) => t), opts.defaultHours);
    return { ev, summary: d.summary, sales: d.sales, windows, breaks: breaks.filter((b) => b.event_id === ev.id) };
  });

  // 累積販売曲線: 完売しなかった品目の販売が、開催時間のどの時点で起きたか(要件 §6.1)
  const fractions: { f: number; q: number }[] = [];
  for (const p of perEvent) {
    if (p.windows.length === 0) continue;
    for (const [t, q, itemId] of p.sales) {
      if (p.summary.get(itemId)?.soldOutAt) continue;
      fractions.push({ f: activeFractionDays(t, p.windows, p.breaks), q });
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
      if (s.soldOutAt && p.windows.length > 0) {
        fraction = activeFractionDays(Date.parse(s.soldOutAt), p.windows, p.breaks);
        if (fraction < 1 && s.sold > 0) {
          demand = Math.min(s.sold / Math.max(curve(fraction), 0.05), s.sold * opts.capFactor);
        }
      }
      demand = Math.round(demand * 10) / 10;
      observations.push({
        eventId: p.ev.id, eventName: p.ev.name, heldOn: p.ev.held_on, brought: s.brought, sold: s.sold,
        soldOutAt: s.soldOutAt, soldOutFraction: fraction, demand, corrected: demand > s.sold, days: daysOf(p.ev),
      });
    }
    histories.set(item.id, { item, observations });
  }

  const productionCosts = new Map<string, number>();
  for (const c of prodCosts) {
    const id = c.item_id as string;
    productionCosts.set(id, (productionCosts.get(id) ?? 0) + Number(c.amount ?? 0));
  }

  // 累計の販売(損益分岐の「いまどこまで来たか」)。セットで売れた分は、いまの通常価格の比で構成品に按分する
  const soldTotals = new Map<string, { qty: number; amount: number }>();
  const add = (id: string, qty: number, amount: number) => {
    const x = soldTotals.get(id) ?? { qty: 0, amount: 0 };
    soldTotals.set(id, { qty: x.qty + qty, amount: x.amount + amount });
  };
  for (const d of digests.values()) {
    for (const [itemId, x] of d.sold) {
      const it = itemById.get(itemId);
      if (!it) continue;
      if (it.kind !== 'set') {
        add(it.id, x.qty, x.amount);
        continue;
      }
      const comps = setComponents.filter((c) => c.set_item_id === it.id);
      const base = comps.reduce((a, c) => a + (itemById.get(c.component_item_id)?.price ?? 0) * c.qty, 0);
      for (const c of comps) {
        const share = base > 0 ? ((itemById.get(c.component_item_id)?.price ?? 0) * c.qty) / base : 1 / comps.length;
        add(c.component_item_id, x.qty * c.qty, x.amount * share);
      }
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

/**
 * 頒布物別の損益分岐(F-1101、F-1102)。MVPは変動費0なので、固定費 = 印刷費 + 制作費。
 * edition を渡すと「その版だけ」で見る(F-1107): 費用はその版の印刷費(制作費は初版だけに含める)、
 * 販売は古い版から順に売れたものとして、その版に当たる部数だけを数える
 */
export function itemBreakEven(data: AnalysisData, item: Item, edition?: number): ItemBreakEven {
  const runs = data.printRuns.filter((r) => r.item_id === item.id).sort((a, b) => a.edition - b.edition);
  const sold = data.soldTotals.get(item.id) ?? { qty: 0, amount: 0 };
  const unitRevenue = sold.qty > 0 ? sold.amount / sold.qty : item.price;
  const firstEdition = runs[0]?.edition;
  const scoped = edition === undefined ? runs : runs.filter((r) => r.edition === edition);
  const fixedCost = scoped.reduce((a, r) => a + r.total_cost, 0)
    + (edition === undefined || edition === firstEdition ? data.productionCosts.get(item.id) ?? 0 : 0);
  const printed = scoped.reduce((a, r) => a + r.qty, 0);
  let soldQty = sold.qty;
  if (edition !== undefined) {
    const before = runs.filter((r) => r.edition < edition).reduce((a, r) => a + r.qty, 0);
    soldQty = Math.min(Math.max(sold.qty - before, 0), printed);
  }
  const soldAmount = edition === undefined ? sold.amount : soldQty * unitRevenue;
  const breakEvenQty = unitRevenue > 0 ? Math.ceil(fixedCost / unitRevenue) : null;
  return {
    item, fixedCost, printed, breakEvenQty, soldQty, soldAmount: Math.round(soldAmount), unitRevenue,
    remainingAmount: Math.max(Math.round(fixedCost - soldAmount), 0),
    cannotRecover: breakEvenQty !== null && printed > 0 && breakEvenQty > printed,
  };
}

export interface PriceTrial {
  price: number;
  /** その価格で全部売れたとして、費用を回収できる部数 */
  breakEvenQty: number | null;
  /** これまでの売上に加えて、その価格であと何部売れば回収できるか */
  remainingQty: number | null;
  /** 刷った部数の残りを、その価格で全部売ったときの収支 */
  allSoldProfit: number;
}

/**
 * 価格を変えたときの試算(F-1106)。需要(売れる部数)は変えない単純な試算。
 * これまでの売上はそのまま数え、これから売る分だけをその価格で数える
 */
export function priceTrial(be: ItemBreakEven, price: number): PriceTrial {
  const p = Math.max(0, Math.round(price));
  const breakEvenQty = p > 0 ? Math.ceil(be.fixedCost / p) : null;
  const remainingQty = be.remainingAmount === 0 ? 0 : p > 0 ? Math.ceil(be.remainingAmount / p) : null;
  const left = Math.max(be.printed - be.soldQty, 0);
  return { price: p, breakEvenQty, remainingQty, allSoldProfit: Math.round(be.soldAmount + left * p - be.fixedCost) };
}

/** スライダーの範囲: 定価の半分〜2倍くらいを、きりのよい刻みで */
export function priceRange(price: number): { min: number; max: number; step: number } {
  const step = price >= 1000 ? 100 : price >= 300 ? 50 : 10;
  const min = Math.max(step, Math.floor((price * 0.5) / step) * step);
  const max = Math.max(Math.ceil((price * 2) / step) * step, min + step * 4);
  return { min, max, step };
}

/** 版の一覧(F-1107 の切り替え用) */
export function editionsOf(data: AnalysisData, itemId: string): number[] {
  return [...new Set(data.printRuns.filter((r) => r.item_id === itemId).map((r) => r.edition))].sort((a, b) => a - b);
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
