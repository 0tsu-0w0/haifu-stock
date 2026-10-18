import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { DEFAULT_FORECAST, loadAnalysis } from './analysis';
import { bringHints } from './bring';
import { addPrintRun, prepareEvent, saveEventInfo, saveItem } from './catalog';
import { confirmClosing } from './closing';
import { recordSale } from './record';
import { createCircle } from './setup';

describe('次のイベントの持ち込み数の目安(Issue #28)', () => {
  it('前回の需要(完売補正つき)× 強気の減衰率に余裕を足す。前回完売なら前回の持ち込み数より減らさない。新刊は新刊の目安、実績のないグッズは出さない', async () => {
    const db = freshDb('bring');
    const ctx = await createCircle(db, 'テスト');
    const self = (await db.owners.filter((o) => o.is_self).first())!;
    const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
    const a = await saveItem(db, ctx, { name: '新刊A', kind: 'book', price: 800, ownerId: self.id, lowThreshold: 3 });
    const b = await saveItem(db, ctx, { name: '既刊B', kind: 'book', price: 500, ownerId: self.id, lowThreshold: 3 });
    const c = await saveItem(db, ctx, { name: '次の新刊C', kind: 'book', price: 900, ownerId: self.id, lowThreshold: 3 });
    const g = await saveItem(db, ctx, { name: 'アクスタ', kind: 'goods', price: 1000, ownerId: self.id, lowThreshold: 3 });
    for (const it of [a, b, c, g]) await addPrintRun(db, ctx, { itemId: it.id, qty: 100, totalCost: 30000, printedOn: null, toLocationId: home.id });

    // 前回: A は20部を開始1時間で完売、B は30部持って10部売れた
    const date = '2026-09-01';
    const ev = await saveEventInfo(db, ctx, { name: 'コミティア', heldOn: date, startsAt: new Date(`${date}T11:00:00+09:00`).toISOString() });
    await prepareEvent(db, ctx, ev.id, [
      { itemId: a.id, included: true, bring: 20, priceOverride: null },
      { itemId: b.id, included: true, bring: 30, priceOverride: null },
    ], { storageId: home.id });
    const at = (min: number) => ({ ...ctx, now: () => new Date(Date.parse(`${date}T11:00:00+09:00`) + min * 60_000) });
    for (let i = 0; i < 20; i++) await recordSale(db, at(3 * i), { eventId: ev.id, lines: [{ itemId: a.id, qty: 1 }] });
    for (let i = 0; i < 10; i++) await recordSale(db, at(20 * i), { eventId: ev.id, lines: [{ itemId: b.id, qty: 1 }] });
    await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });

    const next = await saveEventInfo(db, ctx, { name: '次のイベント', heldOn: '2026-11-01' });
    const data = await loadAnalysis(db, ctx.circleId, DEFAULT_FORECAST);
    const hints = bringHints(data, next.id, DEFAULT_FORECAST);

    const ha = hints.get(a.id)!;
    expect(ha.basis).toContain('完売');
    expect(ha.basis).toContain('売り切れなければ');
    const demandA = data.histories.get(a.id)!.observations[0].demand;
    expect(demandA).toBeGreaterThan(20); // 完売補正で販売数より大きい
    expect(ha.qty).toBe(Math.max(Math.ceil(demandA * 0.6 * 1.2), 20)); // 実績が1回なので強気の減衰率は既定の 0.5 × 1.2

    const hb = hints.get(b.id)!;
    expect(hb.basis).toBe('前回「コミティア」で10部・20部残り');
    expect(hb.qty).toBe(8); // 10 × 0.6 × 1.2 = 7.2 → 8

    const hc = hints.get(c.id)!;
    expect(hc.basis).toContain('新刊');
    expect(hc.reference).toBe(true);
    expect(hints.has(g.id)).toBe(false);

    // 準備しているイベント自身の記録は材料にしない
    expect(bringHints(data, ev.id, DEFAULT_FORECAST).get(b.id)!.basis).toContain('新刊');
  });
});
