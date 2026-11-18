import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { loadAnalysis, reprintPlans, DEFAULT_FORECAST } from './analysis';
import { prepareEvent, saveEventInfo, saveItem, saveOwner } from './catalog';
import { confirmClosing } from './closing';
import { recordSale } from './record';
import { createCircle } from './setup';
import { decayByAppearance } from './trend';

describe('分析の「推移」で受託品も見る(F-708)', () => {
  it('受託品の観測は別に持ち、刷り部数の目安や減衰率には混ぜない', async () => {
    const db = freshDb('consigned-trend');
    const ctx = await createCircle(db, 'テスト');
    const self = (await db.owners.filter((o) => o.is_self).first())!;
    const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
    const friend = await saveOwner(db, ctx, { name: 'サークルB', feeRate: 0.1 });
    const mine = await saveItem(db, ctx, { name: '自分の本', kind: 'book', price: 800, ownerId: self.id, lowThreshold: 3 });
    const theirs = await saveItem(db, ctx, { name: '預かった本', kind: 'book', price: 500, ownerId: friend.id, lowThreshold: 3 });
    const { addPrintRun } = await import('./catalog');
    await addPrintRun(db, ctx, { itemId: mine.id, qty: 50, totalCost: 20000, printedOn: null, toLocationId: home.id });
    for (const [i, date] of ['2026-05-01', '2026-08-01'].entries()) {
      const ev = await saveEventInfo(db, ctx, { name: `イベント${i + 1}`, heldOn: date, startsAt: new Date(`${date}T11:00:00+09:00`).toISOString() });
      await prepareEvent(db, ctx, ev.id, [
        { itemId: mine.id, included: true, bring: 10, priceOverride: null },
        { itemId: theirs.id, included: true, bring: 10, priceOverride: null },
      ], { storageId: home.id });
      const at = new Date(`${date}T12:00:00+09:00`);
      await recordSale(db, { ...ctx, now: () => at }, { eventId: ev.id, lines: [{ itemId: mine.id, qty: 4 }, { itemId: theirs.id, qty: i === 0 ? 8 : 2 }] });
      await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });
    }
    const data = await loadAnalysis(db, ctx.circleId);
    expect([...data.histories.keys()]).toEqual([mine.id]);
    expect([...data.consignedHistories.keys()]).toEqual([theirs.id]);
    expect(data.consignedHistories.get(theirs.id)!.observations.map((o) => o.sold)).toEqual([8, 2]);
    expect(data.owners.some((o) => o.id === friend.id)).toBe(true);
    // 刷り部数の目安は自分の品目だけ
    expect(reprintPlans(data, DEFAULT_FORECAST).map((p) => p.item.id)).toEqual([mine.id]);
    // 落ち方は、見る範囲の品目だけで出す
    expect(decayByAppearance(data.consignedHistories.values())).toEqual([{ nth: 2, ratio: 0.25, samples: 1 }]);
    expect(decayByAppearance(data.histories.values())).toEqual([{ nth: 2, ratio: 1, samples: 1 }]);
  });
});
