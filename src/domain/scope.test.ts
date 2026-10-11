import { describe, expect, it } from 'vitest';
import { freshDb, itemId } from '../test/helpers';
import { saveItem } from './catalog';
import { confirmClosing, moneyAfterClosing } from './closing';
import { recordSale, voidTransaction } from './record';
import { eventReport, ownerBreakdown, scopeSnapshot } from './report';
import { addSampleData, createCircle } from './setup';
import { loadEventSnapshot } from './snapshot';

async function setup() {
  const db = freshDb('scope');
  const ctx = await createCircle(db, 'テストサークル');
  const ev = await addSampleData(db, ctx);
  const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
  const snap = async () => (await loadEventSnapshot(db, ev.id))!;
  const id = (n: string) => itemId(db, n);
  // 自分の本と受託の本を一緒に買った取引と、受託だけの取引と、取り消した受託の取引
  await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: await id('新刊A'), qty: 2 }, { itemId: await id('友人の本'), qty: 1 }] });
  await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: await id('コピー本'), qty: 3 }] });
  const v = await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: await id('友人の本'), qty: 1 }] });
  await voidTransaction(db, ctx, v.id);
  return { db, ctx, ev, home, snap, id };
}

describe('集計の範囲(F-708)', () => {
  it('全体・自分の分・受託元ごとに分けられ、足すと全体になる', async () => {
    const { db, snap } = await setup();
    const s = await snap();
    const all = eventReport(s);
    const self = eventReport(scopeSnapshot(s, 'self'));
    expect(all.amount).toBe(800 * 2 + 600 + 200 * 3);
    expect(self.amount).toBe(1600);
    expect(self.txnCount).toBe(1); // 受託だけの取引は数えない
    expect(self.rows.every((r) => r.ownerName === null)).toBe(true);

    const b = (await db.owners.filter((o) => o.name === 'サークルB').first())!;
    const onlyB = eventReport(scopeSnapshot(s, { ownerId: b.id }));
    expect(onlyB.amount).toBe(600);
    expect(onlyB.rows.map((r) => r.name)).toEqual(['友人の本']);
    expect(onlyB.rows[0].sold).toBe(1); // 取り消した販売は数えない

    const owners = ownerBreakdown(s);
    expect(owners[0]).toMatchObject({ name: '自分', amount: 1600 });
    expect(owners.reduce((a, r) => a + r.amount, 0)).toBe(all.amount);
    expect(owners.find((r) => r.name === 'サークルC')).toMatchObject({ qty: 3, amount: 600, fee: 60 });
  });
});

describe('持ち主の付け替え(F-709)', () => {
  it('確定したあとに付け替えても、精算と収支は新しい持ち主で計算し直される', async () => {
    const { db, ctx, ev, home, snap, id } = await setup();
    await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });
    const before = moneyAfterClosing(await snap());
    const closing = (await db.event_closings.where('event_id').equals(ev.id).first())!;
    // 確定した直後は、確定の記録と同じ
    expect(before.total).toBe(closing.summary.sales);
    expect(before.profit).toBe(closing.summary.profit);
    expect(before.settlements.map((x) => [x.name, x.payout])).toEqual(closing.summary.payouts.map((p) => [p.name, p.amount]));

    // 「友人の本」は本当は自分の本だった
    const item = (await db.items.get(await id('友人の本')))!;
    const self = (await db.owners.filter((o) => o.is_self).first())!;
    await saveItem(db, ctx, { id: item.id, name: item.name, kind: item.kind, price: item.price, ownerId: self.id, lowThreshold: item.low_threshold });
    const after = moneyAfterClosing(await snap());
    expect(after.own).toBe(before.own + 600);
    expect(after.settlements.map((x) => x.name)).toEqual(['サークルC']);
    expect(eventReport(scopeSnapshot(await snap(), 'self')).amount).toBe(1600 + 600);
  });
});
