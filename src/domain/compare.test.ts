import { describe, expect, it } from 'vitest';
import { freshDb, itemId } from '../test/helpers';
import { prepareEvent, saveEventInfo } from './catalog';
import { byType, byVenue, loadComparison, type CompareRow } from './compare';
import { confirmClosing } from './closing';
import { recordSale } from './record';
import { addSampleData, createCircle } from './setup';

const T = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+09:00`);

describe('イベントをまたいだ比較(#13)', () => {
  it('販売のあったイベントを古い順に並べ、売上・客単価・1時間あたり・収支を出す', async () => {
    const db = freshDb('compare');
    const ctx = await createCircle(db, 'テスト');
    const ev1 = await addSampleData(db, ctx); // 経費 8,280円
    await db.events.update(ev1.id, { held_on: '2026-05-01', starts_at: T('2026-05-01', '11:00').toISOString(), venue: 'ビッグサイト' });
    const a = await itemId(db, '新刊A');
    await recordSale(db, { ...ctx, now: () => T('2026-05-01', '11:30') }, { eventId: ev1.id, lines: [{ itemId: a, qty: 2 }] });
    await recordSale(db, { ...ctx, now: () => T('2026-05-01', '13:00') }, { eventId: ev1.id, lines: [{ itemId: a, qty: 1 }] });
    const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
    await confirmClosing(db, ctx, ev1.id, { returnLocationId: home.id });

    const ev2 = await saveEventInfo(db, ctx, { name: '地方イベント', heldOn: '2026-06-01', startsAt: '2026-06-01T10:00:00+09:00', venue: '市民ホール' });
    await prepareEvent(db, ctx, ev2.id, [{ itemId: a, included: true, bring: 5, priceOverride: null }], { storageId: home.id });
    await recordSale(db, { ...ctx, now: () => T('2026-06-01', '11:00') }, { eventId: ev2.id, lines: [{ itemId: a, qty: 1 }] });
    await saveEventInfo(db, ctx, { name: '販売なし', heldOn: '2026-07-01' });

    const rows = await loadComparison(db, ctx.circleId);
    expect(rows.map((r) => r.name)).toEqual(['コミティア(見本)', '地方イベント']);
    const [r1, r2] = rows;
    expect(r1).toMatchObject({ closed: true, amount: 2400, qty: 3, txns: 2, perCustomer: 1200, minutes: 120, perHour: 1200, expenses: 8280 });
    expect(r1.profit).toBeLessThan(0);
    expect(r2).toMatchObject({ closed: false, amount: 800, minutes: 60, perHour: 800, venue: '市民ホール' });
  });

  it('会場ごとの平均は、2回以上出た会場だけ', () => {
    const row = (venue: string | null, amount: number, perHour: number | null, profit: number) =>
      ({ venue, amount, perHour, profit }) as CompareRow;
    const v = byVenue([row('A', 10000, 2000, 1000), row('A', 20000, null, 3000), row('B', 5000, 1000, 0), row(null, 1, 1, 1)]);
    expect(v).toEqual([{ venue: 'A', count: 2, avgAmount: 15000, avgPerHour: 2000, avgProfit: 2000 }]);
  });

  it('種別ごとの平均も、2回以上ある種別だけ(F-301)', () => {
    const row = (type: string | null, amount: number, perHour: number | null, profit: number) =>
      ({ type, venue: null, amount, perHour, profit }) as CompareRow;
    const t = byType([row('オンリー', 6000, 1500, 500), row('オンリー', 4000, 500, -500), row('大規模', 30000, 6000, 9000), row(null, 1, 1, 1)]);
    expect(t).toEqual([{ type: 'オンリー', count: 2, avgAmount: 5000, avgPerHour: 1000, avgProfit: 0 }]);
  });
});
