import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { DEFAULT_FORECAST, loadAnalysis } from './analysis';
import { addPrintRun, prepareEvent, saveEventInfo, saveItem } from './catalog';
import { confirmClosing, reopenClosing } from './closing';
import { recordSale } from './record';
import { createCircle } from './setup';

describe('分析の控え(Issue #31)', () => {
  it('確定済みのイベントは控えを使い、やり直して記録を足せば計算し直す。開催中のイベントは毎回読む', async () => {
    const db = freshDb('analysiscache');
    const ctx = await createCircle(db, 'テスト');
    const self = (await db.owners.filter((o) => o.is_self).first())!;
    const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
    const a = await saveItem(db, ctx, { name: '新刊A', kind: 'book', price: 800, ownerId: self.id, lowThreshold: 3 });
    await addPrintRun(db, ctx, { itemId: a.id, qty: 100, totalCost: 30000, printedOn: null, toLocationId: home.id });
    const ev = await saveEventInfo(db, ctx, { name: 'コミティア', heldOn: '2026-09-01' });
    await prepareEvent(db, ctx, ev.id, [{ itemId: a.id, included: true, bring: 30, priceOverride: null }], { storageId: home.id });
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a.id, qty: 2 }] });
    await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });

    const sold = async () => (await loadAnalysis(db, ctx.circleId, DEFAULT_FORECAST)).histories.get(a.id)!.observations[0].sold;
    expect(await sold()).toBe(2);
    expect(await sold()).toBe(2); // 2回目は控えから

    await reopenClosing(db, ctx, ev.id);
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a.id, qty: 3 }] });
    await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });
    expect(await sold()).toBe(5);

    // 開催中(未確定)のイベントの販売は、累計の販売にすぐ入る
    const next = await saveEventInfo(db, ctx, { name: '次', heldOn: '2099-01-01' });
    await prepareEvent(db, ctx, next.id, [{ itemId: a.id, included: true, bring: 10, priceOverride: null }], { storageId: home.id });
    await recordSale(db, ctx, { eventId: next.id, lines: [{ itemId: a.id, qty: 1 }] });
    expect((await loadAnalysis(db, ctx.circleId, DEFAULT_FORECAST)).soldTotals.get(a.id)!.qty).toBe(6);
    await recordSale(db, ctx, { eventId: next.id, lines: [{ itemId: a.id, qty: 1 }] });
    expect((await loadAnalysis(db, ctx.circleId, DEFAULT_FORECAST)).soldTotals.get(a.id)!.qty).toBe(7);
  });
});
