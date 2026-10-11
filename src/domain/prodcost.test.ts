import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { productionCost, saveItem, saveProductionCost } from './catalog';
import { createCircle } from './setup';

describe('制作費(F-107)', () => {
  it('品目ごとに1行を書き換え、ほかの端末で増えた行は0円にする', async () => {
    const db = freshDb('prodcost');
    const ctx = await createCircle(db, 'テスト');
    const self = (await db.owners.filter((o) => o.is_self).first())!;
    const a = await saveItem(db, ctx, { name: '新刊A', kind: 'book', price: 800, ownerId: self.id, lowThreshold: 3 });

    await saveProductionCost(db, ctx, a.id, 0);
    expect(await db.production_costs.count()).toBe(0);

    await saveProductionCost(db, ctx, a.id, 15000);
    await saveProductionCost(db, ctx, a.id, 12000);
    expect(await productionCost(db, a.id)).toBe(12000);
    expect(await db.production_costs.count()).toBe(1);

    // 別の端末で同時に作られた行があっても、合計が入れた金額になる
    await db.production_costs.put({ id: 'zzz', circle_id: ctx.circleId, item_id: a.id, label: '制作費', amount: 5000, client_updated_at: new Date().toISOString() });
    await saveProductionCost(db, ctx, a.id, 8000);
    expect(await productionCost(db, a.id)).toBe(8000);

    await expect(saveProductionCost(db, ctx, a.id, -1)).rejects.toThrow('0円以上');
  });
});
