import { describe, expect, it } from 'vitest';
import { freshDb, itemId } from '../test/helpers';
import { confirmClosing, saveCash } from './closing';
import { recordSale } from './record';
import { paymentBreakdown } from './report';
import { handReservation, saveReservation } from './reservations';
import { addSampleData, createCircle } from './setup';
import { deriveEvent, loadEventSnapshot } from './snapshot';

async function setup() {
  const db = freshDb('payment');
  const ctx = await createCircle(db, 'テスト');
  const ev = await addSampleData(db, ctx);
  const snap = async () => {
    const s = (await loadEventSnapshot(db, ev.id))!;
    return { ...s, ...deriveEvent(s) };
  };
  return { db, ctx, ev, snap, id: (n: string) => itemId(db, n) };
}

describe('キャッシュレスの支払い(#15)', () => {
  it('現金の売上だけを現金の理論値に数え、支払い方法ごとの売上を出す', async () => {
    const { db, ctx, ev, snap, id } = await setup();
    const a = await id('新刊A'); // 800円
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a, qty: 1 }], paidAmount: 1000 });
    const qr = await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a, qty: 2 }], paymentMethod: 'qr', paidAmount: 5000 });
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a, qty: 1 }], paymentMethod: 'card' });
    const s = await snap();
    expect(s.totals.amount).toBe(800 * 4);
    expect(s.totals.cash).toBe(800);
    expect(qr.paid_amount).toBeNull(); // 現金以外は預かり金額を持たない
    expect(qr.payment_method).toBe('qr');
    expect(paymentBreakdown(s).map((r) => [r.label, r.txns, r.amount])).toEqual([['現金', 1, 800], ['コード決済', 1, 1600], ['カード', 1, 800]]);
  });

  it('支払い方法のない古い記録は現金として数える', async () => {
    const { db, ctx, ev, snap, id } = await setup();
    const t = await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: await id('新刊A'), qty: 1 }] });
    await db.transactions.update(t.id, { payment_method: undefined });
    expect((await snap()).totals.cash).toBe(800);
  });

  it('終了処理の現金の差異は、キャッシュレス分を除いて出す', async () => {
    const { db, ctx, ev, snap, id } = await setup();
    const a = await id('新刊A');
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a, qty: 1 }] });
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a, qty: 3 }], paymentMethod: 'qr' });
    const { float } = await snap();
    // 数えた現金 = 釣り銭 + 現金の売上800円 → 差異0(キャッシュレスの2,400円は手元にない)
    const total = float + 800;
    for (const d of [10000, 5000, 1000, 500, 100, 50, 10, 5, 1]) await saveCash(db, ctx, ev.id, d, 0);
    let rest = total;
    for (const d of [10000, 5000, 1000, 500, 100, 50, 10, 5, 1]) {
      const n = Math.floor(rest / d);
      if (n) await saveCash(db, ctx, ev.id, d, n);
      rest -= n * d;
    }
    const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
    const closing = await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });
    expect(closing.cash_diff).toBe(0);
    expect(closing.summary.sales).toBe(800 * 4);
  });

  it('取り置きを渡すときも支払い方法を選べる', async () => {
    const { db, ctx, ev, snap, id } = await setup();
    const r = await saveReservation(db, ctx, { eventId: ev.id, itemId: await id('新刊A'), qty: 2, name: 'Xさん' });
    const t = await handReservation(db, ctx, r.id, { paymentMethod: 'card' });
    expect(t.payment_method).toBe('card');
    expect((await snap()).totals.cash).toBe(0);
  });
});
