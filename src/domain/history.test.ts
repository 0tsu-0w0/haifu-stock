import { describe, expect, it } from 'vitest';
import { freshDb, itemId } from '../test/helpers';
import { filterHistory, historyRows } from './history';
import { recordGiveaway, recordSale, voidTransaction } from './record';
import { addSampleData, createCircle } from './setup';
import { deriveEvent, loadEventSnapshot } from './snapshot';

async function rowsOf(db: ReturnType<typeof freshDb>, eventId: string) {
  const s = (await loadEventSnapshot(db, eventId))!;
  const d = deriveEvent(s);
  return historyRows(s.txns, d.linesByTxn, d.itemById);
}

describe('レジの履歴', () => {
  it('新しい順に並び、中身・金額・取り消し済みの印が付く', async () => {
    const db = freshDb('history');
    const ctx = await createCircle(db, 'テスト');
    const ev = await addSampleData(db, ctx);
    let clock = Date.parse('2026-11-01T02:00:00Z');
    const tick = { ...ctx, now: () => new Date((clock += 60_000)) };
    const a = await itemId(db, '新刊A');
    await recordSale(db, tick, { eventId: ev.id, lines: [{ itemId: a, qty: 2 }, { itemId: await itemId(db, '既刊B'), qty: 1 }], paidAmount: 5000 });
    const t2 = await recordSale(db, tick, { eventId: ev.id, lines: [{ itemId: a, qty: 1 }] });
    await recordGiveaway(db, tick, { eventId: ev.id, itemId: a, qty: 1, kind: 'sample' });
    await voidTransaction(db, tick, t2.id);

    const rows = await rowsOf(db, ev.id);
    expect(rows.map((r) => r.label)).toEqual(['見本誌: 新刊A', '新刊A', '新刊A ×2・既刊B']);
    expect(rows.map((r) => r.amount)).toEqual([0, 800, 2100]);
    expect(rows[1].voided).not.toBeNull();
    expect(rows[2].txn.paid_amount).toBe(5000);

    expect(filterHistory(rows, 'sale').map((r) => r.label)).toEqual(['新刊A ×2・既刊B']);
    expect(filterHistory(rows, 'giveaway')).toHaveLength(1);
    expect(filterHistory(rows, 'voided').map((r) => r.label)).toEqual(['新刊A']);
  });
});
