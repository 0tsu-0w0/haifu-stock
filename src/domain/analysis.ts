import type { HaifuDB } from '../db/local';
import type { EventClosing, EventRow, Item, Location, Movement, Owner, PrintRun, SetComponent, Txn, TxnLine } from '../db/types';
import { activeTxnIds, eventItemSummary, lineAmount, type ItemAtEvent } from './ledger';
import { consigneeState, type ConsigneeState } from './consignOut';
import { locationStock, storageStock as loadStorageStock } from './stock';
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
  /** 委託で売れる分を、何か月先まで再版の目安に足すか(0 なら足さない) */
  consignMonths: number;
}

export const DEFAULT_FORECAST: ForecastOptions = {
  plannedEvents: 3, safety: 0.1, reserve: 0, capFactor: 2, expectation: 1, defaultDecay: 0.5, defaultHours: 5, consignMonths: 6,
};

/** 委託の売れ方を見る期間(直近1年) */
const CONSIGN_WINDOW_DAYS = 365;
const DAY = 86_400_000;

/** 品目ごとの委託の様子(再版の目安で使う) */
export interface ConsignPace {
  /** 委託先にいま預けている部数(全委託先の合計) */
  left: number;
  /** 直近1年の報告で売れた部数 */
  sold: number;
  /** その部数を数えた期間(か月。初めて預けた日か1年前の遅いほうから今日まで。1か月以上) */
  months: number;
  /** 1か月あたりに売れた部数 */
  perMonth: number;
}

/**
 * 委託の売れ方(決定事項 #15 のとおり、イベントの需要とは分けて数える)。
 * 取り消した報告は数えない。預けたことのない品目は入れない
 */
export function consignPaces(states: Map<string, ConsigneeState>, today: string): Map<string, ConsignPace> {
  const now = Date.parse(today);
  const since = new Date(now - CONSIGN_WINDOW_DAYS * DAY).toISOString().slice(0, 10);
  const out = new Map<string, { left: number; sold: number; firstSent: string | null }>();
  for (const s of states.values()) {
    for (const x of s.items.values()) {
      const p = out.get(x.itemId) ?? { left: 0, sold: 0, firstSent: null };
      p.left += Math.max(x.left, 0);
      out.set(x.itemId, p);
    }
    for (const r of s.reports) {
      if (r.reported_on < since) continue;
      for (const l of r.lines) {
        const p = out.get(l.item_id) ?? { left: 0, sold: 0, firstSent: null };
        p.sold += l.qty;
        out.set(l.item_id, p);
      }
    }
    for (const [itemId, at] of s.firstSent) {
      const p = out.get(itemId);
      if (p && (!p.firstSent || at < p.firstSent)) p.firstSent = at;
    }
  }
  const res = new Map<string, ConsignPace>();
  for (const [id, p] of out) {
    const from = Math.max(Date.parse(p.firstSent ?? since), Date.parse(since));
    const months = Math.max(1, Math.round(((now - from) / DAY / 30.4) * 10) / 10);
    res.set(id, { left: p.left, sold: p.sold, months, perMonth: Math.round((p.sold / months) * 10) / 10 });
  }
  return res;
}

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
  /** 受託品(ほかのサークルの品目)の、過去のイベントでの観測。刷り部数・損益の目安には使わず、「推移」で持ち主ごとに見るためだけに持つ(F-708) */
  consignedHistories: Map<string, ItemHistory>;
  /** 持ち主(自分と受託元) */
  owners: Owner[];
  /** 保管場所(自宅など)にある在庫 */
  storageStock: Map<string, number>;
  printRuns: PrintRun[];
  productionCosts: Map<string, number>;
  /** 品目ごとの累計の販売部数と売上(セットで売れた分は通常価格の比で按分) */
  soldTotals: Map<string, { qty: number; amount: number }>;
  /** 同じものを、開催日の年ごとに分けたもの */
  soldByYear: Map<number, Map<string, { qty: number; amount: number }>>;
  /** これからのイベント(終わっていないもの。開催日の早い順)。刷り部数の目安で、日数と種別を見る */
  upcoming: EventRow[];
  /** これからのイベントの置き場所に、もう入っている在庫(持ち込みを反映した分・直接搬入した分)。品目ごと */
  upcomingStock: Map<string, number>;
  /** 委託の売れ方。品目ごと */
  consign: Map<string, ConsignPace>;
  /** 累積販売曲線 F(t) と、その作り方 */
  curve: (t: number) => number;
  curveSource: 'data' | 'default';
  curveSamples: number;
  /** 種別ごとの曲線を作れた種別(その種別の材料が CURVE_MIN_SAMPLES 部以上)。完売補正は、あればそのイベントの種別の曲線を使う */
  curveTypes: { typeId: string; samples: number }[];
}

