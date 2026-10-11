import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db } from '../app/db';
import type { Item, Reservation } from '../db/types';
import { activeTxnIds } from '../domain/ledger';
import type { Ctx } from '../domain/record';
import { cancelReservation, saveReservation, statusOf } from '../domain/reservations';
import { useToast } from './Toast';

/** イベントの取り置きと、その状態(渡した販売を取り消したものは取り置き中に戻る) */
export function useReservations(eventId: string) {
  return useLiveQuery(async () => {
    const [rs, txns] = await Promise.all([
      db.reservations.where('event_id').equals(eventId).toArray(),
      db.transactions.where('event_id').equals(eventId).toArray(),
    ]);
    const active = activeTxnIds(txns);
    return rs
      .map((r) => ({ ...r, status: statusOf(r, active) }) as Reservation)
      .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  }, [eventId]);
}

/** 準備画面の「取り置き」(Issue #11)。頼まれた分を入れておくと、レジで売れる部数から除く */
export function ReservationsCard(props: { ctx: Ctx; eventId: string; items: Item[]; locked: boolean; remaining: (itemId: string) => number }) {
  const { ctx, eventId, items, locked, remaining } = props;
  const toast = useToast();
  const list = useReservations(eventId) ?? [];
  const [form, setForm] = useState({ name: '', itemId: '', qty: '1' });
  const held = list.filter((r) => r.status === 'held');
  const done = list.filter((r) => r.status !== 'held');
  const name = (id: string) => items.find((i) => i.id === id)?.name ?? '不明な品目';
  const itemId = form.itemId || items[0]?.id || '';
  const heldOf = (id: string) => held.filter((r) => r.item_id === id).reduce((a, r) => a + r.qty, 0);
  const over = itemId ? heldOf(itemId) + Number(form.qty || 0) > remaining(itemId) && remaining(itemId) > 0 : false;

  return (
    <div className="card">
      {held.length === 0 && <span className="k">まだありません。事前に頼まれた分を入れると、レジで売れる部数から除いておけます。</span>}
      {held.map((r) => (
        <div className="rowx resv-row" key={r.id}>
          <span><b>{r.name}</b><small className="k">{name(r.item_id)} ×{r.qty}</small></span>
          {!locked && (
            <button type="button" className="link-btn" onClick={() => void cancelReservation(db, r.id).then(() => toast(`${r.name} の取り置きを取り消しました`), (e: Error) => toast(e.message))}>取り消す</button>
          )}
        </div>
      ))}
      {done.length > 0 && (
        <details>
          <summary className="k">渡した・取り消した {done.length}件</summary>
          {done.map((r) => (
            <div className="rowx resv-row done" key={r.id}>
              <span>{r.name}<small className="k">{name(r.item_id)} ×{r.qty}</small></span>
              <span className="k">{r.status === 'handed' ? '渡した' : '取り消し'}</span>
            </div>
          ))}
        </details>
      )}
      {!locked && items.length > 0 && (
        <form
          className="resv-add"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await saveReservation(db, ctx, { eventId, itemId, qty: Number(form.qty), name: form.name });
              toast(`${form.name.trim()} の取り置きを入れました`);
              setForm({ ...form, name: '', qty: '1' });
            } catch (err) {
              toast(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          <input aria-label="頼んだ人" placeholder="頼んだ人(呼び名・メモ)" value={form.name} maxLength={50} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <div className="resv-add-row">
            <select aria-label="品目" value={itemId} onChange={(e) => setForm({ ...form, itemId: e.target.value })}>
              {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
            <input aria-label="部数" inputMode="numeric" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value.replace(/\D/g, '') })} />
            <button className="sbtn" disabled={!form.name.trim() || !Number(form.qty)}>追加</button>
          </div>
          {over && <p className="warnnote">取り置きが、持ち込む部数({remaining(itemId)}部)を超えます。</p>}
        </form>
      )}
      <p className="note">取り置きの分は、レジで売れる残り部数から除きます(在庫の数は変わりません)。当日はレジの「取り置き」から、渡したことを記録します。</p>
    </div>
  );
}
