import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { DEFAULT_FORECAST, loadAnalysis } from './analysis';
import { addPrintRun, prepareEvent, saveEventInfo, saveItem } from './catalog';
import { confirmClosing } from './closing';
import { recordSale } from './record';
import { bringAccuracy, eventReview, verdictOf } from './review';
import { createCircle } from './setup';
import { loadEventSnapshot } from './snapshot';

describe('目安と実際の振り返り(F-807、Issue #37)', () => {
  it('判定: 完売して需要が持ち込みを超えたら足りない、半分以上かつ3部以上残れば多すぎ', () => {
    expect(verdictOf(20, 35, true, 0)).toBe('short');
    expect(verdictOf(20, 20, true, 0)).toBe('ok');
    expect(verdictOf(20, 8, false, 12)).toBe('over');
    expect(verdictOf(4, 2, false, 2)).toBe('ok'); // 残りが少なければ多すぎとしない
  });

  it('準備のときの目安を控え、確定したイベントで持ち込み・販売・需要と並べる。当たり具合を数える', async () => {
    const db = freshDb('review');
    const ctx = await createCircle(db, 'テスト');
    const self = (await db.owners.filter((o) => o.is_self).first())!;
    const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
    const a = await saveItem(db, ctx, { name: '新刊A', kind: 'book', price: 800, ownerId: self.id, lowThreshold: 3 });
    const b = await saveItem(db, ctx, { name: '既刊B', kind: 'book', price: 500, ownerId: self.id, lowThreshold: 3 });
    for (const it of [a, b]) await addPrintRun(db, ctx, { itemId: it.id, qty: 100, totalCost: 30000, printedOn: null, toLocationId: home.id });

    const date = '2026-09-01';
    const ev = await saveEventInfo(db, ctx, { name: 'コミティア', heldOn: date, startsAt: new Date(`${date}T11:00:00+09:00`).toISOString() });
    await prepareEvent(db, ctx, ev.id, [
      { itemId: a.id, included: true, bring: 10, priceOverride: null, suggested: 12 },
      { itemId: b.id, included: true, bring: 20, priceOverride: null, suggested: 20 },
    ], { storageId: home.id });
    // 目安を渡さずに反映し直しても(古い画面・分析がまだ)、控えた目安はそのまま
    await prepareEvent(db, ctx, ev.id, [
      { itemId: a.id, included: true, bring: 10, priceOverride: null },
      { itemId: b.id, included: true, bring: 20, priceOverride: null },
    ], { storageId: home.id });
    expect((await db.event_items.get([ev.id, a.id]))!.suggested_qty).toBe(12);

    const at = (min: number) => ({ ...ctx, now: () => new Date(Date.parse(`${date}T11:00:00+09:00`) + min * 60_000) });
    for (let i = 0; i < 10; i++) await recordSale(db, at(5 * i), { eventId: ev.id, lines: [{ itemId: a.id, qty: 1 }] }); // 50分で完売
    for (let i = 0; i < 4; i++) await recordSale(db, at(30 * i), { eventId: ev.id, lines: [{ itemId: b.id, qty: 1 }] });
    await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });

    const analysis = await loadAnalysis(db, ctx.circleId, DEFAULT_FORECAST);
    const rows = eventReview((await loadEventSnapshot(db, ev.id))!, analysis);
    const ra = rows.find((r) => r.itemId === a.id)!;
    expect(ra).toMatchObject({ suggested: 12, brought: 10, sold: 10, verdict: 'short' });
    expect(ra.soldOutAt).not.toBeNull();
    expect(ra.demand).toBeGreaterThan(10);
    expect(rows.find((r) => r.itemId === b.id)).toMatchObject({ suggested: 20, brought: 20, sold: 4, left: 16, verdict: 'over' });

    const acc = await bringAccuracy(db, analysis);
    expect(acc).toMatchObject({ events: 1, items: 2, under: 1, over: 1, ok: 0 });
    expect(acc.advice).toBeNull(); // 5品目に満たないうちは知らせない
  });
});
