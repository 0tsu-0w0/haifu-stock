import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../app/AuthProvider';
import { db } from '../app/db';
import { usePref } from '../app/prefs';
import { useCtx } from '../app/useCtx';
import { AccountBar } from '../components/AccountBar';
import { DataExport } from '../components/DataExport';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import type { Owner } from '../db/types';
import { renameLocation, saveCircleName, saveOwner, setOwnerArchived } from '../domain/catalog';

// 設定: サークル名、保管場所の名前、受託元(持ち主)、ログイン
export function SettingsPage() {
  const ctx = useCtx();
  const toast = useToast();
  const { role } = useAuth();
  const data = useLiveQuery(async () => {
    if (!ctx) return null;
    const [circle, storages, owners] = await Promise.all([
      db.circles.get(ctx.circleId),
      db.locations.where('circle_id').equals(ctx.circleId).filter((l) => l.kind === 'storage').toArray(),
      db.owners.where('circle_id').equals(ctx.circleId).toArray(),
    ]);
    return { circle, storages, owners };
  }, [ctx?.circleId]);
  const [circleName, setCircleName] = useState('');
  const [newOwner, setNewOwner] = useState({ name: '', fee: '' });
  const [showArchived, setShowArchived] = useState(false);
  const [showBE, setShowBE] = usePref('showBreakEven');
  const [instant, setInstant] = usePref('instantSale');

  useEffect(() => {
    if (data?.circle) setCircleName(data.circle.name);
  }, [data?.circle?.name]);

  if (!ctx || !data) return <main className="page" />;
  if (role !== 'owner') {
    return (
      <main className="page">
        <p className="lead">設定はサークル主が変えます。</p>
        <AccountBar />
        <Link className="link-btn" to="/">ホームに戻る</Link>
      </main>
    );
  }

  const attempt = async (fn: () => Promise<void>, done: string) => {
    try {
      await fn();
      toast(done);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  const consign = data.owners.filter((o) => !o.is_self).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const archivedCount = consign.filter((o) => o.archived_at).length;

  return (
    <main className="page">
      <PageHeader title="設定" />

      <h3 className="section">サークル</h3>
      <form
        className="card form"
        onSubmit={(e) => { e.preventDefault(); void attempt(() => saveCircleName(db, ctx, circleName), 'サークル名を保存しました'); }}
      >
        <label htmlFor="circle-name">サークル名</label>
        <input id="circle-name" value={circleName} onChange={(e) => setCircleName(e.target.value)} />
        <button className="btn primary" disabled={!circleName.trim() || circleName.trim() === data.circle?.name}>保存する</button>
      </form>

      <h3 className="section">保管場所</h3>
      <div className="card">
        {data.storages.map((l) => (
          <NameRow key={l.id} label="保管場所の名前" value={l.name} onSave={(v) => attempt(() => renameLocation(db, l.id, v), '保管場所の名前を保存しました')} />
        ))}
        <p className="note">在庫を置いている場所です(例: 自宅、実家)。持ち込みや終了処理の戻し先に出ます。</p>
      </div>

      <h3 className="section">受託元(預かる本の持ち主)</h3>
      <div className="card">
        {consign.length === 0 && <p className="note">まだありません。受託品を預かるときに登録します。</p>}
        {consign.filter((o) => showArchived || !o.archived_at).map((o) => (
          <OwnerRow
            key={o.id}
            owner={o}
            onSave={(name, fee) => attempt(async () => { await saveOwner(db, ctx, { id: o.id, name, feeRate: fee }); }, `${name} を保存しました`)}
            onArchive={(on) => attempt(() => setOwnerArchived(db, o.id, on), on ? `${o.name} をしまいました` : `${o.name} を戻しました`)}
          />
        ))}
        {archivedCount > 0 && (
          <button className="link-btn" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? 'しまった受託元を隠す' : `しまった受託元も表示(${archivedCount}件)`}
          </button>
        )}
        <form
          className="owner-add"
          onSubmit={(e) => {
            e.preventDefault();
            const fee = newOwner.fee === '' ? 0 : Number(newOwner.fee) / 100;
            void attempt(async () => {
              await saveOwner(db, ctx, { name: newOwner.name, feeRate: fee });
              setNewOwner({ name: '', fee: '' });
            }, `${newOwner.name.trim()} を追加しました`);
          }}
        >
          <input aria-label="受託元の名前" placeholder="サークル名" value={newOwner.name} onChange={(e) => setNewOwner({ ...newOwner, name: e.target.value })} />
          <span className="exp-amount">
            <input className="price-in fee-in" inputMode="decimal" aria-label="受託手数料(%)" placeholder="0" value={newOwner.fee} onChange={(e) => setNewOwner({ ...newOwner, fee: e.target.value.replace(/[^\d.]/g, '') })} />
            <small className="k">%</small>
          </span>
          <button className="sbtn" disabled={!newOwner.name.trim()}>追加</button>
        </form>
        <p className="note">受託手数料は、売上から差し引いて自分の収入にする割合です。しまった受託元は、品目の登録で選べなくなります。過去の記録と精算は残ります。</p>
      </div>

      <h3 className="section">レジと表示(この端末だけ)</h3>
      <div className="card">
        <label className="check">
          <input type="checkbox" checked={instant} onChange={(e) => setInstant(e.target.checked)} />
          <span>
            <b>レジでタップしたらすぐ記録する</b>
            <small className="k">オフ(おすすめ)のときは、タップした品目をカートに入れ、「決済」を押して記録します。オンにすると、タップした瞬間に1部ずつ記録し、まとめ買いは「カート」から入れます。</small>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={showBE} onChange={(e) => setShowBE(e.target.checked)} />
          <span>
            <b>レジに黒字までの残り金額を出す</b>
            <small className="k">経費を入れたイベントで、レジの上に「黒字まで あと◯円」を小さく出します。サークル主の端末だけに出ます。</small>
          </span>
        </label>
      </div>

      <h3 className="section">データ</h3>
      <DataExport ctx={ctx} />

      <h3 className="section">ログイン</h3>
      <AccountBar />
    </main>
  );
}

function NameRow({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => Promise<void> }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <form className="name-row" onSubmit={(e) => { e.preventDefault(); void onSave(v); }}>
      <input aria-label={label} value={v} onChange={(e) => setV(e.target.value)} />
      <button className="sbtn" disabled={!v.trim() || v.trim() === value}>保存</button>
    </form>
  );
}

