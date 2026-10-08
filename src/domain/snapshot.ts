import type { HaifuDB } from '../db/local';
import type { EventClosing, Item, Txn } from '../db/types';
import { eventItemSummary, lastActiveTxn, salesTotals } from './ledger';

// 1つのイベントに関わるデータをまとめて読み、集計する。レジと終了処理とテストで同じものを使う

export async function loadEventSnapshot(db: HaifuDB, eventId: string) {
  const event = await db.events.get(eventId);
  if (!event) return null;
  const c = event.circle_id;
  const [location, storages, allEventItems, items, owners, setComponents, txns, movements, cash, closingCounts, closings, expenses, printRuns] =
    await Promise.all([
      db.locations.where('event_id').equals(eventId).first(),
      db.locations.where('circle_id').equals(c).filter((l) => l.kind === 'storage' && !l.archived_at).toArray(),
      db.event_items.where('event_id').equals(eventId).sortBy('sort_order'),
      db.items.where('circle_id').equals(c).toArray(),
      db.owners.where('circle_id').equals(c).toArray(),
      db.set_components.toArray(),
      db.transactions.where('event_id').equals(eventId).toArray(),
      db.stock_movements.where('event_id').equals(eventId).toArray(),
      db.cash_counts.where('event_id').equals(eventId).toArray(),
      db.closing_counts.where('event_id').equals(eventId).toArray(),
      db.event_closings.where('event_id').equals(eventId).toArray(),
      db.expenses.where('event_id').equals(eventId).toArray(),
      db.print_runs.toArray(),
    ]);
  const lines = await db.transaction_lines.where('transaction_id').anyOf(txns.map((t) => t.id)).toArray();
  return {
    event, location, storages, items,
    /** レジに並べる品目(イベントから外したものを除く) */
    eventItems: allEventItems.filter((e) => !e.removed_at),
    /** 外したものも含む(終了処理で在庫が残っていないか確かめるため) */
    allEventItems, owners, setComponents, txns, movements, lines,
    cash, closingCounts, expenses, printRuns,
    closing: closings.find((x) => !x.reopened_at) ?? null as EventClosing | null,
  };
}

export type EventSnapshot = NonNullable<Awaited<ReturnType<typeof loadEventSnapshot>>>;

export function deriveEvent(s: EventSnapshot) {
  const summary = s.location
    ? eventItemSummary({ eventLocationId: s.location.id, items: s.items, setComponents: s.setComponents, movements: s.movements, txns: s.txns })
    : new Map();
  const totals = salesTotals({ txns: s.txns, lines: s.lines, items: s.items });
  const sumCash = (phase: 'float' | 'close') =>
    s.cash.filter((c) => c.phase === phase).reduce((a, c) => a + c.denomination * c.count, 0);
  const itemById = new Map(s.items.map((i) => [i.id, i]));
  const ownerById = new Map(s.owners.map((o) => [o.id, o]));
  const linesByTxn = new Map<string, typeof s.lines>();
  for (const l of s.lines) linesByTxn.set(l.transaction_id, [...(linesByTxn.get(l.transaction_id) ?? []), l]);
  const priceOf = (item: Item) => s.allEventItems.find((e) => e.item_id === item.id)?.price_override ?? item.price;
  return {
    summary, totals, itemById, ownerById, linesByTxn, priceOf,
    float: sumCash('float'),
    counted: sumCash('close'),
    last: lastActiveTxn(s.txns) as Txn | undefined,
  };
}
