import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { deletePriceTier, priceTiers, saveItem, savePriceTier } from './catalog';
import { createCircle } from './setup';

describe('印刷所の価格表と部数の刻み', () => {
  it('同じ部数は上書きし、消した部数をもう一度入れると同じ行を戻す', async () => {
    const db = freshDb('tiers');
    const ctx = await createCircle(db, 'テスト');
    const self = (await db.owners.filter((o) => o.is_self).first())!;
    const a = await saveItem(db, ctx, { name: '新刊A', kind: 'book', price: 800, ownerId: self.id, lowThreshold: 3 });
    await savePriceTier(db, ctx, { itemId: a.id, qty: 100, totalCost: 24000 });
    await savePriceTier(db, ctx, { itemId: a.id, qty: 50, totalCost: 18000 });
    await savePriceTier(db, ctx, { itemId: a.id, qty: 100, totalCost: 25000 });
    expect((await priceTiers(db, a.id)).map((t) => [t.qty, t.total_cost])).toEqual([[50, 18000], [100, 25000]]);

    const t50 = (await priceTiers(db, a.id))[0];
    await deletePriceTier(db, t50.id);
    expect((await priceTiers(db, a.id)).map((t) => t.qty)).toEqual([100]);
    await savePriceTier(db, ctx, { itemId: a.id, qty: 50, totalCost: 17000 });
    const again = await priceTiers(db, a.id);
    expect(again[0]).toMatchObject({ id: t50.id, qty: 50, total_cost: 17000 });
    expect(await db.print_price_tiers.count()).toBe(2);
    await expect(savePriceTier(db, ctx, { itemId: a.id, qty: 0, totalCost: 1 })).rejects.toThrow('部数は1以上');
  });

  it('部数の刻みは、渡さない保存では今の値のまま', async () => {
    const db = freshDb('lot');
    const ctx = await createCircle(db, 'テスト');
    const self = (await db.owners.filter((o) => o.is_self).first())!;
    const base = { name: '新刊A', kind: 'book' as const, price: 800, ownerId: self.id, lowThreshold: 3 };
    const a = await saveItem(db, ctx, { ...base, printLot: 50 });
    await saveItem(db, ctx, { ...base, id: a.id, price: 900 });
    expect((await db.items.get(a.id))!.print_lot).toBe(50);
    await saveItem(db, ctx, { ...base, id: a.id, printLot: null });
    expect((await db.items.get(a.id))!.print_lot).toBeNull();
    await expect(saveItem(db, ctx, { ...base, printLot: 0 })).rejects.toThrow('部数の刻み');
  });
});
