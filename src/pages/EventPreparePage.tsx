import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { db } from '../app/db';
import { useCtx } from '../app/useCtx';
import { ConfirmButton } from '../components/ConfirmButton';
import { EventNav } from '../components/EventNav';
import { NewItemForEvent } from '../components/NewItemForEvent';
import { NumberField } from '../components/NumberField';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import type { ExpenseCategory } from '../db/types';
import {
  EXPENSE_LABEL, copyFloatAndExpenses, deleteEvent, planFromEvent, prepareEvent, preparedQty, saveEventInfo, saveExpense, saveFloat, saveSortOrder,
  type PrepareLine,
} from '../domain/catalog';
import { DENOMINATIONS } from '../domain/closing';
import { stockByLocation } from '../domain/ledger';
import { yen } from '../lib/format';

const toLocalTime = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fromLocalTime = (date: string, time: string) => (time ? new Date(`${date}T${time}:00`).toISOString() : null);

// イベントの作成(F-301)と準備: 持ち込み(F-302)、受託品(F-307)、釣り銭(F-305)、経費(F-309)
export function EventPreparePage() {
  const { eventId } = useParams();
  const isNew = !eventId;
  const ctx = useCtx();
  const navigate = useNavigate();
  const toast = useToast();

  const data = useLiveQuery(async () => {
    if (!ctx) return null;
    const [event, items, owners, storages, eventItems, prepared, cash, expenses, closings, movements, txns, events] = await Promise.all([
      isNew ? undefined : db.events.get(eventId!),
      db.items.where('circle_id').equals(ctx.circleId).toArray(),
      db.owners.where('circle_id').equals(ctx.circleId).toArray(),
      db.locations.where('circle_id').equals(ctx.circleId).filter((l) => l.kind === 'storage').toArray(),
      isNew ? [] : db.event_items.where('event_id').equals(eventId!).toArray(),
      isNew ? new Map<string, number>() : preparedQty(db, eventId!),
      isNew ? [] : db.cash_counts.where('event_id').equals(eventId!).toArray(),
      isNew ? [] : db.expenses.where('event_id').equals(eventId!).toArray(),
      isNew ? [] : db.event_closings.where('event_id').equals(eventId!).toArray(),
      db.stock_movements.toArray(),
      db.transactions.toArray(),
      db.events.where('circle_id').equals(ctx.circleId).toArray(),
    ]);
    // コピー元にできるイベント(F-303): 削除していない、ほかのイベント。新しい順
    const others = events.filter((e) => !e.deleted_at && e.id !== eventId).sort((a, b) => b.held_on.localeCompare(a.held_on));
    return {
      event, items, owners, storages, eventItems, prepared, cash, expenses, others,
      closed: closings.some((c) => !c.reopened_at), stock: stockByLocation(movements, txns),
    };
  }, [ctx?.circleId, eventId]);

  const [info, setInfo] = useState({ name: '', date: new Date().toISOString().slice(0, 10), space: '', venue: '', time: '' });
  const [lines, setLines] = useState<Map<string, PrepareLine> | null>(null);
  const [newExp, setNewExp] = useState<{ category: ExpenseCategory; amount: string }>({ category: 'booth_fee', amount: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copyFrom, setCopyFrom] = useState('');

  // 読み込んだ値でフォームを初期化する(その後はフォームの値を正とする)
  useEffect(() => {
    if (!data?.event) return;
    setInfo({
      name: data.event.name, date: data.event.held_on, space: data.event.space_no ?? '', venue: data.event.venue ?? '',
      time: toLocalTime(data.event.starts_at),
    });
  }, [data?.event?.id]); // イベントが変わったときだけ入れ直す(編集中の値を上書きしない)
  useEffect(() => {
    if (!data || isNew || lines) return;
    const m = new Map<string, PrepareLine>();
    for (const i of data.items) {
      const ei = data.eventItems.find((e) => e.item_id === i.id);
      m.set(i.id, { itemId: i.id, included: !!ei && !ei.removed_at, bring: data.prepared.get(i.id) ?? 0, priceOverride: ei?.price_override ?? null });
    }
    setLines(m);
  }, [data, isNew, lines]);

  const ordered = useMemo(() => {
    if (!data) return [];
    const order = new Map(data.eventItems.map((e) => [e.item_id, e.sort_order]));
    // 削除・アーカイブした品目は出さない(終了済みのイベントで、まだ持ち込みに入っているものだけは残す)
    const active = new Set(data.eventItems.filter((e) => !e.removed_at).map((e) => e.item_id));
    const self = data.owners.find((o) => o.is_self)?.id;
    return data.items
      .filter((i) => (!i.archived_at && !i.deleted_at) || active.has(i.id))
      .sort((a, b) =>
        (order.get(a.id) ?? 1e6) - (order.get(b.id) ?? 1e6)
        || Number(b.owner_id === self) - Number(a.owner_id === self)
        || a.name.localeCompare(b.name, 'ja'));
  }, [data]);

  if (!ctx || !data) return <main className="page" />;
  if (!isNew && !data.event) return <main className="page"><p>イベントが見つかりません。</p><Link to="/">ホームに戻る</Link></main>;
  const home = data.storages[0];
  const locked = data.closed;

  async function saveInfo() {
    setError('');
    try {
      const ev = await saveEventInfo(db, ctx!, {
        id: data!.event?.id, name: info.name, heldOn: info.date, spaceNo: info.space, venue: info.venue,
        startsAt: fromLocalTime(info.date, info.time),
      });
      toast(isNew ? 'イベントを作りました。持ち込む品目を選んでください' : '保存しました');
      if (isNew) navigate(`/events/${ev.id}/prepare`, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function copyPrevious(fromId: string) {
    try {
      const plan = await planFromEvent(db, fromId);
      if (plan.length === 0) return toast('そのイベントには持ち込む品目がありません');
      setLines((m) => {
        const n = new Map(m ?? []);
        for (const l of plan) n.set(l.itemId, l);
        return n;
      });
      const r = await copyFloatAndExpenses(db, ctx!, fromId, eventId!);
      const extra = [r.float ? '釣り銭' : '', r.expenses ? `経費${r.expenses}件` : ''].filter(Boolean).join('・');
      toast(`${plan.length}品目を入れました${extra ? `(${extra}も写しました)` : ''}。確かめて「持ち込みを反映する」を押してください`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  }

  const setLine = (id: string, patch: Partial<PrepareLine>) =>
    setLines((m) => new Map(m ?? []).set(id, { ...(m?.get(id) ?? lineOf(id)), ...patch }));

  async function applyBring() {
    if (!lines || !home) return;
    setBusy(true);
    try {
      const list = ordered.map((i) => lineOf(i.id)).filter((l) => (l.included || data!.eventItems.some((e) => e.item_id === l.itemId)));
      const { moved } = await prepareEvent(db, ctx!, eventId!, list, { storageId: home.id });
      toast(moved ? `持ち込みを反映しました(${moved}部を移動)` : '持ち込みを反映しました');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // フォームでまだ触っていない品目(あとから増えた品目も含む)は、保存済みの状態をそのまま使う
  const lineOf = (id: string): PrepareLine => {
    const l = lines?.get(id);
    if (l) return l;
    const ei = data.eventItems.find((e) => e.item_id === id);
    return { itemId: id, included: !!ei && !ei.removed_at, bring: data.prepared.get(id) ?? 0, priceOverride: ei?.price_override ?? null };
  };

  // レジに並んでいる品目(反映済みのもの)の並び順
  const regOrder = data.eventItems.filter((e) => !e.removed_at).sort((a, b) => a.sort_order - b.sort_order).map((e) => e.item_id);
  async function move(i: number, d: -1 | 1) {
    const next = [...regOrder];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    try {
      await saveSortOrder(db, eventId!, next);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  }

  const floatCounts = new Map(data.cash.filter((c) => c.phase === 'float').map((c) => [c.denomination, c.count]));
  const floatTotal = [...floatCounts].reduce((a, [d, c]) => a + d * c, 0);
  const shownExpenses = data.expenses.filter((e) => (e.planned_amount ?? 0) > 0 || (e.actual_amount ?? 0) > 0);
  const owner = (id: string) => data.owners.find((o) => o.id === id);
  const changed = lines && ordered.some((i) => {
    const l = lineOf(i.id);
    const ei = data.eventItems.find((e) => e.item_id === i.id);
    return l && ((l.included !== (!!ei && !ei.removed_at)) || (l.included && i.kind !== 'set' && l.bring !== (data.prepared.get(i.id) ?? 0))
      || (l.included && (l.priceOverride ?? null) !== (ei?.price_override ?? null)));
  });

  // 既定のコピー元: このイベントより前で、いちばん新しいもの
  const defaultFrom = data.others.find((e) => !data.event || e.held_on <= data.event.held_on) ?? data.others[0];
  const fromId = copyFrom || defaultFrom?.id || '';

  return (
    <>
    <main className="page">
      <PageHeader title={isNew ? 'イベントを作る' : 'イベントの準備'} sub={isNew ? undefined : data.event?.name} />
      {locked && <p className="note">このイベントは終了処理を確定済みです。準備の内容は変えられません。</p>}

      <form className="card form" onSubmit={(e) => { e.preventDefault(); void saveInfo(); }}>
        <label htmlFor="ev-name">イベント名</label>
        <input id="ev-name" value={info.name} onChange={(e) => setInfo({ ...info, name: e.target.value })} placeholder="コミティア150" />
        <div className="two">
          <span>
            <label htmlFor="ev-date">開催日</label>
            <input id="ev-date" type="date" value={info.date} onChange={(e) => setInfo({ ...info, date: e.target.value })} />
          </span>
          <span>
            <label htmlFor="ev-time">開始時刻</label>
            <input id="ev-time" type="time" value={info.time} onChange={(e) => setInfo({ ...info, time: e.target.value })} />
          </span>
        </div>
        <div className="two">
          <span>
            <label htmlFor="ev-space">スペース番号</label>
            <input id="ev-space" value={info.space} onChange={(e) => setInfo({ ...info, space: e.target.value })} placeholder="A12a" />
          </span>
          <span>
            <label htmlFor="ev-venue">会場</label>
            <input id="ev-venue" value={info.venue} onChange={(e) => setInfo({ ...info, venue: e.target.value })} placeholder="任意" />
          </span>
        </div>
        <p className="note">開始時刻は、完売したときの需要の補正に使います。</p>
        {error && <p className="error">{error}</p>}
        <button className="btn primary">{isNew ? '作って準備に進む' : '保存する'}</button>
      </form>

      {!isNew && lines && (
        <>
          <h3 className="section">持ち込む品目</h3>
          {!locked && fromId && (
            <div className="card copy-prev">
              <label className="k" htmlFor="copy-from">前回のイベントからコピー</label>
              <div className="copy-row">
                <select id="copy-from" value={fromId} onChange={(e) => setCopyFrom(e.target.value)}>
                  {data.others.map((e) => <option key={e.id} value={e.id}>{e.held_on} {e.name}</option>)}
                </select>
                <button className="sbtn acc" onClick={() => void copyPrevious(fromId)}>コピー</button>
              </div>
              <p className="note">持ち込む品目・数・イベント価格を下に入れます。在庫は「持ち込みを反映する」を押すまで動きません。釣り銭と経費は、まだ入れていないときだけ写します。</p>
            </div>
          )}
          {data.items.length === 0 && (
            <div className="card"><p className="note">品目がまだありません。</p><Link className="btn center" to="/items/new">品目を追加</Link></div>
          )}
          <div className="card prep">
            {ordered.map((i) => {
              const l = lineOf(i.id);
              const o = owner(i.owner_id);
              const own = o?.is_self ?? true;
              const atHome = home ? data.stock.get(`${i.id}|${home.id}`) ?? 0 : 0;
              const prepared = data.prepared.get(i.id) ?? 0;
              return (
                <div key={i.id} className={`prep-row${l.included ? '' : ' off'}`}>
                  <label className="check">
                    <input type="checkbox" checked={l.included} disabled={locked} onChange={(e) => setLine(i.id, { included: e.target.checked })} />
                    <span>
                      <b>{i.name}</b>
                      <small className="k">
                        {yen(i.price)}{o && !own ? `・受託: ${o.name}` : ''}
                        {i.kind === 'set' ? '・構成品の数で決まる' : own ? `・${home?.name ?? '自宅'}に ${atHome}部` : ''}
                      </small>
                    </span>
                  </label>
                  {l.included && i.kind !== 'set' && (
                    <div className="rowx">
                      <span className="k">{own ? '持ち込み' : '預かり'}{prepared ? `(いま ${prepared})` : ''}</span>
                      <NumberField id={`bring-${i.id}`} label={`${i.name}の${own ? '持ち込み' : '預かり'}数`} value={l.bring} onCommit={(v) => setLine(i.id, { bring: v })} />
                    </div>
                  )}
                  {l.included && (
                    <div className="rowx">
                      <label className="k" htmlFor={`price-${i.id}`}>イベント価格</label>
                      <input
                        id={`price-${i.id}`} className="price-in" inputMode="numeric" placeholder={String(i.price)}
                        value={l.priceOverride ?? ''} disabled={locked}
                        onChange={(e) => setLine(i.id, { priceOverride: e.target.value === '' ? null : Number(e.target.value.replace(/\D/g, '')) })}
                      />
                    </div>
                  )}
                  {own && l.included && i.kind !== 'set' && l.bring - prepared > atHome && (
                    <p className="msg">{home?.name ?? '自宅'}の在庫より多く持ち込もうとしています。刷り記録が未入力でないか確かめてください。</p>
                  )}
                </div>
              );
            })}
          </div>
          {!locked && home && (
            <NewItemForEvent
              ctx={ctx} eventId={eventId!} storageId={home.id} storageName={home.name} owners={data.owners.filter((o) => !o.archived_at)}
              onCreated={(id, bring) => setLines((m) => new Map(m ?? []).set(id, { itemId: id, included: true, bring, priceOverride: null }))}
            />
          )}
          <button className="btn primary" disabled={busy || locked || !changed} onClick={() => void applyBring()}>
            {changed ? '持ち込みを反映する' : '持ち込みは反映済みです'}
          </button>
          <p className="note">反映すると、自分の品目は{home?.name ?? '自宅'}からイベントへ、受託品は預かりとして在庫が動きます。あとで数を変えると、差の分だけ動きます。</p>

          {regOrder.length > 1 && (
            <>
              <h3 className="section">レジの並び順</h3>
              <div className="card order-list">
                {regOrder.map((id, i) => (
                  <div key={id} className="order-row">
                    <span className="num k">{i + 1}</span>
                    <span className="order-name">{data.items.find((x) => x.id === id)?.name}</span>
                    <button className="sbtn" aria-label="上へ" disabled={locked || i === 0} onClick={() => void move(i, -1)}>↑</button>
                    <button className="sbtn" aria-label="下へ" disabled={locked || i === regOrder.length - 1} onClick={() => void move(i, 1)}>↓</button>
                  </div>
                ))}
                <p className="note">レジでは、この順に左上から2列で並びます。よく売れるものを上にすると押しやすくなります。変えるとすぐ保存され、売り子の端末にも伝わります。</p>
              </div>
            </>
          )}

          <h3 className="section">釣り銭準備金 {yen(floatTotal)}</h3>
          <div className="card">
            {DENOMINATIONS.filter((d) => d <= 5000).map((d) => (
              <div className="dn" key={d}>
                <span className="num">{d.toLocaleString('ja-JP')}円</span>
                <NumberField
                  id={`float-${d}`} label={`${d}円の枚数`} value={floatCounts.get(d) ?? 0}
                  onCommit={(v) => void saveFloat(db, ctx, eventId!, d, v).catch((e: Error) => toast(e.message))}
                />
                <span className="sub num">{yen(d * (floatCounts.get(d) ?? 0))}</span>
              </div>
            ))}
          </div>

          <h3 className="section">経費</h3>
          <div className="card">
            {shownExpenses.length === 0 && <span className="k">まだありません。出展費や交通費を入れると、収支と損益分岐に使います。</span>}
            {shownExpenses.map((e) => (
              <div className="rowx" key={e.id}>
                <span>{e.label}</span>
                <span className="exp-amount">
                  <input
                    className="price-in" inputMode="numeric" aria-label={`${e.label}の金額`} disabled={locked}
                    defaultValue={e.actual_amount ?? e.planned_amount ?? ''}
                    onBlur={(ev) => {
                      const v = ev.target.value === '' ? 0 : Number(ev.target.value.replace(/\D/g, ''));
                      void saveExpense(db, ctx, { id: e.id, eventId: eventId!, category: e.category, label: e.label ?? undefined, planned: v ? e.planned_amount : 0, actual: v })
                        .then(() => toast(v ? '経費を保存しました' : '経費を消しました'));
                    }}
                  />
                  <small className="k">円</small>
                </span>
              </div>
            ))}
            <form
              className="exp-add"
              onSubmit={async (e) => {
                e.preventDefault();
                const v = Number(newExp.amount);
                if (!newExp.amount || !Number.isInteger(v) || v <= 0) return toast('金額を入れてください');
                await saveExpense(db, ctx, { eventId: eventId!, category: newExp.category, planned: v, actual: null });
                setNewExp({ ...newExp, amount: '' });
              }}
            >
              <select aria-label="経費の種類" value={newExp.category} onChange={(e) => setNewExp({ ...newExp, category: e.target.value as ExpenseCategory })}>
                {(Object.keys(EXPENSE_LABEL) as ExpenseCategory[]).map((k) => <option key={k} value={k}>{EXPENSE_LABEL[k]}</option>)}
              </select>
              <input className="price-in" inputMode="numeric" aria-label="金額" placeholder="7000" value={newExp.amount} onChange={(e) => setNewExp({ ...newExp, amount: e.target.value.replace(/\D/g, '') })} />
              <button className="sbtn" disabled={locked}>追加</button>
            </form>
            <p className="note">金額を空にすると、その経費を消します。印刷費は品目の「刷り記録」に入れます(売れた分が原価として収支に入るので、ここには入れません)。</p>
          </div>
        </>
      )}

      {!isNew && data.event && home && (
        <>
          <h3 className="section">イベントの削除</h3>
          <div className="card">
            <p className="note">
              一覧と分析から消します。記録は残るので、ホームの「削除したイベント」から元に戻せます。
              {locked ? '' : `終了処理をしていないので、イベントに残っている在庫は${home.name}(受託品は持ち主)に戻します。`}
            </p>
            <ConfirmButton
              label="このイベントを削除する"
              confirmLabel="もう一度押すと削除します"
              onConfirm={async () => {
                try {
                  const r = await deleteEvent(db, ctx, eventId!, { storageId: home.id });
                  toast(r.returned ? `削除しました(${r.returned}部を戻しました)` : '削除しました');
                  navigate('/');
                } catch (e) {
                  toast(e instanceof Error ? e.message : String(e));
                }
              }}
            />
          </div>
        </>
      )}
    </main>
    {!isNew && <EventNav eventId={eventId!} current="prepare" />}
    </>
  );
}
