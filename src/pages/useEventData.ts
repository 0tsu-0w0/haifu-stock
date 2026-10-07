import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { db } from '../app/db';
import { eventItemSummary, lastActiveTxn, salesTotals } from '../domain/ledger';

/** レジに必要なものを端末のデータベースから読み、記録のたびに自動で更新する */
export function useEventData(eventId: string) {
  const raw = useLiveQuery(async () => {
    const event = await db.events.get(eventId);
    if (!event) return null;
    const location = await db.locations.where('event_id').equals(eventId).first();
    const [eventItems, items, owners, setComponents, txns, movements, cash] = await Promise.all([
      db.event_items.where('event_id').equals(eventId).sortBy('sort_order'),
      db.items.where('circle_id').equals(event.circle_id).toArray(),
      db.owners.where('circle_id').equals(event.circle_id).toArray(),
      db.set_components.toArray(),
      db.transactions.where('event_id').equals(eventId).toArray(),
      db.stock_movements.where('event_id').equals(eventId).toArray(),
      db.cash_counts.where('event_id').equals(eventId).toArray(),
    ]);
    const lines = await db.transaction_lines.where('transaction_id').anyOf(txns.map((t) => t.id)).toArray();
    return { event, location, eventItems, items, owners, setComponents, txns, movements, lines, cash };
  }, [eventId]);

  return useMemo(() => {
    if (!raw) return raw;
    const { location, items, setComponents, movements, txns, lines, cash } = raw;
    const summary = location
      ? eventItemSummary({ eventLocationId: location.id, items, setComponents, movements, txns })
      : new Map();
    const totals = salesTotals({ txns, lines, items });
    const float = cash.filter((c) => c.phase === 'float').reduce((s, c) => s + c.denomination * c.count, 0);
    const itemById = new Map(items.map((i) => [i.id, i]));
    const ownerById = new Map(raw.owners.map((o) => [o.id, o]));
    const linesByTxn = new Map<string, typeof lines>();
    for (const l of lines) linesByTxn.set(l.transaction_id, [...(linesByTxn.get(l.transaction_id) ?? []), l]);
    return { ...raw, summary, totals, float, itemById, ownerById, linesByTxn, last: lastActiveTxn(txns) };
  }, [raw]);
}
