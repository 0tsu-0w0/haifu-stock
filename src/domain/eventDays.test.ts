import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { DEFAULT_FORECAST, loadAnalysis } from './analysis';
import { bringHints } from './bring';
import { addPrintRun, prepareEvent, saveEventInfo, saveItem } from './catalog';
import { confirmClosing } from './closing';
import { activeFractionDays, addDays, dayIndexOf, dayWindows, daysOf, lastDayOf } from './eventDays';
import { recordSale } from './record';
import { dayBreakdown, eventReport, salesDuration } from './report';
import { createCircle } from './setup';
import { loadEventSnapshot } from './snapshot';

// 日本時間の昼の時刻(どのタイムゾーンで走らせても、同じ日付になる時間帯を使う)
const T = (date: string, hm: string) => Date.parse(`${date}T${hm}:00+09:00`);

describe('2日・3日開催(Issue #19)', () => {
  const ev = { held_on: '2026-12-30', starts_at: new Date(T('2026-12-30', '10:30')).toISOString(), ends_at: new Date(T('2026-12-30', '16:00')).toISOString(), days: 2 };

  it('日数・最終日・何日目か', () => {
    expect(daysOf({})).toBe(1);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(lastDayOf(ev)).toBe('2026-12-31');
    expect(dayIndexOf(ev, T('2026-12-30', '12:00'))).toBe(0);
    expect(dayIndexOf(ev, T('2026-12-31', '12:00'))).toBe(1);
  });

  it('開催時間は日ごと(夜は数えない)。2日目の正午は、全体の4分の3より手前', () => {
    const w = dayWindows(ev, [], 5);
    expect(w).toHaveLength(2);
    expect(w[1][0] - w[0][0]).toBe(24 * 3600_000);
    // 1日目が終わった時点で半分
    expect(activeFractionDays(T('2026-12-30', '16:00'), w, [])).toBeCloseTo(0.5);
    expect(activeFractionDays(T('2026-12-30', '22:00'), w, [])).toBeCloseTo(0.5);
    expect(activeFractionDays(T('2026-12-31', '13:15'), w, [])).toBeCloseTo(0.75);
  });

  it('レポート: 日ごとの売上・販売時間、時間帯のグラフは日ごと/全日程を時刻で合算', async () => {
    const db = freshDb('days');
    const ctx = await createCircle(db, 'テスト');
    const self = (await db.owners.filter((o) => o.is_self).first())!;
    const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
    const a = await saveItem(db, ctx, { name: '新刊A', kind: 'book', price: 1000, ownerId: self.id, lowThreshold: 3 });
    await addPrintRun(db, ctx, { itemId: a.id, qty: 100, totalCost: 30000, printedOn: null, toLocationId: home.id });
    const e = await saveEventInfo(db, ctx, { name: '冬の2日開催', heldOn: ev.held_on, startsAt: ev.starts_at, endsAt: ev.ends_at, days: 2 });
    expect((await db.events.get(e.id))!.days).toBe(2);
    await prepareEvent(db, ctx, e.id, [{ itemId: a.id, included: true, bring: 40, priceOverride: null }], { storageId: home.id });
    const at = (ms: number) => ({ ...ctx, now: () => new Date(ms) });
    await recordSale(db, at(T('2026-12-30', '10:40')), { eventId: e.id, lines: [{ itemId: a.id, qty: 3 }] });
    await recordSale(db, at(T('2026-12-30', '11:30')), { eventId: e.id, lines: [{ itemId: a.id, qty: 1 }] });
    await recordSale(db, at(T('2026-12-31', '10:50')), { eventId: e.id, lines: [{ itemId: a.id, qty: 2 }] });

    const s = (await loadEventSnapshot(db, e.id))!;
    const days = dayBreakdown(s);
    expect(days.map((d) => [d.amount, d.qty, d.txns])).toEqual([[4000, 4, 2], [2000, 2, 1]]);
    // 1日目 10:30〜11:30 = 60分、2日目 10:30〜10:50 = 20分。夜は数えない
    expect(days.map((d) => d.minutes)).toEqual([60, 20]);
    expect(salesDuration(s)!.minutes).toBe(80);

    const all = eventReport(s);
    // 10:30・11:00・11:30 の枠。10:30 の枠に、1日目 10:40 と2日目 10:50 を合算
    expect(all.slots.map((x) => x.amount)).toEqual([5000, 0, 1000]);
    expect(eventReport(s, 1).slots.map((x) => x.amount)).toEqual([2000]);

    // 持ち込みの目安: 2日で売れた分を1日あたりにして、次のイベントの日数を掛ける
    await confirmClosing(db, ctx, e.id, { returnLocationId: home.id });
    const data = await loadAnalysis(db, ctx.circleId, DEFAULT_FORECAST);
    expect(data.histories.get(a.id)!.observations[0].days).toBe(2);
    const one = bringHints(data, undefined, DEFAULT_FORECAST, undefined, 1).get(a.id)!;
    const two = bringHints(data, undefined, DEFAULT_FORECAST, undefined, 2).get(a.id)!;
    expect(two.qty).toBeGreaterThanOrEqual(one.qty * 2 - 1);
    expect(one.basis).toContain('2日間');

    await expect(saveEventInfo(db, ctx, { id: e.id, name: 'x', heldOn: ev.held_on, days: 9 })).rejects.toThrow('開催日数');
  });
});
