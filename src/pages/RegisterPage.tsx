import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { db } from '../app/db';
import { useCtx } from '../app/useCtx';
import { SyncPill } from '../components/SyncPill';
import { useToast } from '../components/Toast';
import type { GiveawayKind, Item, Txn } from '../db/types';
import { recordGiveaway, recordSale, voidTransaction } from '../domain/record';
import { hhmm, yen } from '../lib/format';
import { useEventData } from './useEventData';

const LONG_PRESS_MS = 550;
const GIVE_LABEL: Record<GiveawayKind, string> = { sample: '見本誌', gift: '献本', damage: '汚損・破損', lost: '紛失' };

// レジ画面(F-401〜406a)。タップで即1部記録、長押しでメニュー。
// カートモード・履歴・終了処理は prototype/register.html の動きをこの土台に移していく
export function RegisterPage() {
  const { eventId = '' } = useParams();
  const ctx = useCtx();
  const data = useEventData(eventId);
  const toast = useToast();
  const [sheetItem, setSheetItem] = useState<Item | null>(null);
  const press = useRef<{ id: string; x: number; y: number; timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);
  const [pressing, setPressing] = useState<string | null>(null);

  if (data === undefined || ctx === undefined) return <main className="page" />;
  if (data === null || ctx === null) {
    return (
      <main className="page">
        <p>イベントが見つかりません。</p>
        <Link to="/">ホームに戻る</Link>
      </main>
    );
  }

  const { event, eventItems, itemById, ownerById, summary, totals, float, last, linesByTxn } = data;

  const describe = (t: Txn) => {
    const names = (linesByTxn.get(t.id) ?? [])
      .map((l) => `${itemById.get(l.item_id)?.name ?? '?'}${l.qty > 1 ? ` ×${l.qty}` : ''}`)
      .join('・');
    return t.type === 'giveaway' ? `${GIVE_LABEL[t.giveaway_kind!]}: ${names}` : names;
  };

  const vibrate = (ms: number) => {
    try {
      navigator.vibrate?.(ms);
    } catch {
      /* 振動できない端末は無視 */
    }
  };

  async function undoable(p: Promise<Txn>, message: string) {
    try {
      const t = await p;
      vibrate(12);
      toast(message, {
        label: '元に戻す',
        run: () => void voidTransaction(db, ctx!, t.id).then(() => toast('取り消しました')),
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  }

  function tap(item: Item) {
    if ((summary.get(item.id)?.remaining ?? 0) <= 0) {
      toast('完売です。長押しで記録できます');
      return;
    }
    void undoable(
      recordSale(db, ctx!, { eventId, lines: [{ itemId: item.id, qty: 1 }] }),
      `${item.name} を記録 ${yen(priceOf(item))}`,
    );
  }

  const priceOf = (item: Item) => eventItems.find((e) => e.item_id === item.id)?.price_override ?? item.price;

  const onDown = (e: RPointerEvent, item: Item) => {
    if (e.button > 0) return;
    const timer = setTimeout(() => {
      if (!press.current) return;
      press.current.fired = true;
      setPressing(null);
      vibrate(25);
      setSheetItem(item);
    }, LONG_PRESS_MS);
    press.current = { id: item.id, x: e.clientX, y: e.clientY, timer, fired: false };
    setPressing(item.id);
  };
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
    setPressing(null);
  };
  const onMove = (e: RPointerEvent) => {
    if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 10) cancel();
  };
  const onUp = (item: Item) => {
    const p = press.current;
    cancel();
    if (p && !p.fired) tap(item);
  };

  return (
    <div className="register">
      <header className="top">
        <div className="bar">
          <Link className="ev" to="/">
            <b>{event.name}</b>
            <span>{event.space_no ?? event.held_on}</span>
          </Link>
          <SyncPill />
        </div>
        <div className="sum">
          <div><small>売上</small><strong className="num">{yen(totals.amount)}</strong></div>
          <div><small>部数</small><strong className="num">{totals.count}</strong></div>
          <div><small>現金(理論)</small><strong className="num">{yen(float + totals.amount)}</strong></div>
        </div>
        <div className="mode"><span>タップで1部記録・長押しでメニュー</span><span>{eventItems.length}品目</span></div>
      </header>

      <main className="grid-wrap">
        <div className="grid" onContextMenu={(e) => e.preventDefault()}>
          {eventItems.map((ei) => {
            const item = itemById.get(ei.item_id);
            if (!item) return null;
            const s = summary.get(item.id);
            const r = s?.remaining ?? 0;
            const owner = ownerById.get(item.owner_id);
            const state = r < 0 ? 'out neg' : r === 0 ? 'out' : r <= item.low_threshold ? 'low' : '';
            const remText = r < 0 ? `残 −${-r}` : r === 0 ? (s?.soldOutAt ? `完売 ${hhmm(s.soldOutAt)}` : '完売') : `残${r}`;
            return (
              <button
                key={item.id}
                className={`item ${state}${pressing === item.id ? ' pressing' : ''}`}
                aria-label={`${item.name} ${priceOf(item)}円 ${r <= 0 ? '完売' : `残り${r}`}${owner && !owner.is_self ? ` 受託 ${owner.name}` : ''}`}
                onPointerDown={(e) => onDown(e, item)}
                onPointerMove={onMove}
                onPointerUp={() => onUp(item)}
                onPointerCancel={cancel}
                onPointerLeave={cancel}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.shiftKey) {
                    e.preventDefault();
                    setSheetItem(item);
                  } else if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    tap(item);
                  }
                }}
              >
                <span className="nm">{item.name}</span>
                {owner && !owner.is_self && <span className="tag">受託: {owner.name}</span>}
                <span className="meta">
                  <span className="price num">{yen(priceOf(item))}</span>
                  <span className="rem num">{remText}</span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="hint">完売の品目はタップでは記録しません。長押しすると「販売を記録(残数0)」を選べます。</p>
      </main>

      <footer className="foot">
        <button
          className="fbtn"
          onClick={async () => {
            if (!last) return toast('取り消す記録がありません');
            await voidTransaction(db, ctx, last.id);
            toast(`取り消し: ${describe(last)}`);
          }}
        >
          取り消し<small>{last ? describe(last) : '記録なし'}</small>
        </button>
        <button className="fbtn" onClick={() => toast('カートモードは次の段階で追加します')}>
          カート<small>まとめ買い</small>
        </button>
      </footer>

      {sheetItem && (
        <ItemSheet
          item={sheetItem}
          remaining={summary.get(sheetItem.id)?.remaining ?? 0}
          price={priceOf(sheetItem)}
          onClose={() => setSheetItem(null)}
          onSale={(qty, zero) =>
            undoable(
              recordSale(db, ctx, { eventId, lines: [{ itemId: sheetItem.id, qty }], zeroStockOverride: zero }),
              `${sheetItem.name}${qty > 1 ? ` ×${qty}` : ''} を記録${zero ? '(残数0)' : ''}`,
            )
          }
          onGive={(qty, kind) =>
            undoable(
              recordGiveaway(db, ctx, { eventId, itemId: sheetItem.id, qty, kind }),
              `${GIVE_LABEL[kind]}: ${sheetItem.name}${qty > 1 ? ` ×${qty}` : ''}`,
            )
          }
        />
      )}
    </div>
  );
}

type Choice = 'sale' | 'zero' | GiveawayKind;

function ItemSheet(props: {
  item: Item;
  remaining: number;
  price: number;
  onClose: () => void;
  onSale: (qty: number, zero: boolean) => void;
  onGive: (qty: number, kind: GiveawayKind) => void;
}) {
  const { item, remaining, price } = props;
  const soldOut = remaining <= 0;
  const [choice, setChoice] = useState<Choice>(soldOut ? 'zero' : item.kind === 'set' ? 'sale' : 'sample');
  const [qty, setQty] = useState(1);
  const options: [Choice, string][] = [
    soldOut ? ['zero', '販売を記録(残数0)'] : ['sale', '販売を記録(部数を指定)'],
    ...(item.kind === 'set' ? [] : (['sample', 'gift', 'damage'] as const).map((k): [Choice, string] => [k, GIVE_LABEL[k]])),
  ];
  const isSale = choice === 'sale' || choice === 'zero';

  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={`${item.name}のメニュー`}>
        <div className="grab" />
        <h2>{item.name}</h2>
        <p className="sub">{soldOut ? '残数0' : `残り ${remaining}`}・{yen(price)}</p>
        {options.map(([k, label]) => (
          <div key={k}>
            <button className={`opt${k === 'zero' ? ' warn' : ''}`} aria-pressed={choice === k} onClick={() => setChoice(k)}>
              {label}
            </button>
            {k === 'zero' && <p className="warnnote">残数がマイナスになります。終了処理で持ち込み数を確認できます。</p>}
          </div>
        ))}
        <div className="qrow">
          <span>部数</span>
          <span className="qty">
            <button aria-label="1部減らす" onClick={() => setQty((q) => Math.max(1, q - 1))}>−</button>
            <span className="num">{qty}</span>
            <button aria-label="1部増やす" onClick={() => setQty((q) => Math.min(99, q + 1))}>+</button>
          </span>
        </div>
        <button
          className="go"
          onClick={() => {
            props.onClose();
            if (isSale) props.onSale(qty, choice === 'zero');
            else props.onGive(qty, choice as GiveawayKind);
          }}
        >
          {isSale ? `記録する ${yen(price * qty)}` : `${GIVE_LABEL[choice as GiveawayKind]}として記録`}
        </button>
        <button className="cancel" onClick={props.onClose}>キャンセル</button>
      </div>
    </div>
  );
}
