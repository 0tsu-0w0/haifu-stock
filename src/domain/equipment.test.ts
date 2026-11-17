import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { copyFloatAndExpenses, saveExpense } from './catalog';
import { applyEquipment, equipmentStates, nextShareOf, saveEquipment, setEquipmentArchived } from './equipment';
import { createCircle, createEvent } from './setup';

async function setup() {
  const db = freshDb('equipment');
  const ctx = await createCircle(db, 'テストサークル');
  const ev1 = await createEvent(db, ctx, { name: 'イベント1', heldOn: '2026-08-10' });
  const ev2 = await createEvent(db, ctx, { name: 'イベント2', heldOn: '2026-10-10' });
  const ev3 = await createEvent(db, ctx, { name: 'イベント3', heldOn: '2026-12-10' });
  return { db, ctx, ev1, ev2, ev3 };
}

describe('備品の按分(F-310)', () => {
  it('均等に割り、最後の回で端数を足して買った金額にそろえる', () => {
    const eq = { cost: 1000, uses: 3 };
    expect(nextShareOf(eq, 0, 0)).toBe(333);
    expect(nextShareOf(eq, 1, 333)).toBe(333);
    expect(nextShareOf(eq, 2, 666)).toBe(334);
    expect(nextShareOf(eq, 3, 1000)).toBe(0);
    // 途中で金額を多めに直していたら、残りの分だけにする
    expect(nextShareOf(eq, 1, 900)).toBe(100);
  });

  it('使ったイベントの経費(消耗品)になり、使い切ったらそれ以上は入れない', async () => {
    const { db, ctx, ev1, ev2, ev3 } = await setup();
    const eq = await saveEquipment(db, ctx, { name: 'ブックスタンド', cost: 3001, uses: 2 });
    const e1 = await applyEquipment(db, ctx, ev1.id, eq.id);
    expect(e1).toMatchObject({ category: 'supplies', label: 'ブックスタンド', actual_amount: 1500, equipment_id: eq.id });
    await expect(applyEquipment(db, ctx, ev1.id, eq.id)).rejects.toThrow('このイベントの経費に入っています');
    const e2 = await applyEquipment(db, ctx, ev2.id, eq.id);
    expect(e2.actual_amount).toBe(1501);
    await expect(applyEquipment(db, ctx, ev3.id, eq.id)).rejects.toThrow('経費にし終えています');

    const [st] = equipmentStates(await db.equipment.toArray(), await db.expenses.toArray());
    expect(st).toMatchObject({ used: 2, allocated: 3001, remaining: 0, nextShare: 0 });
  });

  it('経費を0円にすると外したことになり、その分をほかのイベントに回せる。金額を直してもつながりは残る', async () => {
    const { db, ctx, ev1, ev2 } = await setup();
    const eq = await saveEquipment(db, ctx, { name: 'クロス', cost: 2000, uses: 4 });
    const e1 = await applyEquipment(db, ctx, ev1.id, eq.id);
    await saveExpense(db, ctx, { id: e1.id, eventId: ev1.id, category: 'supplies', label: 'クロス', planned: 500, actual: 800 });
    expect((await db.expenses.get(e1.id))!.equipment_id).toBe(eq.id);
    let [st] = equipmentStates([eq], await db.expenses.toArray());
    expect(st).toMatchObject({ used: 1, allocated: 800, remaining: 1200 });

    await saveExpense(db, ctx, { id: e1.id, eventId: ev1.id, category: 'supplies', label: 'クロス', planned: 0, actual: 0 });
    [st] = equipmentStates([eq], await db.expenses.toArray());
    expect(st).toMatchObject({ used: 0, allocated: 0, nextShare: 500 });
    expect((await applyEquipment(db, ctx, ev2.id, eq.id)).actual_amount).toBe(500);
  });

  it('前回の経費を写すとき、備品はもう一度按分する', async () => {
    const { db, ctx, ev1, ev2 } = await setup();
    const eq = await saveEquipment(db, ctx, { name: 'ブックスタンド', cost: 900, uses: 3 });
    await applyEquipment(db, ctx, ev1.id, eq.id);
    await saveExpense(db, ctx, { eventId: ev1.id, category: 'booth_fee', planned: 7000, actual: null });
    const r = await copyFloatAndExpenses(db, ctx, ev1.id, ev2.id);
    expect(r.expenses).toBe(2);
    const copied = await db.expenses.where('event_id').equals(ev2.id).toArray();
    const eqRow = copied.find((e) => e.equipment_id === eq.id)!;
    expect(eqRow.actual_amount).toBe(300);
    expect(equipmentStates([eq], await db.expenses.toArray())[0].used).toBe(2);
  });

  it('使い切った備品・しまった備品があっても、ほかの経費は写る', async () => {
    const { db, ctx, ev1, ev2 } = await setup();
    const done = await saveEquipment(db, ctx, { name: '使い切り', cost: 900, uses: 1 });
    const put = await saveEquipment(db, ctx, { name: 'しまった', cost: 900, uses: 3 });
    await applyEquipment(db, ctx, ev1.id, done.id);
    await applyEquipment(db, ctx, ev1.id, put.id);
    await setEquipmentArchived(db, put.id, true);
    await saveExpense(db, ctx, { eventId: ev1.id, category: 'booth_fee', planned: 7000, actual: null });
    const r = await copyFloatAndExpenses(db, ctx, ev1.id, ev2.id);
    expect(r.expenses).toBe(1);
    const copied = await db.expenses.where('event_id').equals(ev2.id).toArray();
    expect(copied.map((e) => e.label)).toEqual(['出展費']);
  });

  it('名前・金額・回数を確かめる', async () => {
    const { db, ctx } = await setup();
    await expect(saveEquipment(db, ctx, { name: ' ', cost: 100, uses: 1 })).rejects.toThrow('名前');
    await expect(saveEquipment(db, ctx, { name: 'x', cost: -1, uses: 1 })).rejects.toThrow('金額');
    await expect(saveEquipment(db, ctx, { name: 'x', cost: 100, uses: 0 })).rejects.toThrow('回数');
  });
});
