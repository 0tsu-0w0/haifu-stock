import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../app/db';
import { useCtx } from '../app/useCtx';
import { NumberField } from '../components/NumberField';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { transferBetweenStorages } from '../domain/catalog';
import { storageStock } from '../domain/stock';

// 保管場所どうしの在庫の移動(F-202、Issue #30)。例: 実家から自宅へ、次のイベントの分を持ってくる
export function MoveStockPage() {
  const ctx = useCtx();
  const toast = useToast();
  const data = useLiveQuery(async () => {
    if (!ctx) return null;
    const [items, storages, stock] = await Promise.all([
      db.items.where('circle_id').equals(ctx.circleId).filter((i) => !i.deleted_at && i.kind !== 'set').toArray(),
      db.locations.where('circle_id').equals(ctx.circleId).filter((l) => l.kind === 'storage' && !l.archived_at).toArray(),
      storageStock(db, ctx.circleId),
    ]);
    return { items, storages, stock };
  }, [ctx?.circleId]);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [qty, setQty] = useState<Map<string, number>>(new Map());
  const [busy, setBusy] = useState(false);

  const from = data?.storages.find((l) => l.id === fromId) ?? data?.storages[0];
  const to = data?.storages.find((l) => l.id === toId && l.id !== from?.id) ?? data?.storages.find((l) => l.id !== from?.id);
  const rows = useMemo(() => {
    if (!data || !from) return [];
    return data.items
      .map((i) => ({ item: i, have: data.stock.get(`${i.id}|${from.id}`) ?? 0, there: to ? data.stock.get(`${i.id}|${to.id}`) ?? 0 : 0 }))
      .filter((r) => r.have > 0)
      .sort((a, b) => a.item.name.localeCompare(b.item.name, 'ja'));
  }, [data, from, to]);

  if (!ctx || !data) return <main className="page" />;
  if (data.storages.length < 2) {
    return (
      <main className="page">
        <PageHeader title="在庫を移す" back="/items" backLabel="品目" />
        <div className="card">
          <p className="note">保管場所が1つだけです。実家や倉庫など、在庫を置く場所が2つ以上あるときに使います。</p>
          <Link className="btn center" to="/settings">設定で保管場所を足す</Link>
        </div>
      </main>
    );
  }
  const lines = rows.filter((r) => (qty.get(r.item.id) ?? 0) > 0).map((r) => ({ itemId: r.item.id, qty: Math.min(qty.get(r.item.id)!, r.have) }));
  const total = lines.reduce((a, l) => a + l.qty, 0);

  async function save() {
    if (!from || !to) return;
    setBusy(true);
    try {
      const { moved } = await transferBetweenStorages(db, ctx!, { from: from.id, to: to.id, lines });
      toast(`${moved}品目・${total}部を「${from.name}」から「${to.name}」へ移しました`);
      setQty(new Map());
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <PageHeader title="在庫を移す" sub="保管場所どうしで" back="/items" backLabel="品目" />
      <div className="card form">
        <div className="two">
          <span>
            <label htmlFor="mv-from">移す前</label>
            <select id="mv-from" value={from?.id ?? ''} onChange={(e) => { setFromId(e.target.value); setQty(new Map()); }}>
              {data.storages.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </span>
          <span>
            <label htmlFor="mv-to">移した後</label>
            <select id="mv-to" value={to?.id ?? ''} onChange={(e) => setToId(e.target.value)}>
              {data.storages.filter((l) => l.id !== from?.id).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </span>
        </div>
      </div>
      {rows.length === 0 && <div className="card"><p className="note">「{from?.name}」に在庫がありません。</p></div>}
      {rows.length > 0 && (
        <div className="card prep">
          {rows.map(({ item, have, there }) => (
            <div key={item.id} className="prep-row">
              <div className="rowx">
                <span>
                  <b>{item.name}</b>
                  <small className="k"> {from?.name} {have}部・{to?.name} {there}部</small>
                </span>
                <NumberField
                  id={`mv-${item.id}`} label={`${item.name}の移す部数`} value={qty.get(item.id) ?? 0}
                  onCommit={(v) => setQty((m) => new Map(m).set(item.id, Math.min(v, have)))}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      <button className="btn primary" disabled={busy || total === 0 || !to} onClick={() => void save()}>
        {total ? `${total}部を「${to?.name}」へ移す` : '移す部数を入れてください'}
      </button>
      <p className="note">移した記録は、設定の「在庫の履歴(CSV)」で確かめられます。販売ではないので、刷り部数の目安には入りません。</p>
    </main>
  );
}
