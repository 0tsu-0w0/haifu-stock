import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { saveItem } from './catalog';
import { colorVar } from './colors';
import { createCircle } from './setup';

describe('品目の色', () => {
  it('選んだ色を保存し、色を渡さない保存では今の色を保ち、知らない色は断る', async () => {
    const db = freshDb('colors');
    const ctx = await createCircle(db, 'テスト');
    const self = (await db.owners.filter((o) => o.is_self).first())!;
    const base = { name: '新刊A', kind: 'book' as const, price: 800, ownerId: self.id, lowThreshold: 3 };
    const a = await saveItem(db, ctx, { ...base, color: 'blue' });
    expect((await db.items.get(a.id))!.color).toBe('blue');
    await saveItem(db, ctx, { ...base, id: a.id, price: 900 });
    expect((await db.items.get(a.id))!.color).toBe('blue');
    await saveItem(db, ctx, { ...base, id: a.id, color: null });
    expect((await db.items.get(a.id))!.color).toBeNull();
    await expect(saveItem(db, ctx, { ...base, color: 'Blue; x' })).rejects.toThrow('色が正しくありません');
  });

  it('CSS には決まった名前の変数だけを渡す', () => {
    expect(colorVar('green')).toBe('var(--tag-green)');
    expect(colorVar('url(x)')).toBeUndefined();
    expect(colorVar(null)).toBeUndefined();
  });
});
