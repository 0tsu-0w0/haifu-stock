import { activeTxnIds, lineAmount } from './ledger';
import { deriveEvent, type EventSnapshot } from './snapshot';

// イベント後のレポート(F-701〜703)。サマリー、品目ごとの消化率と完売時刻、30分ごとの売れ方

export const SLOT_MIN = 30;

export interface ReportItemRow {
  itemId: string;
  name: string;
  ownerName: string | null;
  isSet: boolean;
  /** 持ち込み(セットは構成品の数で決まるので null) */
  brought: number | null;
  sold: number;
  given: number;
  /** 撤収時点の残数(持ち帰る前) */
  remaining: number | null;
  soldOutAt: string | null;
  /** 消化率 = 販売 ÷ 持ち込み */
  sellThrough: number | null;
  amount: number;
}

export interface ReportSlot {
  /** 枠の始まり(ISO) */
  start: string;
  amount: number;
  qty: number;
  txns: number;
}

export interface EventReport {
  amount: number;
  qty: number;
  txnCount: number;
  /** 客単価 = 売上 ÷ 取引件数 */
  perCustomer: number | null;
  discount: number;
  rows: ReportItemRow[];
  slots: ReportSlot[];
  soldOuts: { name: string; at: string }[];
}

export function eventReport(s: EventSnapshot): EventReport {
  const { summary, itemById, ownerById } = deriveEvent(s);
  const active = activeTxnIds(s.txns);
  const sales = s.txns.filter((t) => t.type === 'sale' && active.has(t.id));
  const saleIds = new Set(sales.map((t) => t.id));
  const lines = s.lines.filter((l) => saleIds.has(l.transaction_id));

  const byItem = new Map<string, { qty: number; amount: number }>();
  for (const l of lines) {
    const x = byItem.get(l.item_id) ?? { qty: 0, amount: 0 };
    byItem.set(l.item_id, { qty: x.qty + l.qty, amount: x.amount + lineAmount(l) });
  }
  const amount = lines.reduce((a, l) => a + lineAmount(l), 0);
  const qty = lines.reduce((a, l) => a + l.qty, 0);
  const discount = lines.reduce((a, l) => a + (l.discount ?? 0), 0);

  const rows: ReportItemRow[] = s.allEventItems
    .filter((e) => !e.removed_at || byItem.has(e.item_id))
    .map((e) => {
      const item = itemById.get(e.item_id);
      if (!item) return null;
      const owner = ownerById.get(item.owner_id);
      const sm = summary.get(item.id);
      const isSet = item.kind === 'set';
      const brought = isSet ? null : sm?.brought ?? 0;
      const soldQty = byItem.get(item.id)?.qty ?? 0;
      return {
        itemId: item.id,
        name: item.name,
        ownerName: owner && !owner.is_self ? owner.name : null,
        isSet,
        brought,
        // セットの構成品は在庫移動で販売に数えられるので、品目の行では在庫移動の数(セット分を含む)を出す
        sold: isSet ? soldQty : sm?.sold ?? 0,
        given: isSet ? 0 : sm?.given ?? 0,
        remaining: isSet ? null : (sm?.remaining ?? 0) + (sm?.takenBack ?? 0),
        soldOutAt: isSet ? null : sm?.soldOutAt ?? null,
        sellThrough: brought ? (sm?.sold ?? 0) / brought : null,
        amount: byItem.get(item.id)?.amount ?? 0,
      } satisfies ReportItemRow;
    })
    .filter((r): r is ReportItemRow => r !== null);

  // 30分ごと。開始時刻があればそこから、なければ最初の販売の30分区切りから
  const slots: ReportSlot[] = [];
  if (sales.length > 0) {
    const ms = SLOT_MIN * 60_000;
    const times = sales.map((t) => Date.parse(t.recorded_at));
    const first = Math.min(...times);
    const start = s.event.starts_at && Date.parse(s.event.starts_at) <= first
      ? Date.parse(s.event.starts_at)
      : Math.floor(first / ms) * ms;
    const n = Math.floor((Math.max(...times) - start) / ms) + 1;
    for (let i = 0; i < n; i++) slots.push({ start: new Date(start + i * ms).toISOString(), amount: 0, qty: 0, txns: 0 });
    const linesByTxn = new Map<string, typeof lines>();
    for (const l of lines) linesByTxn.set(l.transaction_id, [...(linesByTxn.get(l.transaction_id) ?? []), l]);
    for (const t of sales) {
      const slot = slots[Math.floor((Date.parse(t.recorded_at) - start) / ms)];
      const ls = linesByTxn.get(t.id) ?? [];
      slot.amount += ls.reduce((a, l) => a + lineAmount(l), 0);
      slot.qty += ls.reduce((a, l) => a + l.qty, 0);
      slot.txns += 1;
    }
  }

  return {
    amount, qty, txnCount: sales.length,
    perCustomer: sales.length ? Math.round(amount / sales.length) : null,
    discount, rows, slots,
    soldOuts: rows.filter((r) => r.soldOutAt).map((r) => ({ name: r.name, at: r.soldOutAt! }))
      .sort((a, b) => a.at.localeCompare(b.at)),
  };
}

