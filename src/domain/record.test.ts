import { describe, expect, it } from 'vitest';
import { eventState, freshDb, itemId } from '../test/helpers';
import { lastActiveTxn } from './ledger';
import { recordGiveaway, recordSale, voidTransaction } from './record';
import { addSampleData, createCircle } from './setup';

async function setup() {
  const db = freshDb('record');
  const ctx = await createCircle(db, 'テストサークル');
  const ev = await addSampleData(db, ctx);
  return { db, ctx, ev };
}

describe('記録と集計', () => {
  it('見本データでは、持ち込み数がそのまま残数になる', async () => {
    const { db, ev } = await setup();
    const s = await eventState(db, ev.id);
    expect(s.byName('新刊A')).toMatchObject({ brought: 30, sold: 0, remaining: 30 });
    expect(s.byName('友人の本')).toMatchObject({ brought: 12, remaining: 12 });
    expect(s.byName('A+Bセット').remaining).toBe(12); // 既刊Bの12部が上限
  });

  it('セットを売ると構成品の在庫が減り、売上はセット価格で1部と数える', async () => {
    const { db, ctx, ev } = await setup();
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: await itemId(db, 'A+Bセット'), qty: 2 }] });
    const s = await eventState(db, ev.id);
    expect(s.byName('新刊A').remaining).toBe(28);
    expect(s.byName('既刊B').remaining).toBe(10);
    expect(s.totals).toMatchObject({ amount: 2400, count: 2 });
  });

  it('取り消した販売は残数と売上に入らず、記録は残る', async () => {
    const { db, ctx, ev } = await setup();
    const a = await itemId(db, '新刊A');
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a, qty: 1 }] });
    const t2 = await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a, qty: 1 }] });
    await voidTransaction(db, ctx, t2.id);
    const s = await eventState(db, ev.id);
    expect(s.byName('新刊A').remaining).toBe(29);
    expect(s.totals.amount).toBe(800);
    expect(s.txns).toHaveLength(3);
    await expect(voidTransaction(db, ctx, t2.id)).rejects.toThrow('すでに取り消されています');
  });

  it('取り消しボタンの対象は、直近のまだ取り消していない取引', async () => {
    const { db, ctx, ev } = await setup();
    const a = await itemId(db, '新刊A');
    let clock = Date.parse('2026-11-01T02:00:00Z');
    const tick = { ...ctx, now: () => new Date((clock += 1000)) };
    const t1 = await recordSale(db, tick, { eventId: ev.id, lines: [{ itemId: a, qty: 1 }] });
    const t2 = await recordSale(db, tick, { eventId: ev.id, lines: [{ itemId: a, qty: 1 }] });
    expect(lastActiveTxn((await eventState(db, ev.id)).txns)?.id).toBe(t2.id);
    await voidTransaction(db, tick, t2.id);
    expect(lastActiveTxn((await eventState(db, ev.id)).txns)?.id).toBe(t1.id);
  });

  it('残数0でも記録でき、残数はマイナスになって完売時刻は最後の販売になる', async () => {
    const { db, ctx, ev } = await setup();
    const c = await itemId(db, '既刊C');
    await recordSale(db, { ...ctx, now: () => new Date('2026-11-01T02:40:00Z') }, { eventId: ev.id, lines: [{ itemId: c, qty: 10 }] });
    expect((await eventState(db, ev.id)).byName('既刊C')).toMatchObject({ remaining: 0, soldOutAt: '2026-11-01T02:40:00.000Z' });
    await recordSale(db, { ...ctx, now: () => new Date('2026-11-01T05:20:00Z') }, {
      eventId: ev.id, lines: [{ itemId: c, qty: 1 }], zeroStockOverride: true,
    });
    expect((await eventState(db, ev.id)).byName('既刊C')).toMatchObject({ remaining: -1, soldOutAt: '2026-11-01T05:20:00.000Z' });
  });

  it('見本誌は売上に入らず残数だけ減る。セットは無償出庫できない', async () => {
    const { db, ctx, ev } = await setup();
    await recordGiveaway(db, ctx, { eventId: ev.id, itemId: await itemId(db, '新刊A'), qty: 1, kind: 'sample' });
    const s = await eventState(db, ev.id);
    expect(s.byName('新刊A')).toMatchObject({ given: 1, remaining: 29 });
    expect(s.totals.amount).toBe(0);
    await expect(
      recordGiveaway(db, ctx, { eventId: ev.id, itemId: await itemId(db, 'A+Bセット'), qty: 1, kind: 'gift' }),
    ).rejects.toThrow('セット');
  });

  it('受託分は持ち主ごとの売上に分かれる', async () => {
    const { db, ctx, ev } = await setup();
    await recordSale(db, ctx, {
      eventId: ev.id,
      lines: [{ itemId: await itemId(db, '新刊A'), qty: 1 }, { itemId: await itemId(db, '友人の本'), qty: 2 }],
    });
    const s = await eventState(db, ev.id);
    const b = (await db.owners.filter((o) => o.name === 'サークルB').first())!;
    expect(s.totals.amount).toBe(2000);
    expect(s.totals.byOwner.get(b.id)).toBe(1200);
  });

  it('記録はすべて送信待ちに積まれる', async () => {
    const { db, ctx, ev } = await setup();
    const before = await db.outbox.count();
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: await itemId(db, 'A+Bセット'), qty: 1 }] });
    // 取引1 + 明細1 + 在庫移動2(構成品ごと)
    expect((await db.outbox.count()) - before).toBe(4);
  });
});
