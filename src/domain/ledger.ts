import type { Item, Movement, SetComponent, Txn, TxnLine } from '../db/types';

// 台帳から集計値を計算する純粋関数。db/schema.sql のビューと同じ考え方で、残数や売上は保存しない

/** 取り消されていない販売・無償出庫の取引ID */
export function activeTxnIds(txns: Txn[]): Set<string> {
  const voided = new Set(txns.filter((t) => t.type === 'void').map((t) => t.voids_txn_id));
  return new Set(txns.filter((t) => t.type !== 'void' && !voided.has(t.id)).map((t) => t.id));
}

/** 取り消された取引に結び付く在庫移動を除く */
export function validMovements(movements: Movement[], active: Set<string>): Movement[] {
  return movements.filter((m) => m.transaction_id === null || active.has(m.transaction_id));
}

export interface ItemAtEvent {
  brought: number;
  sold: number;
  given: number;
  takenBack: number;
  remaining: number;
  /** 販売・無償出庫で残数が0以下になっていれば、その最後の時刻 */
  soldOutAt: string | null;
}

const empty = (): ItemAtEvent => ({ brought: 0, sold: 0, given: 0, takenBack: 0, remaining: 0, soldOutAt: null });

/**
 * イベントの置き場所に出入りした在庫移動から、品目ごとの持ち込み・販売・残数を出す。
 * セットは構成品の残数から組める数(最小値)を残数とする
 */
export function eventItemSummary(args: {
  eventLocationId: string;
  items: Item[];
  setComponents: SetComponent[];
  movements: Movement[];
  txns: Txn[];
}): Map<string, ItemAtEvent> {
  const { eventLocationId: loc, items, setComponents, txns } = args;
  const moves = validMovements(args.movements, activeTxnIds(txns));
  const out = new Map<string, ItemAtEvent>();
  const lastOut = new Map<string, string>();

  for (const m of moves) {
    const s = out.get(m.item_id) ?? empty();
    if (m.to_location_id === loc) s.brought += m.qty;
    if (m.from_location_id === loc) {
      if (m.reason === 'sale') s.sold += m.qty;
      else if (m.reason === 'giveaway') s.given += m.qty;
      else s.takenBack += m.qty;
      if (m.reason === 'sale' || m.reason === 'giveaway') {
        const prev = lastOut.get(m.item_id);
        if (!prev || m.recorded_at > prev) lastOut.set(m.item_id, m.recorded_at);
      }
    }
    out.set(m.item_id, s);
  }

  for (const [id, s] of out) {
    s.remaining = s.brought - s.sold - s.given - s.takenBack;
    s.soldOutAt = s.brought - s.sold - s.given <= 0 ? lastOut.get(id) ?? null : null;
  }

  for (const it of items.filter((i) => i.kind === 'set')) {
    const comps = setComponents.filter((c) => c.set_item_id === it.id);
    if (comps.length === 0) continue;
    const remaining = Math.min(
      ...comps.map((c) => Math.floor((out.get(c.component_item_id)?.remaining ?? 0) / c.qty)),
    );
    out.set(it.id, { ...empty(), remaining });
  }
  return out;
}

export interface SalesTotals {
  /** 売上(受託分を含む全体) */
  amount: number;
  /** 販売部数(セットは1部と数える) */
  count: number;
  /** 持ち主ごとの売上 */
  byOwner: Map<string, number>;
}

export function salesTotals(args: { txns: Txn[]; lines: TxnLine[]; items: Item[] }): SalesTotals {
  const active = activeTxnIds(args.txns);
  const sales = new Set(args.txns.filter((t) => t.type === 'sale' && active.has(t.id)).map((t) => t.id));
  const ownerOf = new Map(args.items.map((i) => [i.id, i.owner_id]));
  const byOwner = new Map<string, number>();
  let amount = 0;
  let count = 0;
  for (const l of args.lines) {
    if (!sales.has(l.transaction_id)) continue;
    const a = l.qty * l.unit_price;
    amount += a;
    count += l.qty;
    const o = ownerOf.get(l.item_id);
    if (o) byOwner.set(o, (byOwner.get(o) ?? 0) + a);
  }
  return { amount, count, byOwner };
}

/** 直近の、まだ取り消されていない取引(取り消しボタンの対象) */
export function lastActiveTxn(txns: Txn[]): Txn | undefined {
  const active = activeTxnIds(txns);
  return txns
    .filter((t) => active.has(t.id))
    .reduce<Txn | undefined>((a, t) => (!a || t.recorded_at >= a.recorded_at ? t : a), undefined);
}

/** 置き場所ごとの現在庫 */
export function stockByLocation(movements: Movement[], txns: Txn[]): Map<string, number> {
  const out = new Map<string, number>();
  const add = (item: string, loc: string | null, d: number) => {
    if (!loc) return;
    const k = `${item}|${loc}`;
    out.set(k, (out.get(k) ?? 0) + d);
  };
  for (const m of validMovements(movements, activeTxnIds(txns))) {
    add(m.item_id, m.to_location_id, m.qty);
    add(m.item_id, m.from_location_id, -m.qty);
  }
  return out;
}

/** 頒布物別の損益分岐部数(MVPは変動費0。§6.6) */
export function breakEvenQty(fixedCost: number, price: number): number | null {
  return price > 0 ? Math.ceil(fixedCost / price) : null;
}
