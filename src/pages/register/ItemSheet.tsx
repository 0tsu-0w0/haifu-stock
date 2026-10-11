import { useState } from 'react';
import type { GiveawayKind, Item } from '../../db/types';
import { GIVE_LABEL } from '../../domain/history';
import { yen } from '../../lib/format';
import { DISCOUNT_REASONS, MANY_QTY } from './constants';

type Choice = 'sale' | 'zero' | 'discount' | GiveawayKind;

/** 品目を長押ししたときのメニュー(部数の指定、値引きして記録、見本誌など) */
export function ItemSheet(props: {
  item: Item;
  remaining: number;
  price: number;
  inCart: boolean;
  /** カートに品目が入っている(このときは、値引きはカートの「値引き・金額を変える」で行う) */
  cartBusy: boolean;
  onClose: () => void;
  onSale: (qty: number, zero: boolean) => void;
  onDiscount: (qty: number, pay: number, reason: string) => void;
  onGive: (qty: number, kind: GiveawayKind) => void;
}) {
  const { item, remaining, price, inCart, cartBusy } = props;
  const soldOut = remaining <= 0;
  const [choice, setChoice] = useState<Choice>(soldOut ? 'zero' : item.kind === 'set' ? 'sale' : 'sample');
  const [qty, setQty] = useState(1);
  const [payInput, setPayInput] = useState('');
  const [reason, setReason] = useState('');
  const full = price * qty;
  const pay = payInput === '' ? null : Number(payInput);
  const discountError = choice !== 'discount' ? null
    : cartBusy ? 'カートの途中です。カートの「値引き・金額を変える」を使ってください'
    : pay === null ? '受け取る金額を入れてください'
    : pay >= full ? '元の金額より安い金額を入れてください'
    : null;
  const saleLabel = inCart ? 'カートに追加' : '販売を記録';
  const options: [Choice, string][] = [
    soldOut ? ['zero', `${saleLabel}(残数0)`] : ['sale', `${saleLabel}(部数を指定)`],
    ['discount', '値引きして記録'],
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
        {choice === 'discount' && (
          <div className="sheet-discount">
            {cartBusy ? (
              <p className="warnnote">{discountError}</p>
            ) : (
              <>
                <div className="rowx">
                  <label className="k" htmlFor="sheet-pay">受け取る金額(元は <span className="num">{yen(full)}</span>)</label>
                  <span className="exp-amount">
                    <input
                      id="sheet-pay" className="price-in" inputMode="numeric" placeholder={String(full)} value={payInput}
                      onChange={(e) => setPayInput(e.target.value.replace(/\D/g, ''))}
                    />
                    <small className="k">円</small>
                  </span>
                </div>
                <div className="chips" role="group" aria-label="値引きの理由">
                  {DISCOUNT_REASONS.map((r) => (
                    <button key={r} className="chip" aria-pressed={reason === r} onClick={() => setReason((x) => (x === r ? '' : r))}>{r}</button>
                  ))}
                </div>
                {pay !== null && pay < full && <p className="k">値引き <span className="num">{yen(full - pay)}</span>(理由と一緒に履歴に残ります)</p>}
                {pay !== null && pay >= full && <p className="warnnote">元の金額より安い金額を入れてください</p>}
                {soldOut && <p className="warnnote">残数0なので、残数がマイナスになります。</p>}
                <p className="note">カートを通さず、この品目だけを1回の販売として記録します。</p>
              </>
            )}
          </div>
        )}
        <div className="qrow">
          <span>部数</span>
          <span className="qty">
            <button aria-label="1部減らす" onClick={() => setQty((q) => Math.max(1, q - 1))}>−</button>
            <span className="num">{qty}</span>
            <button aria-label="1部増やす" onClick={() => setQty((q) => Math.min(99, q + 1))}>+</button>
          </span>
        </div>
        {qty >= MANY_QTY && <p className="warnnote">{qty}部です。数を確かめてから記録してください。</p>}
        <button
          className="go"
          disabled={!!discountError}
          onClick={() => {
            if (discountError) return;
            props.onClose();
            if (choice === 'discount') props.onDiscount(qty, pay!, reason);
            else if (isSale) props.onSale(qty, choice === 'zero');
            else props.onGive(qty, choice as GiveawayKind);
          }}
        >
          {choice === 'discount' ? (pay !== null && pay < full ? `${yen(pay)} で記録する` : '値引きして記録')
            : isSale ? (inCart ? 'カートに追加' : `記録する ${yen(price * qty)}`) : `${GIVE_LABEL[choice as GiveawayKind]}として記録`}
        </button>
        <button className="cancel" onClick={props.onClose}>キャンセル</button>
      </div>
    </div>
  );
}