export interface ProfitPoint {
  at: string;
  /** その時点までの収支(粗利 + 受託手数料 − 経費) */
  value: number;
}

export interface ProfitTimeline {
  /** 固定費(経費) */
  fixed: number;
  points: ProfitPoint[];
  /** 黒字になった時刻(経費を超えた最初の販売)。まだなら null */
  blackAt: string | null;
  /** いまの収支 */
  current: number;
}

/**
 * 当日の時刻ごとの収支(F-1104)。経費のぶんマイナスから始め、販売のたびに
 * 自分の分は「売上 − 原価」、受託分は「売上 × 手数料率」だけ増える。0 を超えた時刻が黒字化の時刻
 */
export function profitTimeline(s: EventSnapshot): ProfitTimeline {
  const { itemById, ownerById } = deriveEvent(s);
  const unitCost = (id: string) => {
    const runs = s.printRuns.filter((p) => p.item_id === id);
    const qty = runs.reduce((a, p) => a + p.qty, 0);
    return qty ? runs.reduce((a, p) => a + p.total_cost, 0) / qty : 0;
  };
  const fixed = s.expenses.reduce((a, e) => a + (e.actual_amount ?? e.planned_amount ?? 0), 0);
  const active = activeTxnIds(s.txns);
  const sales = s.txns.filter((t) => t.type === 'sale' && active.has(t.id)).sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  const linesByTxn = new Map<string, typeof s.lines>();
  for (const l of s.lines) linesByTxn.set(l.transaction_id, [...(linesByTxn.get(l.transaction_id) ?? []), l]);

  // 開始時刻は入力された形のまま保存されているので、時刻として比べてから ISO にそろえる
  const startMs = s.event.starts_at ? Date.parse(s.event.starts_at) : NaN;
  const startIso = !Number.isNaN(startMs) && (!sales[0] || startMs <= Date.parse(sales[0].recorded_at))
    ? new Date(startMs).toISOString()
    : sales[0]?.recorded_at;
  let value = -fixed;
  const points: ProfitPoint[] = startIso ? [{ at: startIso, value }] : [];
  let blackAt: string | null = fixed === 0 && sales[0] ? sales[0].recorded_at : null;
  for (const t of sales) {
    for (const l of linesByTxn.get(t.id) ?? []) {
      const item = itemById.get(l.item_id);
      const owner = item && ownerById.get(item.owner_id);
      if (!item || !owner) continue;
      if (!owner.is_self) {
        value += lineAmount(l) * owner.default_fee_rate;
        continue;
      }
      const parts = item.kind === 'set'
        ? s.setComponents.filter((c) => c.set_item_id === item.id).map((c) => [c.component_item_id, c.qty * l.qty] as const)
        : [[item.id, l.qty] as const];
      value += lineAmount(l) - parts.reduce((a, [id, q]) => a + q * unitCost(id), 0);
    }
    points.push({ at: t.recorded_at, value: Math.round(value) });
    if (!blackAt && value >= 0) blackAt = t.recorded_at;
  }
  return { fixed, points, blackAt, current: Math.round(value) };
}

export interface DeviceRow {
  deviceId: string;
  sales: number;
  qty: number;
  amount: number;
  giveaways: number;
  /** その端末で取り消した件数 */
  voids: number;
  lastAt: string | null;
}

