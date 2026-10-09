import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../app/AuthProvider';
import { db } from '../app/db';
import { usePref } from '../app/prefs';
import { useCtx } from '../app/useCtx';
import { EventNav } from '../components/EventNav';
import { SyncPill } from '../components/SyncPill';
import { useToast } from '../components/Toast';
import type { GiveawayKind, Item, Txn } from '../db/types';
import { GIVE_LABEL, describeTxn } from '../domain/history';
import { recordGiveaway, recordSale, voidTransaction } from '../domain/record';
import { profitTimeline } from '../domain/report';
import { changeBreakdown, denomLabel, paidSuggestions } from '../domain/change';
import { hhmm, yen } from '../lib/format';
import { useWakeLock } from '../app/useWakeLock';
import { useEventData } from './useEventData';

const LONG_PRESS_MS = 550;
// 「その他」で受け取ったお金を足していくボタン
const TALLY = [10000, 5000, 1000, 500, 100, 50, 10] as const;
const DISCOUNT_REASONS = ['まとめ買い', '知り合い', 'おまけ', 'その他'] as const;
const UNLOCK_MS = 800;
// 誤操作の防止
const DOUBLE_TAP_MS = 300; // 同じボタンをこれより速く続けて押したら、1回として扱う(指のぶれ)
const SCROLL_GUARD_MS = 250; // スクロールを止めるためのタップは記録しない
const ARM_MS = 3000; // 「もう一度押すと…」の待ち時間
const MANY_QTY = 10; // これ以上の部数は、記録の前に注意を出す

const lockKey = (eventId: string) => `register-lock:${eventId}`;
function readLock(eventId: string): boolean {
  try {
    return sessionStorage.getItem(lockKey(eventId)) === '1';
  } catch {
    return false;
  }
}
function writeLock(eventId: string, on: boolean) {
  try {
    if (on) sessionStorage.setItem(lockKey(eventId), '1');
    else sessionStorage.removeItem(lockKey(eventId));
  } catch {
    /* 保存できなくてもロック自体は効く */
  }
}

type Paid = number | 'exact' | null;

