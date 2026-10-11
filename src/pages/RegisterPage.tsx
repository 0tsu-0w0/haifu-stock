import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../app/AuthProvider';
import { db } from '../app/db';
import { useChoice, usePref } from '../app/prefs';
import { useCtx } from '../app/useCtx';
import { EventNav } from '../components/EventNav';
import { RegisterTour, tourSeen } from '../components/RegisterTour';
import { useReservations } from '../components/Reservations';
import { SyncPill } from '../components/SyncPill';
import { useToast } from '../components/Toast';
import type { Item, Txn } from '../db/types';
import { endBreak, openBreak, startBreak } from '../domain/breaks';
import { GIVE_LABEL, describeTxn } from '../domain/history';
import { recordGiveaway, recordSale, voidTransaction } from '../domain/record';
import { handReservation } from '../domain/reservations';
import { profitTimeline } from '../domain/report';
import { colorVar } from '../domain/colors';
import { hhmm, yen } from '../lib/format';
import { useWakeLock } from '../app/useWakeLock';
import { useEventData } from './useEventData';
import { CartPanel, type Paid } from './register/CartPanel';
import { ItemSheet } from './register/ItemSheet';
import { LockCover } from './register/LockCover';
import { PaidFlash, type Flash } from './register/PaidFlash';
import { ReservationSheet } from './register/ReservationSheet';

const LONG_PRESS_MS = 550;
// 誤操作の防止
const DOUBLE_TAP_MS = 300; // 同じボタンをこれより速く続けて押したら、1回として扱う(指のぶれ)
const SCROLL_GUARD_MS = 250; // スクロールを止めるためのタップは記録しない
const ARM_MS = 3000; // 「もう一度押すと…」の待ち時間

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