/** 記録した端末(誰が売ったか)ごとの内訳(F-710)。取り消された販売は、販売に数えない */
export function deviceBreakdown(s: EventSnapshot): DeviceRow[] {
  const active = activeTxnIds(s.txns);
  const rows = new Map<string, DeviceRow>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) rows.set(id, (r = { deviceId: id, sales: 0, qty: 0, amount: 0, giveaways: 0, voids: 0, lastAt: null }));
    return r;
  };
  const linesByTxn = new Map<string, typeof s.lines>();
  for (const l of s.lines) linesByTxn.set(l.transaction_id, [...(linesByTxn.get(l.transaction_id) ?? []), l]);
  for (const t of s.txns) {
    const r = row(t.device_id);
    if (!r.lastAt || t.recorded_at > r.lastAt) r.lastAt = t.recorded_at;
    if (t.type === 'void') r.voids++;
    if (!active.has(t.id)) continue;
    if (t.type === 'giveaway') r.giveaways++;
    if (t.type !== 'sale') continue;
    const ls = linesByTxn.get(t.id) ?? [];
    r.sales++;
    r.qty += ls.reduce((a, l) => a + l.qty, 0);
    r.amount += ls.reduce((a, l) => a + lineAmount(l), 0);
  }
  return [...rows.values()].sort((a, b) => b.amount - a.amount);
}

/** 集計の範囲(F-708)。全体(受託分を含む)/ 自分の分だけ / 受託元1つ */
export type ReportScope = 'all' | 'self' | { ownerId: string };

export const scopeKey = (s: ReportScope) => (typeof s === 'string' ? s : s.ownerId);

/**
 * 範囲に入る品目の記録だけを残したスナップショットを作る。持ち主はいまの品目の持ち主で決めるので、
 * 持ち主を付け替える(F-709)と、過去のイベントもそのまま新しい持ち主で集計される
 */
export function scopeSnapshot(s: EventSnapshot, scope: ReportScope): EventSnapshot {
  if (scope === 'all') return s;
  const selfIds = new Set(s.owners.filter((o) => o.is_self).map((o) => o.id));
  const inScope = (ownerId: string) => (scope === 'self' ? selfIds.has(ownerId) : ownerId === scope.ownerId);
  const itemIds = new Set(s.items.filter((i) => inScope(i.owner_id)).map((i) => i.id));
  const lines = s.lines.filter((l) => itemIds.has(l.item_id));
  const withLines = new Set(lines.map((l) => l.transaction_id));
  const kept = new Set(s.txns.filter((t) => t.type !== 'void' && withLines.has(t.id)).map((t) => t.id));
  return {
    ...s,
    lines,
    txns: s.txns.filter((t) => kept.has(t.id) || (t.type === 'void' && !!t.voids_txn_id && kept.has(t.voids_txn_id))),
    movements: s.movements.filter((m) => itemIds.has(m.item_id)),
    eventItems: s.eventItems.filter((e) => itemIds.has(e.item_id)),
    allEventItems: s.allEventItems.filter((e) => itemIds.has(e.item_id)),
  };
}

export interface OwnerRow {
  ownerId: string;
  name: string;
  isSelf: boolean;
  qty: number;
  amount: number;
  /** 受託手数料(自分の分は 0) */
  fee: number;
}

/** 持ち主ごとの売上(F-708 の「持ち主別」)。売上のない受託元は出さない */
export function ownerBreakdown(s: EventSnapshot): OwnerRow[] {
  const { itemById, ownerById } = deriveEvent(s);
  const active = activeTxnIds(s.txns);
  const saleIds = new Set(s.txns.filter((t) => t.type === 'sale' && active.has(t.id)).map((t) => t.id));
  const rows = new Map<string, OwnerRow>();
  for (const l of s.lines) {
    if (!saleIds.has(l.transaction_id)) continue;
    const owner = ownerById.get(itemById.get(l.item_id)?.owner_id ?? '');
    if (!owner) continue;
    const r = rows.get(owner.id) ?? { ownerId: owner.id, name: owner.is_self ? '自分' : owner.name, isSelf: owner.is_self, qty: 0, amount: 0, fee: 0 };
    r.qty += l.qty;
    r.amount += lineAmount(l);
    rows.set(owner.id, r);
  }
  for (const r of rows.values()) if (!r.isSelf) r.fee = Math.round(r.amount * (ownerById.get(r.ownerId)?.default_fee_rate ?? 0));
  return [...rows.values()].sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || b.amount - a.amount);
}
