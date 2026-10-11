import type { Dispatch, SetStateAction } from 'react';
import { PayMethodChips } from '../../components/PayMethodChips';
import type { Item, PaymentMethod } from '../../db/types';
import { changeBreakdown, denomLabel, paidSuggestions } from '../../domain/change';
import { colorVar } from '../../domain/colors';
import { yen } from '../../lib/format';
import { DISCOUNT_REASONS } from './constants';

// 「その他」で受け取ったお金を足していくボタン
const TALLY = [10000, 5000, 1000, 500, 100, 50, 10] as const;

export type Paid = number | 'exact' | null;
type Setter<T> = Dispatch<SetStateAction<T>>;

/** レジのカート: 品目の一覧、合計、値引き(F-409)、預かり金額とお釣り。状態はレジの画面が持つ */
export function CartPanel(props: {
  cart: Map<string, number>;
  setCart: Setter<Map<string, number> | null>;
  itemById: Map<string, Item>;
  priceOf: (item: Item) => number;
  available: (item: Item) => number;
  addToCart: (item: Item, qty: number) => void;
  onSoldOut: () => void;
  showLines: boolean;
  setShowLines: Setter<boolean>;
  cartTotal: number;
  payTotal: number;
  discount: number;
  discountOpen: boolean;
  setDiscountOpen: Setter<boolean>;
  payInput: string;
  setPayInput: Setter<string>;
  reason: string;
  setReason: Setter<string>;
  paid: Paid;
  setPaid: Setter<Paid>;
  paidAmount: number | null;
  tallyOpen: boolean;
  setTallyOpen: Setter<boolean>;
  /** この端末で使う支払い方法(#15) */
  payMethods: PaymentMethod[];
  method: PaymentMethod;
  setMethod: (m: PaymentMethod) => void;
}) {
  const {
    cart, setCart, itemById, priceOf, available, addToCart, onSoldOut, showLines, setShowLines, cartTotal, payTotal, discount,
    discountOpen, setDiscountOpen, payInput, setPayInput, reason, setReason, paid, setPaid, paidAmount, tallyOpen, setTallyOpen,
    payMethods, method, setMethod,
  } = props;
  return (
    <section className="cart" aria-label="カート">
      {!showLines && (
        <button className="cart-summary" onClick={() => setShowLines(true)}>
          カートの品目 {cart.size}件・{[...cart.values()].reduce((a, q) => a + q, 0)}部(押すと表示)
        </button>
      )}
      {showLines && <div className="cart-lines">
        {cart.size === 0 && <p className="empty-cart">品目をタップしてカートに入れてください</p>}
        {[...cart].map(([id, q]) => {
          const item = itemById.get(id)!;
          return (
            <div className="cl" key={id}>
              <span>{colorVar(item.color) && <i className="color-dot" style={{ '--item-color': colorVar(item.color) } as React.CSSProperties} />}{item.name}</span>
              <span className="qty small">
                <button
                  aria-label={`${item.name}を1部減らす`}
                  onClick={() => setCart((c) => {
                    const m = new Map(c ?? []);
                    if (q <= 1) m.delete(id);
                    else m.set(id, q - 1);
                    return m;
                  })}
                >−</button>
                <span className="num">{q}</span>
                <button
                  aria-label={`${item.name}を1部増やす`}
                  onClick={() => (available(item) > 0 ? addToCart(item, 1) : onSoldOut())}
                >+</button>
              </span>
              <span className="num">{yen(priceOf(item) * q)}</span>
            </div>
          );
        })}
      </div>}
      <div className="total">
        <span>合計</span>
        <span>
          {discount > 0 && <s className="num was">{yen(cartTotal)}</s>}
          <strong className="num">{yen(payTotal)}</strong>
        </span>
      </div>
      {discountOpen ? (
        <div className="discount">
          <div className="rowx">
            <label className="k" htmlFor="pay-in">受け取る金額</label>
            <span className="exp-amount">
              <input
                id="pay-in" className="price-in" inputMode="numeric" placeholder={String(cartTotal)} value={payInput}
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
          {discount > 0 && <p className="k">値引き <span className="num">{yen(discount)}</span>(理由と一緒に履歴に残ります)</p>}
          {discount < 0 && <p className="msg">元の合計より高い金額は入れられません</p>}
          <button className="link-btn" onClick={() => { setDiscountOpen(false); setPayInput(''); setReason(''); }}>値引きをやめる</button>
        </div>
      ) : (
        cart.size > 0 && <button className="link-btn" onClick={() => setDiscountOpen(true)}>値引き・金額を変える</button>
      )}
      <PayMethodChips
        methods={payMethods} value={method}
        onChange={(m) => {
          setMethod(m);
          // 現金以外では、預かり金額とお釣りの欄を閉じる
          if (m !== 'cash') { setPaid(null); setTallyOpen(false); setShowLines(true); }
        }}
      />
      {method !== 'cash' && cart.size > 0 && <p className="k pay-note">現金では受け取らないので、預かり金額とお釣りの欄は出しません。現金の数え合わせにも入りません。</p>}
      {method === 'cash' && <div className="paid" role="group" aria-label="預かり金額">
        <button aria-pressed={paid === 'exact'} onClick={() => { setTallyOpen(false); setPaid((p) => (p === 'exact' ? null : 'exact')); }}>ちょうど</button>
        {paidSuggestions(payTotal).map((v) => (
          <button key={v} className="num" aria-pressed={!tallyOpen && paid === v} onClick={() => { setTallyOpen(false); setPaid((p) => (p === v && !tallyOpen ? null : v)); }}>
            {yen(v)}
          </button>
        ))}
        <button aria-pressed={tallyOpen} onClick={() => { setShowLines(tallyOpen); setTallyOpen((o) => !o); setPaid(tallyOpen ? null : 0); }}>その他</button>
      </div>}
      {method === 'cash' && tallyOpen && (
        <div className="tally">
          <div className="rowx">
            <span className="k">受け取った金額</span>
            <strong className="num">{yen(typeof paid === 'number' ? paid : 0)}</strong>
          </div>
          <div className="tally-keys">
            {TALLY.map((d) => (
              <button key={d} className="num" onClick={() => setPaid((p) => (typeof p === 'number' ? p : 0) + d)}>+{d.toLocaleString('ja-JP')}</button>
            ))}
            <button onClick={() => setPaid(0)}>クリア</button>
          </div>
        </div>
      )}
      {paidAmount !== null && paidAmount > 0 && cart.size > 0 && (
        <div className={`change${paidAmount < payTotal ? ' short' : ''}`}>
          <div className="change-main">
            <span>{paidAmount < payTotal ? '足りません' : paidAmount === payTotal ? 'お釣りなし' : 'お釣り'}</span>
            <strong className="num">{yen(Math.abs(paidAmount - payTotal))}</strong>
          </div>
          {paidAmount > payTotal && (
            <p className="change-parts">{changeBreakdown(paidAmount - payTotal).map((x) => `${denomLabel(x.denom)}×${x.count}`).join('・')}</p>
          )}
        </div>
      )}
    </section>
  );
}
