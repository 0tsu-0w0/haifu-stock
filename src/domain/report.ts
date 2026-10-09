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
