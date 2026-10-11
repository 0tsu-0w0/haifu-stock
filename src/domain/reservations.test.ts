import { describe, expect, it } from 'vitest';
import { freshDb, itemId } from '../test/helpers';
import { confirmClosing } from './closing';
import { voidTransaction } from './record';
import { cancelReservation, handReservation, saveReservation } from './reservations';
import { addSampleData, createCircle } from './setup';
import { deriveEvent, loadEventSnapshot } from './snapshot';

async function setup() {
  const db = freshDb('reservations');
  const ctx = await createCircle(db, 'テスト');
  const ev = await addSampleData(db, ctx);
  const snap = async () => {
    const s = (await loadEventSnapshot(db, ev.id))!;
    return { ...s, ...deriveEvent(s) };
  };
  return { db, ctx, ev, snap, id: (n: string) => itemId(db, n) };
}

describe('取り置き(#11)', () => {
  it('取り置き中の部数を品目ごとに数え、在庫は動かさない', async () => {
    const { db, ctx, ev, snap, id } = await setup();
    const a = await id('新刊A');
    const before = (await snap()).summary.get(a)!.remaining;
    await saveReservation(db, ctx, { eventId: ev.id, itemId: a, qty: 2, name: 'Xさん' });
    await saveReservation(db, ctx, { eventId: ev.id, itemId: a, qty: 1, name: 'Yさん' });
    const s = await snap();
    expect(s.held.get(a)).toBe(3);
    expect(s.summary.get(a)!.remaining).toBe(before);
  });

  it('渡すと販売として記録して取り置きから外れ、販売を取り消すと取り置き中に戻る', async () => {
    const { db, ctx, ev, snap, id } = await setup();
    const a = await id('新刊A');
    const r = await saveReservation(db, ctx, { eventId: ev.id, itemId: a, qty: 2, name: 'Xさん' });
    const before = (await snap()).summary.get(a)!;
    const t = await handReservation(db, ctx, r.id);
    let s = await snap();
    expect(s.held.get(a) ?? 0).toBe(0);
    expect(s.summary.get(a)!.sold).toBe(before.sold + 2);
    expect(s.totals.amount).toBeGreaterThan(0);
    await expect(handReservation(db, ctx, r.id)).rejects.toThrow('もう渡したか');

    await voidTransaction(db, ctx, t.id);
    s = await snap();
    expect(s.held.get(a)).toBe(2);
    await handReservation(db, ctx, r.id); // もう一度渡せる
    expect((await snap()).held.get(a) ?? 0).toBe(0);
  });

  it('取り消すと売れる部数に戻る。確定後は変えられない。セットは取り置きできない', async () => {
    const { db, ctx, ev, snap, id } = await setup();
    const a = await id('新刊A');
    const r = await saveReservation(db, ctx, { eventId: ev.id, itemId: a, qty: 1, name: 'Xさん' });
    await cancelReservation(db, r.id);
    expect((await snap()).held.get(a) ?? 0).toBe(0);
    await expect(saveReservation(db, ctx, { id: r.id, eventId: ev.id, itemId: a, qty: 3, name: 'Xさん' })).rejects.toThrow('変えられません');
    await expect(saveReservation(db, ctx, { eventId: ev.id, itemId: await id('A+Bセット'), qty: 1, name: 'Z' })).rejects.toThrow('セット');
    await expect(saveReservation(db, ctx, { eventId: ev.id, itemId: a, qty: 1, name: '  ' })).rejects.toThrow('名前');

    const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
    await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });
    await expect(saveReservation(db, ctx, { eventId: ev.id, itemId: a, qty: 1, name: 'W' })).rejects.toThrow('確定済み');
  });
});
