import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { db } from '../app/db';
import { useCtx } from '../app/useCtx';
import { NumberField } from '../components/NumberField';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { STOCKTAKE_REASON, recordStocktake, type StocktakeReason } from '../domain/catalog';
import { stockByLocation } from '../domain/ledger';

// 棚卸し(F-204): 保管場所の実際の数を入れ、帳簿との差を理由つきで合わせる
export function StocktakePage() {
  const ctx = useCtx();
  const toast = useToast();
  const data = useLiveQuery(async () => {
    if (!ctx) return null;
    const [items, owners, storages, movements, txns] = await Promise.all([
      db.items.where('circle_id').equals(ctx.circleId).filter((i) => !i.deleted_at && i.kind !== 'set').toArray(),
      db.owners.where('circle_id').equals(ctx.circleId).toArray(),
      db.locations.where('circle_id').equals(ctx.circleId).filter((l) => l.kind === 'storage' && !l.archived_at).toArray(),
      db.stock_movements.toArray(),
      db.transactions.toArray(),
    ]);
    const self = new Set(owners.filter((o) => o.is_self).map((o) => o.id));
    return { items: items.filter((i) => self.has(i.owner_id)), storages, stock: stockByLocation(movements, txns) };
  }, [ctx?.circleId]);
  const [locId, setLocId] = useState('');
  const [counted, setCounted] = useState<Map<string, number>>(new Map());
  const [reasons, setReasons] = useState<Map<string, StocktakeReason>>(new Map());
  const [busy, setBusy] = useState(false);

  const loc = data?.storages.find((l) => l.id === locId) ?? data?.storages[0];
  const rows = useMemo(() => {
    if (!data || !loc) return [];
    return data.items
      .map((i) => ({ item: i, book: data.stock.get(`${i.id}|${loc.id}`) ?? 0 }))
      .filter((r) => r.book !== 0 || !r.item.archived_at)
      .sort((a, b) => a.item.name.localeCompare(b.item.name, 'ja'));
  }, [data, loc]);

  if (!ctx || !data) return <main className="page" />;
  const diffs = rows.filter((r) => counted.has(r.item.id) && counted.get(r.item.id) !== r.book);

  async function save() {
    if (!loc) return;
    setBusy(true);
    try {
      const { adjusted } = await recordStocktake(db, ctx!, {
        locationId: loc.id,
        lines: diffs.map((r) => ({
          itemId: r.item.id, counted: counted.get(r.item.id)!,
          reason: reasons.get(r.item.id) ?? (counted.get(r.item.id)! < r.book ? 'mail_order' : 'found'),
        })),
      });
      toast(adjusted ? `${adjusted}品目の在庫を合わせました` : '差はありませんでした');
      setCounted(new Map());
      setReasons(new Map());
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <PageHeader title="棚卸し" sub="手元の実際の数に合わせる" back="/items" backLabel="品目" />
      {data.storages.length > 1 && (
        <div className="card">
          <label className="k" htmlFor="st-loc">数える場所</label>
          <select id="st-loc" value={loc?.id ?? ''} onChange={(e) => { setLocId(e.target.value); setCounted(new Map()); }}>
            {data.storages.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
      )}
      <p className="note">
        {loc?.name ?? '自宅'}にある自分の本・グッズを数えて、実際の数を入れてください。入れた品目だけ、差を「調整」として記録します。
        通販での発送や手渡しなど、アプリの外で減った分はここで合わせます(販売には数えないので、次の刷り部数の目安には入りません)。
      </p>
      {rows.length === 0 && <div className="card"><p className="note">数える品目がありません。</p></div>}
      <div className="card prep">
        {rows.map(({ item, book }) => {
          const c = counted.get(item.id);
          const diff = c === undefined ? 0 : c - book;
          return (
            <div key={item.id} className="prep-row">
              <div className="rowx">
                <span><b>{item.name}</b><small className="k"> 帳簿 {book}部</small></span>
                <NumberField
                  id={`st-${item.id}`} label={`${item.name}の実際の数`} value={c ?? book}
                  onCommit={(v) => setCounted((m) => new Map(m).set(item.id, v))}
                />
              </div>
              {diff !== 0 && (
                <div className="rowx">
                  <span className={`k num ${diff < 0 ? 'neg-num' : 'pos'}`}>{diff > 0 ? `+${diff}` : diff}部</span>
                  <select
                    aria-label={`${item.name}の差の理由`}
                    value={reasons.get(item.id) ?? (diff < 0 ? 'mail_order' : 'found')}
                    onChange={(e) => setReasons((m) => new Map(m).set(item.id, e.target.value as StocktakeReason))}
                  >
                    {(Object.keys(STOCKTAKE_REASON) as StocktakeReason[]).map((k) => <option key={k} value={k}>{STOCKTAKE_REASON[k]}</option>)}
                  </select>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button className="btn primary" disabled={busy || diffs.length === 0} onClick={() => void save()}>
        {diffs.length ? `${diffs.length}品目の差を記録する` : '差のある品目はありません'}
      </button>
      <p className="note">記録した調整は、設定の「在庫の履歴(CSV)」で、理由と一緒に確かめられます。</p>
    </main>
  );
}
