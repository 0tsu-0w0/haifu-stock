import { putAndQueue, type HaifuDB } from '../db/local';
import type { PaymentMethod, Reservation, ReservationStatus, Txn } from '../db/types';
import { uuidv7 } from '../lib/uuid';
import { assertOpen } from './closing';
import { activeTxnIds } from './ledger';
import { LEDGER_TABLES, READ_TABLES, recordSale, type Ctx } from './record';

// 取り置き(Issue #11)。事前に頼まれた分を、レジで売れる部数から除いておく。
// 在庫は動かさず「売れない印」として持ち、当日に渡したら販売として記録する

const stamp = () => new Date().toISOString();

/** 渡したときの販売を取り消していたら、取り置き中に戻ったものとして扱う */
export function statusOf(r: Reservation, active: Set<string>): ReservationStatus {
  if (r.status === 'handed' && r.transaction_id && !active.has(r.transaction_id)) return 'held';
  return r.status;
}

/** 品目ごとの、取り置き中の部数 */
export function heldByItem(reservations: Reservation[], txns: Txn[]): Map<string, number> {
  const active = activeTxnIds(txns);
  const out = new Map<string, number>();
  for (const r of reservations) {
    if (statusOf(r, active) !== 'held') continue;
    out.set(r.item_id, (out.get(r.item_id) ?? 0) + r.qty);
  }
  return out;
}

export async function saveReservation(
  db: HaifuDB, ctx: Ctx, input: { id?: string; eventId: string; itemId: string; qty: number; name: string },
): Promise<Reservation> {
  const name = input.name.trim();
  if (!name) throw new Error('頼んだ人の名前(呼び名やメモ)を入れてください');
  if (name.length > 50) throw new Error('名前は50文字までにしてください');
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new Error('部数は1以上で入れてください');
  return db.transaction('rw', ['reservations', 'items', 'event_closings', 'outbox'], async () => {
    await assertOpen(db, input.eventId);
    const item = await db.items.get(input.itemId);
    if (!item) throw new Error('品目が見つかりません');
    if (item.kind === 'set') throw new Error('セットは取り置きできません。中身の品目ごとに入れてください');
    const cur = input.id ? await db.reservations.get(input.id) : undefined;
    if (cur && cur.status !== 'held') throw new Error('渡した・取り消した取り置きは変えられません');
    const r: Reservation = {
      id: cur?.id ?? uuidv7(), circle_id: ctx.circleId, event_id: input.eventId, item_id: input.itemId, qty: input.qty,
      name, status: 'held', transaction_id: null, client_updated_at: stamp(),
    };
    await putAndQueue(db, 'reservations', r);
    return r;
  });
}

/** 取り置きを取り消す(来なかった・頼まれなくなった)。部数はレジで売れる分に戻る */
export async function cancelReservation(db: HaifuDB, id: string): Promise<void> {
  await db.transaction('rw', ['reservations', 'event_closings', 'outbox'], async () => {
    const r = await db.reservations.get(id);
    if (!r) throw new Error('取り置きが見つかりません');
    await assertOpen(db, r.event_id);
    await putAndQueue(db, 'reservations', { ...r, status: 'cancelled', client_updated_at: stamp() });
  });
}

/** 渡した。販売として記録し、取り置きを「渡した」にする。販売を取り消すと、取り置き中に戻る */
export async function handReservation(
  db: HaifuDB, ctx: Ctx, id: string, opts: { paidAmount?: number | null; paymentMethod?: PaymentMethod } = {},
): Promise<Txn> {
  return db.transaction('rw', [...LEDGER_TABLES, ...READ_TABLES, 'reservations'], async () => {
    const r = await db.reservations.get(id);
    if (!r) throw new Error('取り置きが見つかりません');
    const active = activeTxnIds(await db.transactions.where('event_id').equals(r.event_id).toArray());
    if (statusOf(r, active) !== 'held') throw new Error('この取り置きは、もう渡したか取り消しています');
    const t = await recordSale(db, ctx, {
      eventId: r.event_id, lines: [{ itemId: r.item_id, qty: r.qty }], paidAmount: opts.paidAmount ?? null,
      paymentMethod: opts.paymentMethod,
    });
    await putAndQueue(db, 'reservations', { ...r, status: 'handed', transaction_id: t.id, client_updated_at: stamp() });
    return t;
  });
}
