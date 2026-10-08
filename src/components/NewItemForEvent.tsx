import { useState } from 'react';
import { db } from '../app/db';
import type { Owner } from '../db/types';
import { createItemForEvent } from '../domain/catalog';
import type { Ctx } from '../domain/record';
import { useToast } from './Toast';

const NEW_OWNER = '__new__';
const digits = (v: string) => v.replace(/\D/g, '');

/** 準備画面から、新しい品目を作ってそのまま持ち込みに加えるフォーム */
export function NewItemForEvent(props: {
  ctx: Ctx;
  eventId: string;
  storageId: string;
  storageName: string;
  owners: Owner[];
  onCreated: (itemId: string, bring: number) => void;
}) {
  const { ctx, eventId, storageId, storageName, owners } = props;
  const toast = useToast();
  const self = owners.find((o) => o.is_self);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const empty = { name: '', kind: 'book' as 'book' | 'goods', price: '', ownerId: self?.id ?? '', ownerName: '', fee: '0', printQty: '', printCost: '', bring: '' };
  const [f, setF] = useState(empty);
  const own = f.ownerId !== NEW_OWNER && (owners.find((o) => o.id === f.ownerId)?.is_self ?? false);

  if (!open) {
    return (
      <button className="btn add-item" onClick={() => setOpen(true)}>
        ＋ 新しい品目を作って持ち込む
      </button>
    );
  }

  async function submit() {
    setError('');
    if (f.price === '') return setError('頒布価格を入れてください');
    if (f.bring === '') return setError(own ? '持ち込み数を入れてください' : '預かり数を入れてください');
    const fee = Number(f.fee);
    setBusy(true);
    try {
      const item = await createItemForEvent(db, ctx, eventId, {
        name: f.name,
        kind: f.kind,
        price: Number(f.price),
        owner: f.ownerId === NEW_OWNER ? { newName: f.ownerName, feeRate: Number.isFinite(fee) ? fee / 100 : NaN } : { id: f.ownerId },
        print: own && f.printQty ? { qty: Number(f.printQty), totalCost: Number(f.printCost || 0) } : null,
        bring: Number(f.bring),
      }, { storageId });
      props.onCreated(item.id, Number(f.bring));
      toast(`${item.name} を登録して、持ち込みに加えました`);
      setF({ ...empty, ownerId: f.ownerId === NEW_OWNER ? item.owner_id : f.ownerId });
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <b>新しい品目を作って持ち込む</b>

      <label htmlFor="ni-name">品目名</label>
      <input id="ni-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="新刊のおまけペーパー" autoFocus />

      <span className="label-like">種類</span>
      <div className="chips" role="radiogroup" aria-label="種類">
        {(['book', 'goods'] as const).map((k) => (
          <button key={k} type="button" className="chip" role="radio" aria-checked={f.kind === k} aria-pressed={f.kind === k} onClick={() => setF({ ...f, kind: k })}>
            {k === 'book' ? '本' : 'グッズ'}
          </button>
        ))}
      </div>
      <p className="note">セットは中身を選ぶ必要があるので、「品目」の画面で作ってください。</p>

      <div className="two">
        <span>
          <label htmlFor="ni-price">頒布価格(円)</label>
          <input id="ni-price" inputMode="numeric" value={f.price} onChange={(e) => setF({ ...f, price: digits(e.target.value) })} placeholder="500" />
        </span>
        <span>
          <label htmlFor="ni-bring">{own ? '持ち込み数' : '預かり数'}</label>
          <input id="ni-bring" inputMode="numeric" value={f.bring} onChange={(e) => setF({ ...f, bring: digits(e.target.value) })} placeholder="20" />
        </span>
      </div>

      <label htmlFor="ni-owner">持ち主</label>
      <select id="ni-owner" value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })}>
        {owners.map((o) => <option key={o.id} value={o.id}>{o.is_self ? '自分' : `受託: ${o.name}`}</option>)}
        <option value={NEW_OWNER}>受託元を新しく追加…</option>
      </select>
      {f.ownerId === NEW_OWNER && (
        <div className="subform">
          <label htmlFor="ni-owner-name">受託元のサークル名</label>
          <input id="ni-owner-name" value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} placeholder="サークルB" />
          <label htmlFor="ni-fee">受託手数料(%)</label>
          <input id="ni-fee" inputMode="decimal" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} />
        </div>
      )}

      {own && (
        <div className="subform">
          <span className="label-like">刷り記録(任意)</span>
          <div className="two">
            <span>
              <label htmlFor="ni-print-qty">刷った部数</label>
              <input id="ni-print-qty" inputMode="numeric" value={f.printQty} onChange={(e) => setF({ ...f, printQty: digits(e.target.value) })} placeholder="30" />
            </span>
            <span>
              <label htmlFor="ni-print-cost">印刷費(円)</label>
              <input id="ni-print-cost" inputMode="numeric" value={f.printCost} onChange={(e) => setF({ ...f, printCost: digits(e.target.value) })} placeholder="5000" />
            </span>
          </div>
          <p className="note">入れると{storageName}の在庫に入り、そこから持ち込みます。損益分岐の計算にも使います。</p>
          {f.printQty !== '' && f.bring !== '' && Number(f.bring) > Number(f.printQty) && (
            <p className="msg">持ち込み数が刷った部数より多くなっています。</p>
          )}
        </div>
      )}

      {error && <p className="error">{error}</p>}
      <div className="two">
        <button type="button" className="btn" onClick={() => { setOpen(false); setError(''); }}>やめる</button>
        <button className="btn primary" disabled={busy}>{busy ? '登録中…' : '登録して持ち込む'}</button>
      </div>
    </form>
  );
}
