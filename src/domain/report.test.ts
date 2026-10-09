import { describe, expect, it } from 'vitest';
import { getMeta } from '../db/local';
import { freshDb } from '../test/helpers';
import { eventsCsv, exportBackup, importBackup, movementsCsv, salesCsv, toCsv } from './backup';
import { addPrintRun, prepareEvent, recordStocktake, saveEventInfo, saveItem, saveOwner, saveSortOrder } from './catalog';
import { stockByLocation } from './ledger';
import { recordGiveaway, recordSale, voidTransaction, type Ctx } from './record';
import { eventReport } from './report';
import { createCircle } from './setup';
import { loadEventSnapshot } from './snapshot';

const at = (hhmm: string) => () => new Date(`2026-05-01T${hhmm}:00+09:00`);

async function setup() {
  const db = freshDb('report');
  const ctx = await createCircle(db, 'テスト');
  const self = (await db.owners.filter((o) => o.is_self).first())!;
  const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
  const a = await saveItem(db, ctx, { name: '新刊A', kind: 'book', price: 800, ownerId: self.id, lowThreshold: 3 });
  const b = await saveItem(db, ctx, { name: '既刊B', kind: 'book', price: 500, ownerId: self.id, lowThreshold: 3 });
  const friend = await saveOwner(db, ctx, { name: 'サークルB', feeRate: 0 });
  const fb = await saveItem(db, ctx, { name: '友人の本, "特装"', kind: 'book', price: 600, ownerId: friend.id, lowThreshold: 3 });
  await addPrintRun(db, ctx, { itemId: a.id, qty: 30, totalCost: 30000, printedOn: null, toLocationId: home.id });
  await addPrintRun(db, ctx, { itemId: b.id, qty: 20, totalCost: 10000, printedOn: null, toLocationId: home.id });
  const ev = await saveEventInfo(db, ctx, { name: 'コミティア', heldOn: '2026-05-01', startsAt: '2026-05-01T11:00:00+09:00' });
  await prepareEvent(db, ctx, ev.id, [
    { itemId: a.id, included: true, bring: 3, priceOverride: null },
    { itemId: b.id, included: true, bring: 10, priceOverride: null },
    { itemId: fb.id, included: true, bring: 5, priceOverride: null },
  ], { storageId: home.id });
  return { db, ctx, home, a, b, fb, ev };
}

describe('イベントのレポート(F-701〜703)', () => {
  it('売上・取引件数・客単価、品目ごとの消化率と完売時刻、30分ごとの売れ方を出す', async () => {
    const { db, ctx, a, b, fb, ev } = await setup();
    const c = (t: string): Ctx => ({ ...ctx, now: at(t) });
    await recordSale(db, c('11:05'), { eventId: ev.id, lines: [{ itemId: a.id, qty: 2 }, { itemId: b.id, qty: 1 }] });
    await recordSale(db, c('11:20'), { eventId: ev.id, lines: [{ itemId: fb.id, qty: 1 }] });
    await recordSale(db, c('12:10'), { eventId: ev.id, lines: [{ itemId: a.id, qty: 1 }], discount: 100 });
    const voided = await recordSale(db, c('12:15'), { eventId: ev.id, lines: [{ itemId: b.id, qty: 1 }] });
    await voidTransaction(db, c('12:16'), voided.id);
    await recordGiveaway(db, c('12:20'), { eventId: ev.id, itemId: b.id, qty: 1, kind: 'sample' });

    const r = eventReport((await loadEventSnapshot(db, ev.id))!);
    expect(r.amount).toBe(1600 + 500 + 600 + 700);
    expect(r.qty).toBe(5);
    expect(r.txnCount).toBe(3);
    expect(r.perCustomer).toBe(Math.round(3400 / 3));
    expect(r.discount).toBe(100);

    const rowA = r.rows.find((x) => x.itemId === a.id)!;
    expect([rowA.brought, rowA.sold, rowA.remaining, rowA.sellThrough]).toEqual([3, 3, 0, 1]);
    expect(rowA.soldOutAt).toBe(at('12:10')().toISOString());
    const rowB = r.rows.find((x) => x.itemId === b.id)!;
    expect([rowB.sold, rowB.given, rowB.remaining]).toEqual([1, 1, 8]);
    expect(r.rows.find((x) => x.itemId === fb.id)!.ownerName).toBe('サークルB');
    expect(r.soldOuts.map((s) => s.name)).toEqual(['新刊A']);

    // 11:00 から 30分ごと: 11:00 / 11:30 / 12:00
    expect(r.slots.map((s) => [s.amount, s.txns])).toEqual([[2700, 2], [0, 0], [700, 1]]);
    expect(r.slots[0].start).toBe(new Date('2026-05-01T11:00:00+09:00').toISOString());
  });
});

