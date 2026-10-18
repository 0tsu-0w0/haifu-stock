import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { MAX_COVER_LENGTH, saveItem, setItemCover } from './catalog';
import { createCircle } from './setup';

describe('表紙画像(Issue #36)', () => {
  it('入れる・消す。品目を保存し直しても表紙は残る。形式と大きさを確かめる', async () => {
    const db = freshDb('cover');
    const ctx = await createCircle(db, 'テスト');
    const self = (await db.owners.filter((o) => o.is_self).first())!;
    const base = { name: '新刊A', kind: 'book' as const, price: 800, ownerId: self.id, lowThreshold: 3 };
    const a = await saveItem(db, ctx, base);
    const img = 'data:image/webp;base64,UklGRg==';

    await setItemCover(db, a.id, img);
    expect((await db.items.get(a.id))!.cover).toBe(img);
    await saveItem(db, ctx, { ...base, id: a.id, price: 900 });
    expect((await db.items.get(a.id))!.cover).toBe(img);
    expect((await db.outbox.where('table').equals('items').count())).toBeGreaterThan(0); // ほかの端末へ送る

    await expect(setItemCover(db, a.id, 'https://example.com/a.png')).rejects.toThrow('形式');
    await expect(setItemCover(db, a.id, 'data:image/png;base64,' + 'A'.repeat(MAX_COVER_LENGTH))).rejects.toThrow('大きすぎます');
    await setItemCover(db, a.id, null);
    expect((await db.items.get(a.id))!.cover).toBeNull();
  });
});