// レジ画面(F-401〜406a)。既定はタップでカートに入れ、「決済」で記録する。
// 設定で「タップですぐ記録」にすると、タップで即1部記録し、まとめ買いは「カート」から(F-402)
export function RegisterPage() {
  const { eventId = '' } = useParams();
  const navigate = useNavigate();
  const ctx = useCtx();
  const { role } = useAuth();
  const [showBE] = usePref('showBreakEven');
  const [instant] = usePref('instantSale');
  const data = useEventData(eventId);
  const toast = useToast();
  const [sheetItem, setSheetItem] = useState<Item | null>(null);
  // null = カートを使っていない(タップですぐ記録するときだけ)。決済で確定するときは、いつも空のカートから始める
  const [cart, setCart] = useState<Map<string, number> | null>(() => (instant ? null : new Map()));
  const [cartZero, setCartZero] = useState(false);
  const [paid, setPaid] = useState<Paid>(null);
  // 「その他」: 受け取ったお札・硬貨を足していって、預かり金額にする
  const [tallyOpen, setTallyOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [payInput, setPayInput] = useState('');
  const [reason, setReason] = useState('');
  const [screenLock, setScreenLock] = useState(() => readLock(eventId));
  useEffect(() => writeLock(eventId, screenLock), [eventId, screenLock]);
  // レジを開いている間は画面を消さない(確定後は記録しないので不要)
  const awake = useWakeLock(!!data && !data.closing);
  // 黒字化までの残り(サークル主だけ)。記録が変わったときだけ計算し直す(ボタンを押すたびには計算しない)
  const be = useMemo(() => (data && role === 'owner' && showBE ? profitTimeline(data) : null), [data, role, showBE]);
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout>; fired: boolean; pointerId: number; itemId: string } | null>(null);
  const [pressing, setPressing] = useState<string | null>(null);
  const lastTap = useRef<{ id: string; at: number } | null>(null);
  const lastScroll = useRef(0);
  // 記録できたことを、押したボタンの上に「+1」で見せる(n を変えて同じボタンでも出し直す)
  const [hit, setHit] = useState<{ id: string; n: number } | null>(null);
  // 動きを減らす設定でアニメーションが止まっても残らないよう、時間で消す
  useEffect(() => {
    if (!hit) return;
    const t = setTimeout(() => setHit(null), 700);
    return () => clearTimeout(t);
  }, [hit]);
  // 取り消し・カートを空にするは、2回押して実行する
  const [armed, setArmed] = useState<'undo' | 'clear' | null>(null);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  const [busy, setBusy] = useState(false);
  // 押した瞬間に立てる印(state は次の描画まで変わらないので、同時の連打を止められない)
  const busyRef = useRef(false);

  if (data === undefined || ctx === undefined) return <main className="page" />;
  if (data === null || ctx === null) {
    return (
      <main className="page">
        <p>イベントが見つかりません。</p>
        <Link to="/">ホームに戻る</Link>
      </main>
    );
  }

  const { event, eventItems, itemById, ownerById, summary, totals, float, last, linesByTxn, priceOf, closing } = data;
  const locked = !!closing;
  const inCart = (id: string) => cart?.get(id) ?? 0;
  const available = (item: Item) => (summary.get(item.id)?.remaining ?? 0) - inCart(item.id);
  // 確定後は残りを持ち帰っているので、持ち帰る前(撤収時点)の残数を見せる
  const atClose = (id: string) => (summary.get(id)?.remaining ?? 0) + (summary.get(id)?.takenBack ?? 0);
  const shownRemaining = (item: Item): number => {
    if (!locked) return summary.get(item.id)?.remaining ?? 0;
    if (item.kind !== 'set') return atClose(item.id);
    const comps = data.setComponents.filter((c) => c.set_item_id === item.id);
    return comps.length ? Math.min(...comps.map((c) => Math.floor(atClose(c.component_item_id) / c.qty))) : 0;
  };

  const describe = (t: Txn) => describeTxn(t, linesByTxn.get(t.id) ?? [], itemById);

  const vibrate = (ms: number) => {
    try {
      navigator.vibrate?.(ms);
    } catch {
      /* 振動できない端末は無視 */
    }
  };

  const guard = () => {
    if (locked) toast('終了処理を確定済みです');
    return locked;
  };

  async function undoable(p: Promise<Txn>, message: string) {
    try {
      const t = await p;
      vibrate(12);
      toast(message, {
        label: '元に戻す',
        run: () => void voidTransaction(db, ctx!, t.id).then(() => toast('取り消しました'), (e: Error) => toast(e.message)),
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  }

  const addToCart = (item: Item, qty: number, zero = false) => {
    setCart((c) => new Map(c ?? []).set(item.id, (c?.get(item.id) ?? 0) + qty));
    if (zero) setCartZero(true);
  };

  function tap(item: Item) {
    const now = Date.now();
    if (now - lastScroll.current < SCROLL_GUARD_MS) return;
    if (guard()) return;
    if (cart) {
      if (available(item) <= 0) return toast('完売です。長押しで記録できます');
      addToCart(item, 1);
      return;
    }
    if (lastTap.current?.id === item.id && now - lastTap.current.at < DOUBLE_TAP_MS) return;
    lastTap.current = { id: item.id, at: now };
    if (available(item) <= 0) {
      toast('完売です。長押しで記録できます');
      return;
    }
    setHit((h) => ({ id: item.id, n: (h?.n ?? 0) + 1 }));
    void undoable(
      recordSale(db, ctx!, { eventId, lines: [{ itemId: item.id, qty: 1 }] }),
      `${item.name} を記録 ${yen(priceOf(item))}`,
    );
  }

  const onDown = (e: RPointerEvent, item: Item) => {
    if (e.button > 0) return;
    if (press.current) {
      cancelPress();
      return;
    }
    const timer = setTimeout(() => {
      if (!press.current) return;
      press.current.fired = true;
      setPressing(null);
      vibrate(25);
      if (!guard()) setSheetItem(item);
    }, LONG_PRESS_MS);
    press.current = { x: e.clientX, y: e.clientY, timer, fired: false, pointerId: e.pointerId, itemId: item.id };
    setPressing(item.id);
  };
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
    setPressing(null);
  };
  const onMove = (e: RPointerEvent) => {
    if (press.current && press.current.pointerId === e.pointerId && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 10) cancelPress();
  };
  const onUp = (e: RPointerEvent, item: Item) => {
    const p = press.current;
    if (!p || p.pointerId !== e.pointerId) return;
    cancelPress();
    if (!p.fired && p.itemId === item.id) tap(item);
  };

  const exitCart = () => {
    setCart(instant ? null : new Map());
    setCartZero(false);
    setPaid(null);
    setTallyOpen(false);
    setDiscountOpen(false);
    setPayInput('');
    setReason('');
  };
  const cartTotal = [...(cart ?? [])].reduce((a, [id, q]) => a + priceOf(itemById.get(id)!) * q, 0);
  // 値引き(F-409): 受け取る金額を入れると、元の合計との差を値引きとして記録する
  const payTotal = discountOpen && payInput !== '' ? Number(payInput) : cartTotal;
  const discount = cartTotal - payTotal;
  // 「その他」を開いただけ(0円)のときは、預かり金額を入れていないものとして扱う
  const paidAmount = paid === 'exact' ? payTotal : paid ? paid : null;

  // 下の左のボタン: カートが空(またはカートを使っていない)なら「取り消し」、品目が入っていれば「やめる」
  const showUndo = !cart || (!instant && cart.size === 0);

  async function checkout() {
    if (busyRef.current) return;
    if (!cart || cart.size === 0) return toast('品目をタップしてカートに入れてください');
    if (discount < 0) return toast('元の合計より高い金額は入れられません');
    if (paidAmount !== null && paidAmount < payTotal) return toast('預かり金額が足りません');
    const change = paidAmount !== null ? `・お釣り ${yen(paidAmount - payTotal)}` : '';
    busyRef.current = true;
    setBusy(true);
    try {
      await undoable(
      recordSale(db, ctx!, {
        eventId,
        lines: [...cart].map(([itemId, qty]) => ({ itemId, qty })),
        paidAmount,
        zeroStockOverride: cartZero,
        discount: Math.max(0, discount),
        note: reason || undefined,
      }),
      `${instant ? '' : '決済 '}${yen(payTotal)}${instant ? ' を記録' : ''}${discount > 0 ? `(値引き ${yen(discount)})` : ''}${change}`,
      );
      exitCart();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="register">
      <header className="top">
        <div className="bar">
          {cart && cart.size > 0 ? (
            <div className="ev"><b>{event.name}</b><span>カートの途中です</span></div>
          ) : (
            <Link className="ev" to="/">
              <b>{event.name}</b>
              <span>{event.space_no ?? event.held_on}</span>
            </Link>
          )}
          <SyncPill />
          <button className="icon-btn" aria-label="画面をロックする" onClick={() => { cancelPress(); setSheetItem(null); setArmed(null); setScreenLock(true); }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
          </button>
        </div>
        <div className="sum">
          <div><small>売上</small><strong className="num">{yen(totals.amount)}</strong></div>
          <div><small>部数</small><strong className="num">{totals.count}</strong></div>
          <div><small>現金(理論)</small><strong className="num">{yen(float + totals.amount)}</strong></div>
        </div>
        {be && be.fixed > 0 && (
          <div className={`be-line${be.current >= 0 ? ' black' : ''}`}>
            {be.current >= 0 ? `黒字 +${yen(be.current)}${be.blackAt ? `(${hhmm(be.blackAt)}に達成)` : ''}` : `黒字まで あと${yen(-be.current)}`}
          </div>
        )}
        <div className="mode">
          {!cart ? <span>タップで1部記録・長押しでメニュー</span>
            : instant ? <span className="cart-on">カートモード:タップで追加</span>
            : cart.size > 0 ? <span className="cart-on">カート {[...cart.values()].reduce((a, q) => a + q, 0)}部・「決済」で記録</span>
            : <span>タップでカートに入れ、「決済」で記録</span>}
          <span>{awake ? '画面は消えません・' : ''}{eventItems.length}品目</span>
        </div>
        {locked && (
          <button className="closed-banner" onClick={() => navigate(`/events/${eventId}/closing`)}>
            {hhmm(closing.closed_at)} に終了処理を確定しました。記録は変更できません。結果を見る
          </button>
        )}
      </header>

      <main className="grid-wrap" onScroll={() => { lastScroll.current = Date.now(); }}>
        <div className="grid" onContextMenu={(e) => e.preventDefault()}>
          {eventItems.map((ei) => {
            const item = itemById.get(ei.item_id);
            if (!item) return null;
            const s = summary.get(item.id);
            const r = shownRemaining(item);
            const owner = ownerById.get(item.owner_id);
            const state = r < 0 ? 'out neg' : r === 0 ? 'out' : r <= item.low_threshold ? 'low' : '';
            const remText = r < 0 ? `残 −${-r}` : r === 0 ? (s?.soldOutAt ? `完売 ${hhmm(s.soldOutAt)}` : '完売') : `残${r}`;
            return (
              <button
                key={item.id}
                className={`item ${state}${pressing === item.id ? ' pressing' : ''}`}
                aria-label={`${item.name} ${priceOf(item)}円 ${r <= 0 ? '完売' : `残り${r}`}${owner && !owner.is_self ? ` 受託 ${owner.name}` : ''}${inCart(item.id) ? ` カートに${inCart(item.id)}` : ''}`}
                onPointerDown={(e) => onDown(e, item)}
                onPointerMove={onMove}
                onPointerUp={(e) => onUp(e, item)}
                onPointerCancel={cancelPress}
                onPointerLeave={cancelPress}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.shiftKey) {
                    e.preventDefault();
                    if (!guard()) setSheetItem(item);
                  } else if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    tap(item);
                  }
                }}
              >
                {inCart(item.id) > 0 && <span className="incart num">{inCart(item.id)}</span>}
                {hit?.id === item.id && !cart && <span key={hit.n} className="hit num" aria-hidden="true">+1</span>}
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
        <p className="hint">完売の品目は、タップでは{instant ? "記録しません" : "カートに入りません"}。長押しすると「販売を記録(残数0)」を選べます。</p>
      </main>

      {cart && (instant || cart.size > 0) && (
        <section className="cart" aria-label="カート">
          <div className="cart-lines">
            {cart.size === 0 && <p className="empty-cart">品目をタップしてカートに入れてください</p>}
            {[...cart].map(([id, q]) => {
              const item = itemById.get(id)!;
              return (
                <div className="cl" key={id}>
                  <span>{item.name}</span>
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
                      onClick={() => (available(item) > 0 ? addToCart(item, 1) : toast('完売です。長押しで記録できます'))}
                    >+</button>
                  </span>
                  <span className="num">{yen(priceOf(item) * q)}</span>
                </div>
              );
            })}
          </div>
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
          <div className="paid" role="group" aria-label="預かり金額">
            <button aria-pressed={paid === 'exact'} onClick={() => { setTallyOpen(false); setPaid((p) => (p === 'exact' ? null : 'exact')); }}>ちょうど</button>
            {paidSuggestions(payTotal).map((v) => (
              <button key={v} className="num" aria-pressed={!tallyOpen && paid === v} onClick={() => { setTallyOpen(false); setPaid((p) => (p === v && !tallyOpen ? null : v)); }}>
                {yen(v)}
              </button>
            ))}
            <button aria-pressed={tallyOpen} onClick={() => { setTallyOpen((o) => !o); setPaid(tallyOpen ? null : 0); }}>その他</button>
          </div>
          {tallyOpen && (
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
      )}

      <footer className="foot">
        {showUndo ? (
          <button
            className={`fbtn${armed === 'undo' ? ' armed' : ''}`}
            onClick={async () => {
              if (guard()) return;
              if (!last) return toast('取り消す記録がありません');
              if (armed !== 'undo') return setArmed('undo');
              setArmed(null);
              try {
                await voidTransaction(db, ctx, last.id);
                toast(`取り消し: ${describe(last)}`);
              } catch (e) {
                toast(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            {armed === 'undo' ? 'もう一度押すと取り消し' : '取り消し'}<small>{last ? describe(last) : '記録なし'}</small>
          </button>
        ) : (
          <button
            className={`fbtn${armed === 'clear' ? ' armed' : ''}`}
            onClick={() => {
              if (cart && cart.size > 0 && armed !== 'clear') return setArmed('clear');
              setArmed(null);
              exitCart();
              toast(cart && cart.size > 0 ? 'カートを空にしました' : 'カートを閉じました');
            }}
          >
            {armed === 'clear' ? 'もう一度押すと空に' : 'やめる'}<small>{cart && cart.size > 0 ? `カートの${cart.size}品目を消す` : 'カートを閉じる'}</small>
          </button>
        )}
        {cart ? (
          <button className="fbtn primary" disabled={busy || cart.size === 0} onClick={() => void checkout()}>
            {instant ? '記録する' : '決済'}<small className="num">{cart.size ? yen(payTotal) : '品目をタップしてください'}</small>
          </button>
        ) : (
          <button className="fbtn" onClick={() => !guard() && setCart(new Map())}>
            カート<small>まとめ買い</small>
          </button>
        )}
      </footer>
      {showUndo && <EventNav eventId={eventId} current="register" />}

      {screenLock && (
        <LockCover
          title={event.name}
          sales={yen(totals.amount)}
          count={totals.count}
          onUnlock={() => { setScreenLock(false); vibrate(20); }}
        />
      )}

      {sheetItem && (
        <ItemSheet
          item={sheetItem}
          remaining={available(sheetItem)}
          price={priceOf(sheetItem)}
          inCart={!!cart}
          onClose={() => setSheetItem(null)}
          onSale={(qty, zero) => {
            if (cart) return addToCart(sheetItem, qty, zero);
            void undoable(
              recordSale(db, ctx, { eventId, lines: [{ itemId: sheetItem.id, qty }], zeroStockOverride: zero }),
              `${sheetItem.name}${qty > 1 ? ` ×${qty}` : ''} を記録${zero ? '(残数0)' : ''}`,
            );
          }}
          onGive={(qty, kind) =>
            void undoable(
              recordGiveaway(db, ctx, { eventId, itemId: sheetItem.id, qty, kind }),
              `${GIVE_LABEL[kind]}: ${sheetItem.name}${qty > 1 ? ` ×${qty}` : ''}`,
            )
          }
        />
      )}
    </div>
  );
}

/** 画面のロック(F-410)。カバンやポケットの中での誤タップを防ぐ。長押しで解除する */
function LockCover(props: { title: string; sales: string; count: number; onUnlock: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [holding, setHolding] = useState(false);
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <div className="lock-cover" role="dialog" aria-modal="true" aria-label="画面はロック中です" onContextMenu={(e) => e.preventDefault()}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
      <b>ロック中</b>
      <p className="k">{props.title}</p>
      <p className="lock-sum"><span className="num">{props.sales}</span><small>{props.count}部</small></p>
      <button
        className={`unlock${holding ? ' holding' : ''}`}
        onPointerDown={() => {
          setHolding(true);
          timer.current = setTimeout(() => { stop(); props.onUnlock(); }, UNLOCK_MS);
        }}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
        onKeyDown={(e) => { if (e.key === 'Enter') props.onUnlock(); }}
      >
        <span>長押しで解除</span>
      </button>
    </div>
  );
}

type Choice = 'sale' | 'zero' | GiveawayKind;

function ItemSheet(props: {
  item: Item;
  remaining: number;
  price: number;
  inCart: boolean;
  onClose: () => void;
  onSale: (qty: number, zero: boolean) => void;
  onGive: (qty: number, kind: GiveawayKind) => void;
}) {
  const { item, remaining, price, inCart } = props;
  const soldOut = remaining <= 0;
  const [choice, setChoice] = useState<Choice>(soldOut ? 'zero' : item.kind === 'set' ? 'sale' : 'sample');
  const [qty, setQty] = useState(1);
  const saleLabel = inCart ? 'カートに追加' : '販売を記録';
  const options: [Choice, string][] = [
    soldOut ? ['zero', `${saleLabel}(残数0)`] : ['sale', `${saleLabel}(部数を指定)`],
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
        {qty >= MANY_QTY && <p className="warnnote">{qty}部です。数を確かめてから記録してください。</p>}
        <button
          className="go"
          onClick={() => {
            props.onClose();
            if (isSale) props.onSale(qty, choice === 'zero');
            else props.onGive(qty, choice as GiveawayKind);
          }}
        >
          {isSale ? (inCart ? 'カートに追加' : `記録する ${yen(price * qty)}`) : `${GIVE_LABEL[choice as GiveawayKind]}として記録`}
        </button>
        <button className="cancel" onClick={props.onClose}>キャンセル</button>
      </div>
    </div>
  );
}
