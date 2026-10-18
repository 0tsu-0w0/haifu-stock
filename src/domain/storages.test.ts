import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { addPrintRun, addStorage, prepareEvent, saveEventInfo, saveItem, setStorageArchived, transferBetweenStorages } from './catalog';
import { createCircle } from './setup';
import { storageStock } from './stock';

describe('保管場所を複数持つ(F-201、F-202。Issue #30)', () => {
  it('足す・移す・しまう。移動元より多くは移せず、在庫が残る場所と最後の1つはしまえない', async () => {
    const db = freshDb('storages');
    const ctx = await createCircle(db, 'テスト');
    const self = (await db.owners.filter((o) => o.is_self).first())!;
    const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
    const a = await saveItem(db, ctx, { name: '新刊A', kind: 'book', price: 800, ownerId: self.id, lowThreshold: 3 });
    await addPrintRun(db, ctx, { itemId: a.id, qty: 50, totalCost: 20000, printedOn: null, toLocationId: home.id });

    await expect(setStorageArchived(db, ctx, home.id, true)).rejects.toThrow('1つだけ');
    const parents = await addStorage(db, ctx, ' 実家 ');
    expect(parents.name).toBe('実家');
    await expect(addStorage(db, ctx, '実家')).rejects.toThrow('もうあります');

    await transferBetweenStorages(db, ctx, { from: home.id, to: parents.id, lines: [{ itemId: a.id, qty: 30 }] });
    const stock = await storageStock(db, ctx.circleId);
    expect(stock.get(`${a.id}|${home.id}`)).toBe(20);
    expect(stock.get(`${a.id}|${parents.id}`)).toBe(30);
    await expect(transferBetweenStorages(db, ctx, { from: home.id, to: parents.id, lines: [{ itemId: a.id, qty: 21 }] }))
      .rejects.toThrow('20部しかありません');

    // 実家から直接イベントへ持ち込める
    const ev = await saveEventInfo(db, ctx, { name: 'イベント', heldOn: '2026-11-01' });
    await prepareEvent(db, ctx, ev.id, [{ itemId: a.id, included: true, bring: 10, priceOverride: null }], { storageId: parents.id });
    expect((await storageStock(db, ctx.circleId)).get(`${a.id}|${parents.id}`)).toBe(20);

    await expect(setStorageArchived(db, ctx, parents.id, true)).rejects.toThrow('20部残っています');
    await transferBetweenStorages(db, ctx, { from: parents.id, to: home.id, lines: [{ itemId: a.id, qty: 20 }] });
    await setStorageArchived(db, ctx, parents.id, true);
    expect((await db.locations.get(parents.id))!.archived_at).not.toBeNull();
    // 同じ名前で足すと、しまった場所を戻す
    expect((await addStorage(db, ctx, '実家')).id).toBe(parents.id);
  });
});