/** 累積販売曲線を実績から作るのに要る部数(全体でも、種別ごとでも) */
export const CURVE_MIN_SAMPLES = 30;

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
  const fractions: { f: number; q: number; type: string | null }[] = [];
  for (const p of perEvent) {
    if (p.windows.length === 0) continue;
    for (const [t, q, itemId] of p.sales) {
      if (p.summary.get(itemId)?.soldOutAt) continue;
      fractions.push({ f: activeFractionDays(t, p.windows, p.breaks), q, type: p.ev.event_type_id ?? null });
    }
  }
  const samples = fractions.reduce((a, x) => a + x.q, 0);
  const curveSource: 'data' | 'default' = samples >= CURVE_MIN_SAMPLES ? 'data' : 'default';
  const curve = curveSource === 'data'
    ? (t: number) => fractions.filter((x) => x.f <= t).reduce((a, x) => a + x.q, 0) / samples
    : defaultCurve;
  // 種別ごとの曲線(§6.1「同じ種別のイベントで」)。材料が足りる種別だけ作り、足りない種別は全体の曲線を使う
  const typeCurves = new Map<string, (t: number) => number>();
  const curveTypes: { typeId: string; samples: number }[] = [];
  for (const typeId of new Set(fractions.map((x) => x.type))) {
    if (!typeId) continue;
    const own = fractions.filter((x) => x.type === typeId);
    const n = own.reduce((a, x) => a + x.q, 0);
    if (n < CURVE_MIN_SAMPLES) continue;
    typeCurves.set(typeId, (t: number) => own.filter((x) => x.f <= t).reduce((a, x) => a + x.q, 0) / n);
    curveTypes.push({ typeId, samples: n });
  }

  const histories = new Map<string, ItemHistory>();
  const consignedHistories = new Map<string, ItemHistory>();
  const consignedItems = items.filter((i) => !selfIds.has(i.owner_id) && i.kind !== 'set' && !i.deleted_at);
  for (const item of [...ownItems, ...consignedItems]) {
    const observations: Observation[] = [];
    for (const p of perEvent) {
      const s = p.summary.get(item.id);
      if (!s || s.brought <= 0) continue;
      let fraction: number | null = null;
      let demand = s.sold;
      if (s.soldOutAt && p.windows.length > 0) {
        fraction = activeFractionDays(Date.parse(s.soldOutAt), p.windows, p.breaks);
        if (fraction < 1 && s.sold > 0) {
          const f = (p.ev.event_type_id && typeCurves.get(p.ev.event_type_id)) || curve;
          demand = Math.min(s.sold / Math.max(f(fraction), 0.05), s.sold * opts.capFactor);
        }
      }
      demand = Math.round(demand * 10) / 10;
      observations.push({
        eventId: p.ev.id, eventName: p.ev.name, heldOn: p.ev.held_on, brought: s.brought, sold: s.sold,
        soldOutAt: s.soldOutAt, soldOutFraction: fraction, demand, corrected: demand > s.sold, days: daysOf(p.ev),
      });
    }
    (selfIds.has(item.owner_id) ? histories : consignedHistories).set(item.id, { item, observations });
  }
  // 受託品は、出したイベントのあるものだけ残す
  for (const [id, h] of consignedHistories) if (h.observations.length === 0) consignedHistories.delete(id);

  const productionCosts = new Map<string, number>();
  for (const c of prodCosts) {
    const id = c.item_id as string;
    productionCosts.set(id, (productionCosts.get(id) ?? 0) + Number(c.amount ?? 0));
  }

  // 累計の販売(損益分岐の「いまどこまで来たか」)。セットで売れた分は、いまの通常価格の比で構成品に按分する
  const soldTotals = new Map<string, { qty: number; amount: number }>();
  const soldByYear = new Map<number, Map<string, { qty: number; amount: number }>>();
  const heldYear = new Map(events.map((e) => [e.id, Number(e.held_on.slice(0, 4))]));
  let year = 0;
  const add = (id: string, qty: number, amount: number) => {
    const x = soldTotals.get(id) ?? { qty: 0, amount: 0 };
    soldTotals.set(id, { qty: x.qty + qty, amount: x.amount + amount });
    let m = soldByYear.get(year);
    if (!m) soldByYear.set(year, (m = new Map()));
    const y = m.get(id) ?? { qty: 0, amount: 0 };
    m.set(id, { qty: y.qty + qty, amount: y.amount + amount });
  };
  for (const [eventId, d] of digests) {
    year = heldYear.get(eventId) ?? 0;
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

  const pastIds = new Set(past.map((e) => e.id));
  const upcoming = events.filter((e) => !e.deleted_at && !pastIds.has(e.id)).sort((a, b) => a.held_on.localeCompare(b.held_on));
  // これからのイベントに持ち込み済みの分は、保管場所にはないが手元にある在庫として数える(再版の目安で引く)
  const upcomingIds = new Set(upcoming.map((e) => e.id));
  const upcomingLocs = upcoming.length === 0 ? []
    : (await db.locations.where('circle_id').equals(circleId).toArray()).filter((l) => l.event_id && upcomingIds.has(l.event_id));
  const upcomingStock = new Map<string, number>();
  for (const [k, n] of await locationStock(db, upcomingLocs.map((l) => l.id))) {
    const id = k.slice(0, k.indexOf('|'));
    upcomingStock.set(id, (upcomingStock.get(id) ?? 0) + n);
  }
  const consign = consignPaces(await consigneeState(db, circleId), today);
  return { events: events.filter((e) => !e.deleted_at), upcoming, upcomingStock, consign, items, ownItems, histories, consignedHistories, owners, storageStock, printRuns, productionCosts, soldTotals, soldByYear, curve, curveSource, curveSamples: samples, curveTypes };
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

/** 種別の規模の比べに要る、種別ごとの終わったイベントの数 */
export const TYPE_MIN_EVENTS = 2;

/** 種別の比べの材料(要件 §6.2) */
export interface TypeScales {
  /** 終わったイベントが TYPE_MIN_EVENTS 回以上ある種別と、その回数 */
  events: Map<string, number>;
  /** 品目ごと・種別ごとの、1日あたりの推定需要の平均 */
  itemMeans: Map<string, Map<string, number>>;
}

/**
 * イベント種別ごとの材料を集める。規模の比は、同じ品目どうしで比べる(typeScaleBetween)。
 * イベントごとの需要の合計で比べると、品目が増えた時期のイベントほど大きく出てしまうため
 */
export function typeScales(data: AnalysisData): TypeScales {
  const typeOf = new Map(data.events.map((e) => [e.id, e.event_type_id ?? null]));
  const eventsByType = new Map<string, Set<string>>();
  const sums = new Map<string, Map<string, { sum: number; n: number }>>();
  for (const h of data.histories.values()) {
    for (const o of h.observations) {
      const t = typeOf.get(o.eventId);
      if (!t) continue;
      if (!eventsByType.has(t)) eventsByType.set(t, new Set());
      eventsByType.get(t)!.add(o.eventId);
      const byType = sums.get(h.item.id) ?? new Map<string, { sum: number; n: number }>();
      const x = byType.get(t) ?? { sum: 0, n: 0 };
      byType.set(t, { sum: x.sum + o.demand / Math.max(o.days, 1), n: x.n + 1 });
      sums.set(h.item.id, byType);
    }
  }
  const events = new Map([...eventsByType].filter(([, ids]) => ids.size >= TYPE_MIN_EVENTS).map(([t, ids]) => [t, ids.size]));
  const itemMeans = new Map([...sums].map(([id, byType]) => [id, new Map([...byType].map(([t, x]) => [t, x.sum / x.n]))]));
  return { events, itemMeans };
}

/**
 * 種別 from の実績を、種別 to のイベントに当てはめるときに掛ける比(§6.2)。
 * 両方の種別に出したことのある品目ごとに「to での1日あたりの需要 ÷ from での」を出し、その中央値を使う。
 * 同じ種別・種別なし・どちらかの種別の終わったイベントが足りない・両方に出した品目がないときは 1。
 * 外れた値で目安が極端にならないよう 1/4〜4倍に収める
 */
export function typeScaleBetween(scales: TypeScales, from: string | null, to: string | null): number {
  if (!from || !to || from === to || !scales.events.has(from) || !scales.events.has(to)) return 1;
  const ratios: number[] = [];
  for (const means of scales.itemMeans.values()) {
    const f = means.get(from);
    const t = means.get(to);
    if (f !== undefined && t !== undefined && f > 0) ratios.push(t / f);
  }
  if (ratios.length === 0) return 1;
  return Math.min(4, Math.max(0.25, quantile(ratios, 0.5)));
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
  /**
   * 委託で売れる見込み(consignMonths か月分)と、それを委託先に預けている分でまかなえない部数。
   * 委託先の在庫はイベントには使えないので、手元の在庫とは分けて数える。委託していない品目・consignMonths が0なら null
   */
  consign: { pace: ConsignPace; months: number; expected: number; short: number } | null;
  /** 予測した回ごとの、当てはめたイベント。登録していない回は event が null で、直近と同じ規模として扱う */
  planned: { event: EventRow | null; days: number; scale: number }[];
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
  const scales = typeScales(data);
  const typeOf = new Map(data.events.map((e) => [e.id, e.event_type_id ?? null]));
  const out: ReprintPlan[] = [];
  for (const h of data.histories.values()) {
    if (h.observations.length === 0) continue;
    const last = h.observations[h.observations.length - 1];
    const base = last.demand;
    // 登録してあるこれからのイベントは、その日数と種別に合わせる(§6.2)。登録していない回は、直近と同じ規模とする
    const planned = Array.from({ length: opts.plannedEvents }, (_, k) => {
      const event = data.upcoming[k] ?? null;
      return event
        ? { event, days: daysOf(event), scale: typeScaleBetween(scales, typeOf.get(last.eventId) ?? null, event.event_type_id ?? null) }
        : { event, days: last.days, scale: 1 };
    });
    const factor = planned.map((p) => (p.days / Math.max(last.days, 1)) * p.scale);
    // 手元の在庫 = 保管場所 + これからのイベントに持ち込み済みの分(直接搬入も含む)
    const stock = Math.max((data.storageStock.get(h.item.id) ?? 0) + (data.upcomingStock.get(h.item.id) ?? 0), 0);
    const lot = h.item.print_lot ?? 1;
    const unitCost = unitCostOf(data, h.item.id);
    // 委託: 売れる見込みのうち、委託先にある分で足りない部数だけを足す(決定事項 #15・#20)
    const pace = data.consign.get(h.item.id);
    const consign = pace && opts.consignMonths > 0 && pace.sold > 0
      ? (() => {
        const expected = Math.round(pace.perMonth * opts.consignMonths * 10) / 10;
        return { pace, months: opts.consignMonths, expected, short: Math.max(Math.ceil(expected - pace.left), 0) };
      })()
      : null;
    const scenarios = (['conservative', 'standard', 'aggressive'] as const).map((key): Scenario => {
      const r = rates[key];
      const perEvent = factor.map((f, k) => Math.round(base * r ** (k + 1) * f * 10) / 10);
      const need = perEvent.reduce((a, x) => a + x, 0) + opts.reserve + (consign?.short ?? 0);
      const short = Math.ceil(need * (1 + opts.safety)) - stock;
      const print = short > 0 ? roundUp(short, lot) : 0;
      const leftover = Math.max(Math.round(stock + print - need), 0);
      return { key, perEvent, need: Math.round(need), print, leftover, leftoverCost: Math.round(leftover * (unitCost ?? 0)) };
    });
    out.push({ item: h.item, history: h, stock, base, lot, unitCost, scenarios, consign, planned, reference: h.observations.length < 2 });
  }
  return out.sort((a, b) => b.scenarios[1].print - a.scenarios[1].print || a.item.name.localeCompare(b.item.name, 'ja'));
}

export interface NewBookPlan {
  /** 材料にした新刊(初めて出したイベントでの推定需要。新しい順) */
  basis: { item: Item; eventName: string; heldOn: string; demand: number; weight: number; /** 初めて出すイベントの日数と種別にそろえた需要 */ adjusted: number }[];
  scenarios: { key: ScenarioKey; firstEvent: number; need: number; print: number }[];
  /** 初めて出すイベントとして当てはめたもの(登録してある次のイベント)。なければ null */
  debut: EventRow | null;
  reference: boolean;
}

/** 新刊を初めて出すイベント。日数と種別に、材料の需要をそろえる */
export interface DebutTarget {
  days: number;
  typeId: string | null;
}

/**
 * 次の新刊の目安(F-802、要件 §6.4)。直近3冊の、初めて出したイベントでの需要を 3:2:1 で加重平均する。
 * target を渡さなければ、登録してある次のイベントを初めて出すイベントとして、その日数と種別にそろえる(§6.2)。
 * 次のイベントの登録がなければ、そろえない
 */
export function newBookPlan(data: AnalysisData, opts: ForecastOptions, target?: DebutTarget | null): NewBookPlan | null {
  const firsts = [...data.histories.values()]
    .filter((h) => h.item.kind === 'book' && h.observations.length > 0)
    .map((h) => ({ item: h.item, obs: h.observations[0] }))
    .sort((a, b) => b.obs.heldOn.localeCompare(a.obs.heldOn))
    .slice(0, 3);
  if (firsts.length === 0) return null;
  const weights = [3, 2, 1].slice(0, firsts.length);
  const wsum = weights.reduce((a, w) => a + w, 0);
  const debut = target === undefined ? data.upcoming[0] ?? null : null;
  const to: DebutTarget | null = target ?? (debut ? { days: daysOf(debut), typeId: debut.event_type_id ?? null } : null);
  const scales = typeScales(data);
  const typeOf = new Map(data.events.map((e) => [e.id, e.event_type_id ?? null]));
  const demands = firsts.map((f) => (to
    ? (f.obs.demand / Math.max(f.obs.days, 1)) * to.days * typeScaleBetween(scales, typeOf.get(f.obs.eventId) ?? null, to.typeId)
    : f.obs.demand));
  const weighted = demands.reduce((a, d, i) => a + d * weights[i], 0) / wsum;
  const rates = decayRates(data, opts);
  // 2回目以降: 登録してあるイベントは、初めて出すイベントに比べた日数と種別の比を掛ける
  const later = Array.from({ length: opts.plannedEvents }, (_, k) => {
    const ev = k > 0 && debut ? data.upcoming[k] : undefined;
    return ev ? (daysOf(ev) / daysOf(debut!)) * typeScaleBetween(scales, debut!.event_type_id ?? null, ev.event_type_id ?? null) : 1;
  });
  const scenarioBase: Record<ScenarioKey, number> = {
    conservative: Math.min(...demands), standard: weighted, aggressive: Math.max(...demands),
  };
  const scenarios = (['conservative', 'standard', 'aggressive'] as const).map((key) => {
    const first = scenarioBase[key] * opts.expectation;
    const r = rates[key];
    const need = later.map((f, k) => first * r ** k * f).reduce((a, x) => a + x, 0) + opts.reserve;
    return { key, firstEvent: Math.round(first), need: Math.round(need), print: roundUp(Math.ceil(need * (1 + opts.safety)), 10) };
  });
  return {
    basis: firsts.map((f, i) => ({ item: f.item, eventName: f.obs.eventName, heldOn: f.obs.heldOn, demand: f.obs.demand, weight: weights[i], adjusted: Math.round(demands[i] * 10) / 10 })),
    scenarios,
    debut,
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