function OwnerRow({ owner, onSave, onArchive }: {
  owner: Owner; onSave: (name: string, fee: number) => Promise<void>; onArchive: (on: boolean) => Promise<void>;
}) {
  const pct = (r: number) => String(Math.round(r * 1000) / 10);
  const [name, setName] = useState(owner.name);
  const [fee, setFee] = useState(pct(owner.default_fee_rate));
  useEffect(() => { setName(owner.name); setFee(pct(owner.default_fee_rate)); }, [owner.name, owner.default_fee_rate]);
  const changed = name.trim() !== owner.name || Number(fee || 0) / 100 !== owner.default_fee_rate;
  return (
    <div className={`owner-row${owner.archived_at ? ' archived' : ''}`}>
      <form className="owner-add" onSubmit={(e) => { e.preventDefault(); void onSave(name, Number(fee || 0) / 100); }}>
        <input aria-label={`${owner.name}の名前`} value={name} onChange={(e) => setName(e.target.value)} />
        <span className="exp-amount">
          <input className="price-in fee-in" inputMode="decimal" aria-label={`${owner.name}の受託手数料(%)`} value={fee} onChange={(e) => setFee(e.target.value.replace(/[^\d.]/g, ''))} />
          <small className="k">%</small>
        </span>
        <button className="sbtn" disabled={!changed || !name.trim()}>保存</button>
      </form>
      <button className="link-btn small-link" onClick={() => void onArchive(!owner.archived_at)}>
        {owner.archived_at ? '戻す' : 'しまう'}
      </button>
    </div>
  );
}
