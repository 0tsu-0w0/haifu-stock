import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { activeFraction, breakMinutes, breakOverlapMs, endBreak, openBreak, startBreak } from './breaks';
import { addSampleData, createCircle } from './setup';

const T = (hhmm: string) => Date.parse(`2026-05-01T${hhmm}:00+09:00`);
const iso = (hhmm: string) => new Date(T(hhmm)).toISOString();

describe('休憩・離席(F-411)', () => {
  it('休憩を始めて終える。休憩中にもう一度始めても1つだけ', async () => {
    const db = freshDb('breaks');
    const ctx = await createCircle(db, 'テスト');
    const ev = await addSampleData(db, ctx);
    await startBreak(db, { ...ctx, now: () => new Date(T('12:00')) }, ev.id);
    await startBreak(db, { ...ctx, now: () => new Date(T('12:05')) }, ev.id);
    expect(await db.event_breaks.count()).toBe(1);
    expect(await endBreak(db, { ...ctx, now: () => new Date(T('12:30')) }, ev.id)).toBe(true);
    expect(await openBreak(db, ev.id)).toBeUndefined();
    expect(await endBreak(db, ctx, ev.id)).toBe(false);
    const b = (await db.event_breaks.toArray())[0];
    expect(breakMinutes([b])).toBe(30);
  });

  it('重なった休憩は二重に数えず、範囲の外は数えない', () => {
    const breaks = [
      { starts_at: iso('12:00'), ends_at: iso('12:30') },
      { starts_at: iso('12:20'), ends_at: iso('12:40') },
      { starts_at: iso('15:00'), ends_at: iso('15:10') },
    ];
    expect(breakOverlapMs(T('11:00'), T('14:00'), breaks)).toBe(40 * 60_000);
    expect(breakOverlapMs(T('12:10'), T('12:25'), breaks)).toBe(15 * 60_000);
    expect(breakOverlapMs(T('11:00'), T('16:00'), [{ starts_at: iso('15:50'), ends_at: null }], T('16:30'))).toBe(10 * 60_000);
  });

  it('開催時間の割合は、休憩を除いた時間で数える', () => {
    const w: [number, number] = [T('11:00'), T('15:00')]; // 4時間、休憩1時間 → 販売時間3時間
    const breaks = [{ starts_at: iso('12:00'), ends_at: iso('13:00') }];
    expect(activeFraction(T('12:00'), w, breaks)).toBeCloseTo(1 / 3);
    expect(activeFraction(T('12:30'), w, breaks)).toBeCloseTo(1 / 3); // 休憩中は進まない
    expect(activeFraction(T('14:00'), w, breaks)).toBeCloseTo(2 / 3);
    expect(activeFraction(T('12:00'), w, [])).toBeCloseTo(1 / 4);
  });
});
