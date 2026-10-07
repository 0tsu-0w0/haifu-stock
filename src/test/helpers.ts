import { HaifuDB } from '../db/local';
import { eventItemSummary, salesTotals } from '../domain/ledger';
import { eventLocationId } from '../domain/record';

let n = 0;
export const freshDb = (label = 'test') => new HaifuDB(`${label}-${Date.now()}-${n++}`);

/** レジ画面と同じ材料で、イベントの集計を出す */
export async function eventState(db: HaifuDB, eventId: string) {
  const loc = await eventLocationId(db, eventId);
  const items = await db.items.toArray();
  const txns = await db.transactions.where('event_id').equals(eventId).toArray();
  const lines = await db.transaction_lines.where('transaction_id').anyOf(txns.map((t) => t.id)).toArray();
  const movements = await db.stock_movements.where('event_id').equals(eventId).toArray();
  const setComponents = await db.set_components.toArray();
  const summary = eventItemSummary({ eventLocationId: loc, items, setComponents, movements, txns });
  const byName = (name: string) => summary.get(items.find((i) => i.name === name)!.id)!;
  return { items, txns, summary, byName, totals: salesTotals({ txns, lines, items }) };
}

export const itemId = async (db: HaifuDB, name: string) => (await db.items.filter((i) => i.name === name).first())!.id;
