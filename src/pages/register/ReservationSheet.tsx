import type { Item, Reservation } from '../../db/types';
import { yen } from '../../lib/format';

/** レジの「取り置き」(#11)。渡したら「渡した」で販売として記録する */
export function ReservationSheet(props: {
  reservations: Reservation[];
  itemById: Map<string, Item>;
  priceOf: (item: Item) => number;
  onHand: (r: Reservation, item: Item) => void;
  onClose: () => void;
}) {
  const { reservations, itemById, priceOf, onHand, onClose } = props;
  const held = reservations.filter((r) => r.status === 'held');
  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="取り置き">
        <div className="grab" />
        <h2>取り置き</h2>
        <p className="sub">渡したら「渡した」を押すと、販売として記録します(イベント価格)。</p>
        {held.length === 0 && <p className="note">取り置き中のものはありません。</p>}
        {held.map((r) => {
          const it = itemById.get(r.item_id);
          return (
            <div className="rowx resv-row" key={r.id}>
              <span><b>{r.name}</b><small className="k">{it?.name ?? '不明な品目'} ×{r.qty}</small></span>
              <button className="sbtn acc" onClick={() => it && onHand(r, it)}>渡した {it ? yen(priceOf(it) * r.qty) : ''}</button>
            </div>
          );
        })}
        <button className="cancel" onClick={onClose}>閉じる</button>
      </div>
    </div>
  );
}