// レジ画面(F-401〜406a)。既定はタップでカートに入れ、「決済」で記録する。
// 設定で「タップですぐ記録」にすると、タップで即1部記録し、まとめ買いは「カート」から(F-402)
export function RegisterPage() {
  const { eventId = '' } = useParams();
  const navigate = useNavigate();
  const ctx = useCtx();
  const { role } = useAuth();
  const [showBE] = usePref('showBreakEven');
  const [instant] = usePref('instantSale');
  const [soldOutLast] = usePref('soldOutLast');
  const [lastOneRed] = usePref('lastOneRed');
  const [haptics] = usePref('haptics');
  const [regSize] = useChoice('regSize');
  const [regCols] = useChoice('regCols');
  const data = useEventData(eventId);
  const toast = useToast();
  const [sheetItem, setSheetItem] = useState<Item | null>(null);
  // null = カートを使っていない(タップですぐ記録するときだけ)。決済で確定するときは、いつも空のカートから始める
  const [cart, setCart] = useState<Map<string, number> | null>(() => (instant ? null : new Map()));
  const [cartZero, setCartZero] = useState(false);
  const [paid, setPaid] = useState<Paid>(null);
  // 「その他」: 受け取ったお札・硬貨を足していって、預かり金額にする
  const [tallyOpen, setTallyOpen] = useState(false);
  // カートの品目の一覧(預かり金額を入れている間はたたんで、品目のボタンを見えるようにする)
  const [showLines, setShowLines] = useState(true);
  // 下の説明文は、レジを開いた最初の3回だけ出す
  const [showHint] = useState(() => {
    try {
      const n = Number(localStorage.getItem('register-hint-count') ?? '0');
      if (n >= 3) return false;
      localStorage.setItem('register-hint-count', String(n + 1));
      return true;
    } catch {
      return true;
    }
  });
  const [discountOpen, setDiscountOpen] = useState(false);
  const [payInput, setPayInput] = useState('');
  const [reason, setReason] = useState('');
  const [screenLock, setScreenLock] = useState(() => readLock(eventId));
  // 休憩・離席中(F-411)。販売を記録すると自動で終わる
  const onBreak = useLiveQuery(() => openBreak(db, eventId), [eventId]);
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
  // 決済できたことを、品目の上に大きく出す(合計とお釣り)。次の品目をタップしたら消す
  const [flash, setFlash] = useState<Flash | null>(null);
  useEffect(() => {
    if (!flash) return;
    // お釣りを渡す間は長めに出す
    const t = setTimeout(() => setFlash(null), flash.change ? 4500 : 1800);
    return () => clearTimeout(t);
  }, [flash]);
  // 招待から入ったスタッフの端末では、最初に使い方を出す
  const [tour, setTour] = useState(false);
  // 取り置きの一覧(当日に渡したら記録する)
  const [resvOpen, setResvOpen] = useState(false);
  const reservations = useReservations(eventId);
  useEffect(() => {
    if (role === 'staff' && !tourSeen()) setTour(true);
  }, [role]);
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

  const { event, eventItems, itemById, ownerById, summary, totals, float, last, linesByTxn, priceOf, closing, held } = data;
  const locked = !!closing;
  const inCart = (id: string) => cart?.get(id) ?? 0;
  // 売れる部数 = 残り − カートの分 − 取り置きの分(#11)
  const heldOf = (id: string) => held.get(id) ?? 0;
  const available = (item: Item) => (summary.get(item.id)?.remaining ?? 0) - inCart(item.id) - heldOf(item.id);
  const soldOutMsg = (item: Item) => (heldOf(item.id) > 0 && (summary.get(item.id)?.remaining ?? 0) - inCart(item.id) > 0
    ? '残りは取り置きの分です。渡すときは上の「取り置き」から記録します'
    : '完売です。長押しで記録できます');
  // 確定後は残りを持ち帰っているので、持ち帰る前(撤収時点)の残数を見せる
  const atClose = (id: string) => (summary.get(id)?.remaining ?? 0) + (summary.get(id)?.takenBack ?? 0);
  const shownRemaining = (item: Item): number => {
    if (!locked) return summary.get(item.id)?.remaining ?? 0;
    if (item.kind !== 'set') return atClose(item.id);
    const comps = data.setComponents.filter((c) => c.set_item_id === item.id);
    return comps.length ? Math.min(...comps.map((c) => Math.floor(atClose(c.component_item_id) / c.qty))) : 0;
  };

  // 完売した品目を末尾に回す(この端末の設定)。並び順そのものは変えない
  const shownItems = soldOutLast
    ? [...eventItems].sort((a, b) => {
      const ia = itemById.get(a.item_id);
      const ib = itemById.get(b.item_id);
      return Number(!!ia && shownRemaining(ia) - (locked ? 0 : heldOf(ia.id)) <= 0) - Number(!!ib && shownRemaining(ib) - (locked ? 0 : heldOf(ib.id)) <= 0);
    })
    : eventItems;

  const describe = (t: Txn) => describeTxn(t, linesByTxn.get(t.id) ?? [], itemById);

  const vibrate = (ms: number | number[]) => {
    if (!haptics) return;
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

  async function undoable(p: Promise<Txn>, message: string, buzz: number | number[] = 12): Promise<boolean> {
    try {
      const t = await p;
      vibrate(buzz);
      if (onBreak) void endBreak(db, ctx!, eventId);
      toast(message, {
        label: '元に戻す',
        run: () => void voidTransaction(db, ctx!, t.id).then(() => { setFlash(null); toast('取り消しました'); }, (e: Error) => toast(e.message)),
      });
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
      return false;
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
    setFlash(null);
    if (cart) {
      if (available(item) <= 0) return toast(soldOutMsg(item));
      addToCart(item, 1);
      return;
    }
    if (lastTap.current?.id === item.id && now - lastTap.current.at < DOUBLE_TAP_MS) return;
    lastTap.current = { id: item.id, at: now };
    if (available(item) <= 0) {
      toast(soldOutMsg(item));
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
    setShowLines(true);
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
      const ok = await undoable(
      recordSale(db, ctx!, {
        eventId,
        lines: [...cart].map(([itemId, qty]) => ({ itemId, qty })),
        paidAmount,
        zeroStockOverride: cartZero,
        discount: Math.max(0, discount),
        note: reason || undefined,
      }),
      `${instant ? '' : '決済 '}${yen(payTotal)}${instant ? ' を記録' : ''}${discount > 0 ? `(値引き ${yen(discount)})` : ''}${change}`,
      [15, 60, 15],
      );
      if (ok) {
        setFlash((f) => ({ total: payTotal, change: paidAmount !== null ? paidAmount - payTotal : null, discount: Math.max(0, discount), n: (f?.n ?? 0) + 1 }));
        exitCart();
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className={`register${regSize === 'large' ? ' large' : ''}`}>
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
          {!locked && (
            <button
              className={`icon-btn${onBreak ? ' on' : ''}`}
              aria-label={onBreak ? '休憩を終える' : '休憩・離席を始める'}
              aria-pressed={!!onBreak}
              onClick={() => void (onBreak ? endBreak(db, ctx, eventId).then(() => toast('休憩を終えました')) : startBreak(db, ctx, eventId).then(() => toast('休憩を始めました。この時間は販売時間から除きます')))}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 8h1a4 4 0 0 1 0 8h-1" /><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" /><path d="M6 2v2M10 2v2M14 2v2" /></svg>
            </button>
          )}
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
        {!locked && (reservations?.some((r) => r.status === 'held') ?? false) && (
          <button className="resv-chip" onClick={() => setResvOpen(true)}>
            取り置き {reservations!.filter((r) => r.status === 'held').length}件(押すと一覧・渡したら記録)
          </button>
        )}
        {onBreak && !locked && (
          <button className="break-banner" onClick={() => void endBreak(db, ctx, eventId).then(() => toast('休憩を終えました'))}>
            休憩中({hhmm(onBreak.starts_at)}〜)。この時間は販売時間から除きます。押すと再開します(販売を記録しても再開します)
          </button>
        )}
        {locked && (
          <button className="closed-banner" onClick={() => navigate(`/events/${eventId}/closing`)}>
            {hhmm(closing.closed_at)} に終了処理を確定しました。記録は変更できません。結果を見る
          </button>
        )}
      </header>

      <main className="grid-wrap" onScroll={() => { lastScroll.current = Date.now(); }}>
        {flash && <PaidFlash flash={flash} instant={instant} />}
        <div className={`grid${regCols === '3' ? ' cols-3' : ''}`} onContextMenu={(e) => e.preventDefault()}>
          {shownItems.map((ei) => {
            const item = itemById.get(ei.item_id);
            if (!item) return null;
            const s = summary.get(item.id);
            const r = shownRemaining(item);
            const owner = ownerById.get(item.owner_id);
            const h = locked ? 0 : heldOf(item.id);
            const free = r - h; // 取り置きを除いた、売れる部数
            const state = r < 0 ? 'out neg' : free <= 0 ? 'out' : free === 1 && lastOneRed ? 'last' : free <= item.low_threshold ? 'low' : '';
            const color = colorVar(item.color);
            const remText = r < 0 ? `残 −${-r}` : r === 0 ? (s?.soldOutAt ? `完売 ${hhmm(s.soldOutAt)}` : '完売')
              : h > 0 ? (free <= 0 ? `取置${h}のみ` : `残${free}・取置${h}`)
              : r === 1 && lastOneRed ? '残1・最後' : `残${r}`;
            return (
              <button
                key={item.id}
                className={`item ${state}${color ? ' colored' : ''}${pressing === item.id ? ' pressing' : ''}`}
                style={color ? ({ '--item-color': color } as React.CSSProperties) : undefined}
                aria-label={`${item.name} ${priceOf(item)}円 ${r <= 0 ? '完売' : free <= 0 ? `残り${r}部はすべて取り置き` : free === 1 ? '残り1部・最後の1部' : `残り${free}`}${h > 0 && free > 0 ? ` 取り置き${h}部` : ''}${owner && !owner.is_self ? ` 受託 ${owner.name}` : ''}${inCart(item.id) ? ` カートに${inCart(item.id)}` : ''}`}
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
        {showHint && !(cart && cart.size > 0) && (
          <p className="hint">完売の品目は、タップでは{instant ? '記録しません' : 'カートに入りません'}。長押しすると「販売を記録(残数0)」を選べます。</p>
        )}
      </main>

      {cart && (instant || cart.size > 0) && (
        <CartPanel
          cart={cart} setCart={setCart} itemById={itemById} priceOf={priceOf} available={available} addToCart={addToCart}
          onSoldOut={() => toast('完売です。長押しで記録できます')}
          showLines={showLines} setShowLines={setShowLines}
          cartTotal={cartTotal} payTotal={payTotal} discount={discount}
          discountOpen={discountOpen} setDiscountOpen={setDiscountOpen} payInput={payInput} setPayInput={setPayInput} reason={reason} setReason={setReason}
          paid={paid} setPaid={setPaid} paidAmount={paidAmount} tallyOpen={tallyOpen} setTallyOpen={setTallyOpen}
        />
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

      {tour && !screenLock && <RegisterTour instant={instant} onClose={() => setTour(false)} />}

      {resvOpen && reservations && (
        <ReservationSheet
          reservations={reservations} itemById={itemById} priceOf={priceOf} onClose={() => setResvOpen(false)}
          onHand={(r, it) => void undoable(handReservation(db, ctx, r.id), `${r.name} に ${it.name}${r.qty > 1 ? ` ×${r.qty}` : ''} を渡しました ${yen(priceOf(it) * r.qty)}`)}
        />
      )}

      {sheetItem && (
        <ItemSheet
          item={sheetItem}
          remaining={available(sheetItem)}
          price={priceOf(sheetItem)}
          inCart={!!cart}
          cartBusy={!!cart && cart.size > 0}
          onClose={() => setSheetItem(null)}
          onDiscount={(qty, pay, why) => {
            // カートを通さず、この品目だけを値引きした金額で1回の販売として記録する(F-409)
            const full = priceOf(sheetItem) * qty;
            void undoable(
              recordSale(db, ctx, {
                eventId, lines: [{ itemId: sheetItem.id, qty }], zeroStockOverride: available(sheetItem) < qty,
                discount: full - pay, note: why || undefined,
              }),
              `${sheetItem.name}${qty > 1 ? ` ×${qty}` : ''} を ${yen(pay)} で記録(値引き ${yen(full - pay)})`,
            );
          }}
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
