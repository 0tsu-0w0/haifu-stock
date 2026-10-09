import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../app/db';
import { useCtx } from '../app/useCtx';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { restoreItem } from '../domain/catalog';
import { stockByLocation } from '../domain/ledger';
import { yen } from '../lib/format';

const KIND_LABEL = { book: '本', goods: 'グッズ', set: 'セット' } as const;

// 品目の一覧(F-101、F-203)。持ち主ごとに分け、自宅などの在庫も出す
export function ItemsPage() {
  const ctx = useCtx();
  const [showArchived, setShowArchived] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const toast = useToast();
  const data = useLiveQuery(async () => {
    if (!ctx) return null;
    const [items, owners, storages, movements, txns] = await Promise.all([
      db.items.where('circle_id').equals(ctx.circleId).toArray(),
      db.owners.where('circle_id').equals(ctx.circleId).toArray(),
      db.locations.where('circle_id').equals(ctx.circleId).filter((l) => l.kind === 'storage').toArray(),
      db.stock_movements.toArray(),
      db.transactions.toArray(),
    ]);
    return { items, owners, storages, stock: stockByLocation(movements, txns) };
  }, [ctx?.circleId]);

  if (!data) return <main className="page" />;
  const { items, owners, storages, stock } = data;
  const atStorage = (id: string) => storages.reduce((a, l) => a + (stock.get(`${id}|${l.id}`) ?? 0), 0);
  const groups = [...owners].sort((a, b) => Number(b.is_self) - Number(a.is_self));
  const live = items.filter((i) => !i.deleted_at);
  const deleted = items.filter((i) => i.deleted_at);
  const archivedCount = live.filter((i) => i.archived_at).length;

  return (
    <main className="page">
      <PageHeader title="品目" right={<Link className="sbtn acc" to="/items/new">品目を追加</Link>} />
      <Link className="card row-link" to="/stocktake">
        <span><b>棚卸し</b><small>自宅の在庫を数えて、実際の数に合わせる(通販で発送した分など)</small></span>
        <span className="go-label">数える</span>
      </Link>

      {live.length === 0 && (
        <div className="card">
          <p>まだ品目がありません。頒布する本やグッズ、受託品を登録してください。</p>
          <Link className="btn primary center" to="/items/new">品目を追加</Link>
        </div>
      )}

      {groups.map((o) => {
        const mine = live.filter((i) => i.owner_id === o.id && (showArchived || !i.archived_at));
        if (mine.length === 0) return null;
        return (
          <section key={o.id} className="group">
            <h3 className="section">{o.is_self ? '自分の頒布物' : `受託: ${o.name}(手数料 ${Math.round(o.default_fee_rate * 100)}%)`}</h3>
            <ul className="list">
              {mine.map((i) => (
                <li key={i.id}>
                  <Link className={`card row-link${i.archived_at ? ' archived' : ''}`} to={`/items/${i.id}`}>
                    <span>
                      <b>{i.name}</b>
                      <small>{KIND_LABEL[i.kind]}・{yen(i.price)}{i.archived_at ? '・アーカイブ済み' : ''}</small>
                    </span>
                    {o.is_self && i.kind !== 'set' && <span className="k num">保管 {atStorage(i.id)}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {archivedCount > 0 && (
        <button className="link-btn" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? 'アーカイブ済みを隠す' : `アーカイブ済みも表示(${archivedCount}件)`}
        </button>
      )}

      {deleted.length > 0 && (
        <>
          <button className="link-btn" onClick={() => setShowDeleted((v) => !v)}>
            {showDeleted ? '削除した品目を隠す' : `削除した品目(${deleted.length}件)`}
          </button>
          {showDeleted && (
            <div className="card">
              {deleted.map((i) => (
                <div className="rowx" key={i.id}>
                  <span>{i.name}<small className="k"> {yen(i.price)}</small></span>
                  <button className="sbtn" onClick={async () => { await restoreItem(db, i.id); toast(`${i.name} を元に戻しました`); }}>元に戻す</button>
                </div>
              ))}
              <p className="note">削除した品目は、一覧・イベントの準備・分析に出なくなります。売った記録は残っているので、元に戻せます。</p>
            </div>
          )}
        </>
      )}
    </main>
  );
}
