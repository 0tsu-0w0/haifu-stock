import { describe, expect, it } from 'vitest';
import { freshDb, itemId } from '../test/helpers';
import { recordStocktake } from './catalog';
import { confirmClosing, reopenClosing } from './closing';
import { stockByLocation } from './ledger';
import { recordSale, voidTransaction } from './record';
import { addSampleData, createCircle } from './setup';
import { locationStock, storageStock } from './stock';

describe('保管場所の在庫を、関係する行だけ読んで出す', () => {
  it('全部の在庫移動から出した値と同じになる(販売・取り消し・終了処理・やり直し・棚卸し)', async () => {
    const db = freshDb('stock');
    const ctx = await createCircle(db, 'テスト');
    const ev = await addSampleData(db, ctx);
    const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
    const evLoc = (await db.locations.where('event_id').equals(ev.id).first())!;
    const a = await itemId(db, '新刊A');

    const full = async (locs: string[]) => {
      const all = stockByLocation(await db.stock_movements.toArray(), await db.transactions.toArray());
      return new Map([...all].filter(([k]) => locs.some((l) => k.endsWith(`|${l}`))));
    };
    const check = async () => {
      expect(await storageStock(db, ctx.circleId)).toEqual(await full([home.id]));
      expect(await locationStock(db, [evLoc.id])).toEqual(await full([evLoc.id]));
    };

    await check();
    const t = await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a, qty: 3 }] });
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: a, qty: 2 }] });
    await voidTransaction(db, ctx, t.id);
    await check();
    await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });
    await check();
    await reopenClosing(db, ctx, ev.id);
    await check();
    await recordStocktake(db, ctx, { locationId: home.id, lines: [{ itemId: a, counted: 1, reason: 'other' }] });
    expect((await storageStock(db, ctx.circleId)).get(`${a}|${home.id}`)).toBe(1);
    await check();
  });
});
