import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { loadAnalysis } from './analysis';
import { addPrintRun, ensureEventType, prepareEvent, saveEventInfo, saveItem } from './catalog';
import { confirmClosing } from './closing';
import { recordSale } from './record';
import { createCircle } from './setup';

describe('種別ごとの累積販売曲線(§6.1)', () => {
  it('種別の材料が30部以上あれば、完売補正にその種別だけの曲線を使う', async () => {
    const db = freshDb('typecurve');
    const ctx = await createCircle(db, 'テスト');
    const self = (await db.owners.filter((o) => o.is_self).first())!;
    const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
    const a = await saveItem(db, ctx, { name: '新刊A', kind: 'book', price: 800, ownerId: self.id, lowThreshold: 3 });
    const b = await saveItem(db, ctx, { name: '既刊B', kind: 'book', price: 500, ownerId: self.id, lowThreshold: 3 });
    for (const it of [a, b]) await addPrintRun(db, ctx, { itemId: it.id, qty: 200, totalCost: 10000, printedOn: null, toLocationId: home.id });
    const early = await ensureEventType(db, ctx, '朝に売れる種別');
    const late = await ensureEventType(db, ctx, '夕方に売れる種別');

    async function event(name: string, date: string, typeId: string | null, bringA: number, sales: { item: string; at: number; qty: number }[]) {
      const start = `${date}T11:00:00+09:00`;
      const ev = await saveEventInfo(db, ctx, {
        name, heldOn: date, startsAt: new Date(start).toISOString(), endsAt: new Date(Date.parse(start) + 300 * 60_000).toISOString(), eventTypeId: typeId,
      });
      await prepareEvent(db, ctx, ev.id, [
        { itemId: a.id, included: bringA > 0, bring: bringA, priceOverride: null },
        { itemId: b.id, included: true, bring: 40, priceOverride: null },
      ], { storageId: home.id });
      for (const s of sales) {
        const at = new Date(Date.parse(start) + s.at * 60_000);
        await recordSale(db, { ...ctx, now: () => at }, { eventId: ev.id, lines: [{ itemId: s.item, qty: s.qty }] });
      }
      await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });
      return ev;
    }
    // 朝型: B は30部のうち24部が開始30分。A は10部を開催時間の半分(150分)で完売
    const e1 = await event('朝型', '2026-05-01', early, 10, [
      { item: b.id, at: 30, qty: 24 }, { item: b.id, at: 270, qty: 6 }, { item: a.id, at: 150, qty: 10 },
    ]);
    // 夕方型: B は30部すべてが終了まぎわ
    await event('夕方型', '2026-06-01', late, 0, [{ item: b.id, at: 270, qty: 30 }]);

    const data = await loadAnalysis(db, ctx.circleId);
    expect(data.curveTypes.map((c) => c.samples)).toEqual([30, 30]);
    const oa = data.histories.get(a.id)!.observations.find((o) => o.eventId === e1.id)!;
    // 朝型だけの曲線では半分の時点で8割 → 10 ÷ 0.8 = 12.5。全体の曲線(4割)なら 25 → 上限の20になる
    expect(oa.demand).toBe(12.5);
  });
});
