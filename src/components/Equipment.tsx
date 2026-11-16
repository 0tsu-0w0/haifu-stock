import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { db } from '../app/db';
import type { Equipment } from '../db/types';
import { applyEquipment, equipmentStates, saveEquipment, setEquipmentArchived, type EquipmentState } from '../domain/equipment';
import type { Ctx } from '../domain/record';
import { yen } from '../lib/format';
import { useToast } from './Toast';

// 備品(F-310)。設定で登録し、イベントの準備の「経費」で使う

function useEquipmentStates(circleId: string) {
  return useLiveQuery(async () => {
    const [equipment, expenses] = await Promise.all([
      db.equipment.where('circle_id').equals(circleId).toArray(),
      db.expenses.where('equipment_id').above('').toArray(),
    ]);
    return equipmentStates(equipment.sort((a, b) => a.name.localeCompare(b.name, 'ja')), expenses);
  }, [circleId]);
}

const digits = (v: string) => v.replace(/\D/g, '');

/** 設定の「備品」 */
export function EquipmentCard({ ctx }: { ctx: Ctx }) {
  const toast = useToast();
  const states = useEquipmentStates(ctx.circleId);
  const [form, setForm] = useState({ name: '', cost: '', uses: '5' });
  const [showArchived, setShowArchived] = useState(false);
  if (!states) return <div className="card" />;
  const archived = states.filter((s) => s.equipment.archived_at).length;
  const attempt = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="card">
      {states.length === 0 && <p className="note">ブックスタンドやテーブルクロスのように、何回も使うものを登録します。イベントの準備の「経費」で使うと、買った金額を使う回数で割った分がそのイベントの経費になります。</p>}
      {states.filter((s) => showArchived || !s.equipment.archived_at).map((s) => (
        <EquipmentRow
          key={s.equipment.id} state={s}
          onSave={(v) => attempt(() => saveEquipment(db, ctx, { id: s.equipment.id, boughtOn: s.equipment.bought_on, ...v }), `${v.name.trim()} を保存しました`)}
          onArchive={(on) => attempt(() => setEquipmentArchived(db, s.equipment.id, on), on ? `${s.equipment.name} をしまいました` : `${s.equipment.name} を戻しました`)}
        />
      ))}
      {archived > 0 && (
        <button className="link-btn small-link" onClick={() => setShowArchived(!showArchived)}>
          {showArchived ? 'しまった備品を隠す' : `しまった備品も表示(${archived}件)`}
        </button>
      )}
      <form
        className="equip-form"
        onSubmit={(e) => {
          e.preventDefault();
          void attempt(async () => {
            await saveEquipment(db, ctx, { name: form.name, cost: Number(form.cost), uses: Number(form.uses) });
            setForm({ name: '', cost: '', uses: form.uses });
          }, `${form.name.trim()} を登録しました`);
        }}
      >
        <input aria-label="備品の名前" placeholder="例: ブックスタンド" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <span className="exp-amount">
          <input className="price-in" inputMode="numeric" aria-label="買った金額" placeholder="3000" value={form.cost} onChange={(e) => setForm({ ...form, cost: digits(e.target.value) })} />
          <small className="k">円</small>
        </span>
        <span className="exp-amount">
          <input className="price-in fee-in" inputMode="numeric" aria-label="使う回数" value={form.uses} onChange={(e) => setForm({ ...form, uses: digits(e.target.value) })} />
          <small className="k">回</small>
        </span>
        <button className="sbtn" disabled={!form.name.trim() || form.cost === '' || !Number(form.uses)}>登録</button>
      </form>
      <p className="note">回数は、何回のイベントで使うつもりかの見込みです。均等に割り、最後の回で端数を足します。使い切ったあとは経費に入れません。</p>
    </div>
  );
}

function EquipmentRow({ state, onSave, onArchive }: {
  state: EquipmentState;
  onSave: (v: Pick<Equipment, 'name' | 'cost' | 'uses'>) => Promise<void>;
  onArchive: (on: boolean) => Promise<void>;
}) {
  const eq = state.equipment;
  const [v, setV] = useState({ name: eq.name, cost: String(eq.cost), uses: String(eq.uses) });
  useEffect(() => setV({ name: eq.name, cost: String(eq.cost), uses: String(eq.uses) }), [eq.name, eq.cost, eq.uses]);
  const changed = v.name.trim() !== eq.name || Number(v.cost) !== eq.cost || Number(v.uses) !== eq.uses;
  return (
    <div className={`owner-row equip-row${eq.archived_at ? ' archived' : ''}`}>
      <form className="equip-form" onSubmit={(e) => { e.preventDefault(); void onSave({ name: v.name, cost: Number(v.cost), uses: Number(v.uses) }); }}>
        <input aria-label={`${eq.name}の名前`} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        <span className="exp-amount">
          <input className="price-in" inputMode="numeric" aria-label={`${eq.name}の金額`} value={v.cost} onChange={(e) => setV({ ...v, cost: digits(e.target.value) })} />
          <small className="k">円</small>
        </span>
        <span className="exp-amount">
          <input className="price-in fee-in" inputMode="numeric" aria-label={`${eq.name}の使う回数`} value={v.uses} onChange={(e) => setV({ ...v, uses: digits(e.target.value) })} />
          <small className="k">回</small>
        </span>
        <button className="sbtn" disabled={!changed || !v.name.trim() || v.cost === '' || !Number(v.uses)}>保存</button>
      </form>
      <div className="equip-sub">
        <small className="k num">
          {state.used}/{eq.uses}回 · 経費にした {yen(state.allocated)}
          {state.nextShare > 0 ? ` · 次は ${yen(state.nextShare)}` : ' · 使い切り'}
        </small>
        <button className="link-btn small-link" onClick={() => void onArchive(!eq.archived_at)}>{eq.archived_at ? '戻す' : 'しまう'}</button>
      </div>
    </div>
  );
}

/** イベントの準備の「経費」で、備品を使う */
export function EquipmentUse({ ctx, eventId, locked }: { ctx: Ctx; eventId: string; locked: boolean }) {
  const toast = useToast();
  const states = useEquipmentStates(ctx.circleId);
  const usedHere = useLiveQuery(
    async () => new Set((await db.expenses.where('event_id').equals(eventId).toArray())
      .filter((e) => e.equipment_id && (e.actual_amount ?? e.planned_amount ?? 0) > 0).map((e) => e.equipment_id!)),
    [eventId],
  );
  const [pick, setPick] = useState('');
  if (!states || !usedHere) return null;
  const choices = states.filter((s) => !s.equipment.archived_at && !usedHere.has(s.equipment.id) && s.nextShare > 0);
  if (choices.length === 0) return null;
  const chosen = choices.find((s) => s.equipment.id === pick) ?? choices[0];
  return (
    <form
      className="exp-add"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const exp = await applyEquipment(db, ctx, eventId, chosen.equipment.id);
          toast(`${chosen.equipment.name}の${yen(exp.actual_amount ?? 0)}を経費に入れました`);
          setPick('');
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err));
        }
      }}
    >
      <select aria-label="使う備品" value={chosen.equipment.id} onChange={(e) => setPick(e.target.value)}>
        {choices.map((s) => (
          <option key={s.equipment.id} value={s.equipment.id}>
            {s.equipment.name}({yen(s.nextShare)}・{s.used + 1}/{s.equipment.uses}回目)
          </option>
        ))}
      </select>
      <button className="sbtn" disabled={locked}>備品を使う</button>
    </form>
  );
}