describe('棚卸しと並び順', () => {
  it('数えた実数との差を理由つきの調整として記録し、在庫を実数に合わせる', async () => {
    const { db, ctx, home, a, b } = await setup();
    // 自宅: 新刊A 27部、既刊B 10部。通販で新刊Aを2部発送、既刊Bは1部見つかった
    const r = await recordStocktake(db, ctx, {
      locationId: home.id,
      lines: [{ itemId: a.id, counted: 25, reason: 'mail_order' }, { itemId: b.id, counted: 11, reason: 'found' }],
    });
    expect(r.adjusted).toBe(2);
    const stock = stockByLocation(await db.stock_movements.toArray(), await db.transactions.toArray());
    expect(stock.get(`${a.id}|${home.id}`)).toBe(25);
    expect(stock.get(`${b.id}|${home.id}`)).toBe(11);
    const notes = (await db.stock_movements.filter((m) => m.reason === 'adjust').toArray()).map((m) => m.note);
    expect(notes.sort()).toEqual(['棚卸し: 数え漏れ・見つかった', '棚卸し: 通販で発送']);
    // 同じ数でもう一度記録しても、差がないので何も書かない
    expect((await recordStocktake(db, ctx, { locationId: home.id, lines: [{ itemId: a.id, counted: 25, reason: 'other' }] })).adjusted).toBe(0);
  });

  it('レジの並び順を保存する', async () => {
    const { db, a, b, fb, ev } = await setup();
    await saveSortOrder(db, ev.id, [fb.id, a.id, b.id]);
    const snap = (await loadEventSnapshot(db, ev.id))!;
    expect(snap.eventItems.map((e) => e.item_id)).toEqual([fb.id, a.id, b.id]);
  });
});

describe('バックアップとCSV(F-1002、F-707)', () => {
  it('書き出したバックアップを、まだサークルのない端末に読み込むと同じ集計になる。2回読み込んでも増えない', async () => {
    const { db, ctx, a, ev } = await setup();
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a.id, qty: 2 }] });
    const file = JSON.parse(JSON.stringify(await exportBackup(db, ctx.circleId)));

    const other = freshDb('restore');
    const first = await importBackup(other, file);
    expect(first.added).toBeGreaterThan(10);
    expect(await getMeta(other, 'circle_id')).toBe(ctx.circleId);
    const before = eventReport((await loadEventSnapshot(db, ev.id))!);
    const after = eventReport((await loadEventSnapshot(other, ev.id))!);
    expect(after.amount).toBe(before.amount);
    expect(await other.outbox.count()).toBe(first.added);
    expect(await importBackup(other, file)).toEqual({ added: 0, updated: 0 });

    // 別のサークルがある端末には読み込まない
    const third = freshDb('other-circle');
    await createCircle(third, '別のサークル');
    await expect(importBackup(third, file)).rejects.toThrow('別のサークルがあります');
  });

  it('CSVは区切り文字や引用符を含む値を正しく囲み、取引明細・在庫の履歴・イベント別の集計を出す', async () => {
    expect(toCsv([['a,b', 'say "hi"', 3, null]])).toBe('"a,b","say ""hi""",3,');
    const { db, ctx, a, fb, ev } = await setup();
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a.id, qty: 1 }, { itemId: fb.id, qty: 1 }], discount: 140, note: 'まとめ買い' });
    const sales = (await salesCsv(db, ctx.circleId)).split('\r\n');
    expect(sales[0].startsWith('日時,イベント')).toBe(true);
    expect(sales).toHaveLength(3);
    expect(sales.some((l) => l.includes('"友人の本, ""特装"""') && l.includes('サークルB') && l.includes('まとめ買い'))).toBe(true);
    expect((await movementsCsv(db, ctx.circleId)).split('\r\n').length).toBeGreaterThan(4);
    const evs = (await eventsCsv(db, ctx.circleId)).split('\r\n');
    expect(evs[1].split(',').slice(0, 4)).toEqual(['2026-05-01', 'コミティア', '1260', '2']);
  });
});
