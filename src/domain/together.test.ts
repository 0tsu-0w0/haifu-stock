import { describe, expect, it } from 'vitest';
import { freshDb, itemId } from '../test/helpers';
import { endBreak, startBreak } from './breaks';
import { recordSale, voidTransaction } from './record';
import { boughtTogether, salesDuration } from './report';
import { addSampleData, createCircle } from './setup';
import { loadEventSnapshot } from './snapshot';

const T = (hhmm: string) => new Date(`2026-05-01T${hhmm}:00+09:00`);

async function setup() {
  const db = freshDb('together');
  const ctx = await createCircle(db, 'テスト');
  const ev = await addSampleData(db, ctx);
  await db.events.update(ev.id, { starts_at: T('11:00').toISOString() });
  const id = (n: string) => itemId(db, n);
  const sale = async (at: string, names: string[]) =>
    recordSale(db, { ...ctx, now: () => T(at) }, { eventId: ev.id, lines: await Promise.all(names.map(async (n) => ({ itemId: await id(n), qty: 1 }))) });
  return { db, ctx, ev, sale, snap: async () => (await loadEventSnapshot(db, ev.id))! };
}

describe('よく一緒に買われた組み合わせ(F-706)', () => {
  it('2品目以上の取引から組を数え、多い順に出す。取り消した販売は数えない', async () => {
    const { db, ctx, sale, snap } = await setup();
    await sale('11:10', ['新刊A', '既刊B']);
    await sale('11:20', ['新刊A', '既刊B', '既刊C']);
    await sale('11:30', ['新刊A', '既刊C']);
    await sale('11:40', ['新刊A']);
    const v = await sale('11:50', ['既刊B', '既刊C']);
    await voidTransaction(db, ctx, v.id);
    const r = boughtTogether(await snap());
    expect(r.multiTxns).toBe(3);
    expect(r.pairs[0]).toMatchObject({ count: 2 });
    expect(r.pairs.map((p) => [p.a, p.b, p.count]).filter(([, , c]) => c === 2).length).toBe(2);
    expect(r.pairs.find((p) => [p.a, p.b].includes('既刊B') && [p.a, p.b].includes('既刊C'))!.count).toBe(1);
  });
});

describe('販売時間(F-411)', () => {
  it('開始時刻から最後の販売までのうち、休憩を除いた時間', async () => {
    const { db, ctx, ev, sale, snap } = await setup();
    await sale('11:30', ['新刊A']);
    await startBreak(db, { ...ctx, now: () => T('12:00') }, ev.id);
    await endBreak(db, { ...ctx, now: () => T('12:30') }, ev.id);
    await sale('14:00', ['既刊B']);
    expect(salesDuration(await snap())).toEqual({ minutes: 180 - 30, breakMinutes: 30 });
  });
});
