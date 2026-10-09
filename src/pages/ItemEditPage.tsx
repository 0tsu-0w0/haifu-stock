import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { db } from '../app/db';
import { useCtx } from '../app/useCtx';
import { ConfirmButton } from '../components/ConfirmButton';
import { NumberField } from '../components/NumberField';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import type { ItemKind } from '../db/types';
import { addPrintRun, deleteItem, restoreItem, saveItem, saveOwner, setItemArchived } from '../domain/catalog';
import { breakEvenQty, stockByLocation } from '../domain/ledger';
import { yen } from '../lib/format';

const NEW_OWNER = '__new__';

// 品目の登録・編集(F-101〜104)と刷り記録(F-102)
export function ItemEditPage() {
  const { itemId } = useParams();
  const isNew = !itemId || itemId === 'new';
  const ctx = useCtx();
  const navigate = useNavigate();
  const toast = useToast();

  const data = useLiveQuery(async () => {
    if (!ctx) return null;
    const [item, owners, items, storages, runs, comps, movements, txns] = await Promise.all([
      isNew ? undefined : db.items.get(itemId!),
      db.owners.where('circle_id').equals(ctx.circleId).toArray(),
      db.items.where('circle_id').equals(ctx.circleId).filter((i) => !i.archived_at && !i.deleted_at).toArray(),
      db.locations.where('circle_id').equals(ctx.circleId).filter((l) => l.kind === 'storage').toArray(),
      isNew ? [] : db.print_runs.where('item_id').equals(itemId!).sortBy('edition'),
      isNew ? [] : db.set_components.where('set_item_id').equals(itemId!).toArray(),
      isNew ? [] : db.stock_movements.where('item_id').equals(itemId!).toArray(),
      db.transactions.toArray(),
    ]);
    // しまった受託元は選べないようにする(この品目の今の持ち主だけは残す)
    return { item, owners: owners.filter((o) => !o.archived_at || o.id === item?.owner_id), items, storages, runs, comps, stock: stockByLocation(movements, txns) };
  }, [ctx?.circleId, itemId]);

  const [form, setForm] = useState({ name: '', kind: 'book' as ItemKind, price: '', ownerId: '', low: '3' });
  const [newOwner, setNewOwner] = useState({ name: '', fee: '0' });
  const [components, setComponents] = useState<Map<string, number>>(new Map());
  const [run, setRun] = useState({ qty: '', cost: '', date: '', printer: '' });
  const [error, setError] = useState('');
  const [runError, setRunError] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!data || loaded) return;
    const self = data.owners.find((o) => o.is_self);
    if (data.item) {
      setForm({ name: data.item.name, kind: data.item.kind, price: String(data.item.price), ownerId: data.item.owner_id, low: String(data.item.low_threshold) });
    } else if (self) {
      setForm((f) => ({ ...f, ownerId: self.id }));
    }
    setLoaded(true);
  }, [data, loaded]);

  if (!ctx || !data) return <main className="page" />;
  if (!isNew && !data.item) {
    return <main className="page"><p>品目が見つかりません。</p><Link to="/items">品目の一覧に戻る</Link></main>;
  }
  const item = data.item;
  const owner = data.owners.find((o) => o.id === form.ownerId);
  const isOwn = form.ownerId !== NEW_OWNER && (owner?.is_self ?? false);
  const candidates = data.items.filter((i) => i.kind !== 'set' && i.id !== item?.id);
  const fixedCost = data.runs.reduce((a, r) => a + r.total_cost, 0);
  const printed = data.runs.reduce((a, r) => a + r.qty, 0);
  const home = data.storages[0];

  async function save() {
    setError('');
    try {
      let ownerId = form.ownerId;
      if (ownerId === NEW_OWNER) {
        const fee = Number(newOwner.fee);
        ownerId = (await saveOwner(db, ctx!, { name: newOwner.name, feeRate: Number.isFinite(fee) ? fee / 100 : NaN })).id;
      }
      const saved = await saveItem(db, ctx!, {
        id: item?.id, name: form.name, kind: form.kind, price: Number(form.price === '' ? NaN : form.price), ownerId,
        lowThreshold: Number(form.low === '' ? NaN : form.low),
        components: [...components].filter(([, q]) => q > 0).map(([id, q]) => ({ itemId: id, qty: q })),
      });
      toast(item ? '保存しました' : `${saved.name} を登録しました`);
      if (!item) navigate(`/items/${saved.id}`, { replace: true });
      else setForm((f) => ({ ...f, ownerId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function addRun() {
    setRunError('');
    if (!item || !home) return;
    try {
      await addPrintRun(db, ctx!, {
        itemId: item.id, qty: Number(run.qty || NaN), totalCost: Number(run.cost || NaN),
        printedOn: run.date || null, printer: run.printer, toLocationId: home.id,
      });
      setRun({ qty: '', cost: '', date: '', printer: '' });
      toast(`刷り記録を追加し、${home.name}に入れました`);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    }
  }

  const be = item && item.kind !== 'set' ? breakEvenQty(fixedCost, item.price) : null;

  return (
    <main className="page">
      <PageHeader title={item ? item.name : '品目を追加'} back="/items" backLabel="品目" />

      <form className="card form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label htmlFor="item-name">品目名</label>
        <input id="item-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="新刊「夜行列車の記録」" />

        <span className="label-like">種類</span>
        <div className="chips" role="radiogroup" aria-label="種類">
          {(['book', 'goods', 'set'] as const).map((k) => (
            <button
              key={k} type="button" className="chip" role="radio" aria-checked={form.kind === k} aria-pressed={form.kind === k}
              disabled={!!item && item.kind !== k}
              onClick={() => setForm({ ...form, kind: k })}
            >
              {k === 'book' ? '本' : k === 'goods' ? 'グッズ' : 'セット'}
            </button>
          ))}
        </div>

        <label htmlFor="item-price">頒布価格(円)</label>
        <input id="item-price" inputMode="numeric" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value.replace(/\D/g, '') })} placeholder="800" />

        {form.kind !== 'set' && (
          <>
            <label htmlFor="item-owner">持ち主</label>
            <select id="item-owner" value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
              {data.owners.map((o) => <option key={o.id} value={o.id}>{o.is_self ? '自分' : `受託: ${o.name}`}</option>)}
              <option value={NEW_OWNER}>受託元を新しく追加…</option>
            </select>
            {form.ownerId === NEW_OWNER && (
              <div className="subform">
                <label htmlFor="owner-name">受託元のサークル名</label>
                <input id="owner-name" value={newOwner.name} onChange={(e) => setNewOwner({ ...newOwner, name: e.target.value })} placeholder="サークルB" />
                <label htmlFor="owner-fee">受託手数料(%)</label>
                <input id="owner-fee" inputMode="decimal" value={newOwner.fee} onChange={(e) => setNewOwner({ ...newOwner, fee: e.target.value })} />
              </div>
            )}
          </>
        )}

        {form.kind === 'set' && (
          <>
            <span className="label-like">セットの中身</span>
            {item ? (
              <ul className="plain">
                {data.comps.map((c) => (
                  <li key={c.component_item_id}>{data.items.find((i) => i.id === c.component_item_id)?.name ?? '不明な品目'} ×{c.qty}</li>
                ))}
                <li className="note">中身は作ったあとで変えられません。変えるときは新しいセットを作ってください。</li>
              </ul>
            ) : (
              <div className="comp-list">
                {candidates.length === 0 && <p className="note">先にセットに入れる品目を登録してください。</p>}
                {candidates.map((i) => (
                  <div className="rowx" key={i.id}>
                    <span>{i.name}<small className="k"> {yen(i.price)}</small></span>
                    <NumberField
                      id={`comp-${i.id}`} label={`${i.name}の数`} value={components.get(i.id) ?? 0}
                      onCommit={(v) => setComponents((m) => new Map(m).set(i.id, v))}
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <label htmlFor="item-low">「残りわずか」と表示する部数</label>
        <input id="item-low" inputMode="numeric" value={form.low} onChange={(e) => setForm({ ...form, low: e.target.value.replace(/\D/g, '') })} />

        {error && <p className="error">{error}</p>}
        <button className="btn primary">{item ? '保存する' : '登録する'}</button>
      </form>

      {item && item.kind !== 'set' && isOwn && (
        <>
          <h3 className="section">在庫</h3>
          <div className="card">
            {data.storages.map((l) => (
              <div className="rowx" key={l.id}><span>{l.name}</span><b className="num">{data.stock.get(`${item.id}|${l.id}`) ?? 0}部</b></div>
            ))}
          </div>

          <h3 className="section">刷り記録</h3>
          <div className="card">
            {data.runs.length === 0 && <span className="k">まだありません。刷った部数と印刷費を入れると、{home?.name ?? '自宅'}の在庫に入ります。</span>}
            {data.runs.map((r) => (
              <div className="rowx" key={r.id}>
                <span>{r.edition === 1 ? '初版' : `第${r.edition}版`}{r.printed_on ? `・${r.printed_on}` : ''}{r.printer ? `・${r.printer}` : ''}</span>
                <span className="k num">{r.qty}部 {yen(r.total_cost)}</span>
              </div>
            ))}
            {data.runs.length > 0 && be !== null && (
              <p className="note">印刷費の合計 {yen(fixedCost)}(1部あたり {yen(Math.round(fixedCost / printed))})。{yen(item.price)}で {be}部売ると回収できます。</p>
            )}
            {data.runs.length > 0 && (
              <Link className="sub-link" to={`/analysis?tab=item&item=${item.id}`}>損益分岐のグラフを見る</Link>
            )}
          </div>

          <form className="card form" onSubmit={(e) => { e.preventDefault(); void addRun(); }}>
            <b>刷り記録を追加</b>
            <div className="two">
              <span>
                <label htmlFor="run-qty">刷った部数</label>
                <input id="run-qty" inputMode="numeric" value={run.qty} onChange={(e) => setRun({ ...run, qty: e.target.value.replace(/\D/g, '') })} placeholder="50" />
              </span>
              <span>
                <label htmlFor="run-cost">印刷費(円)</label>
                <input id="run-cost" inputMode="numeric" value={run.cost} onChange={(e) => setRun({ ...run, cost: e.target.value.replace(/\D/g, '') })} placeholder="30000" />
              </span>
            </div>
            <div className="two">
              <span>
                <label htmlFor="run-date">刷った日</label>
                <input id="run-date" type="date" value={run.date} onChange={(e) => setRun({ ...run, date: e.target.value })} />
              </span>
              <span>
                <label htmlFor="run-printer">印刷所</label>
                <input id="run-printer" value={run.printer} onChange={(e) => setRun({ ...run, printer: e.target.value })} placeholder="任意" />
              </span>
            </div>
            {runError && <p className="error">{runError}</p>}
            <button className="btn">追加して{home?.name ?? '自宅'}に入れる</button>
          </form>
        </>
      )}

      {item && (
        <button
          className="link-btn"
          onClick={async () => {
            await setItemArchived(db, item.id, !item.archived_at);
            toast(item.archived_at ? 'アーカイブから戻しました' : 'アーカイブしました。新しいイベントの候補に出なくなります');
          }}
        >
          {item.archived_at ? 'アーカイブから戻す' : 'この品目をアーカイブする'}
        </button>
      )}

      {item && (item.deleted_at ? (
        <div className="card">
          <p className="note">この品目は削除済みです。</p>
          <button className="btn" onClick={async () => { await restoreItem(db, item.id); toast('元に戻しました'); }}>元に戻す</button>
        </div>
      ) : (
        <ConfirmButton
          label="この品目を削除する"
          confirmLabel="もう一度押すと削除します"
          onConfirm={async () => {
            try {
              await deleteItem(db, item.id);
              toast(`${item.name} を削除しました。「品目」の画面の下から元に戻せます`);
              navigate('/items');
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e));
            }
          }}
        />
      ))}
    </main>
  );
}
