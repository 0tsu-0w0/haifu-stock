import { describe, expect, it } from 'vitest';
import { uuidv7 } from './uuid';

describe('UUID v7', () => {
  it('同じミリ秒に続けて作っても、作った順に並ぶ', () => {
    const t = Date.parse('2026-10-18T12:00:00Z');
    const ids = Array.from({ length: 1000 }, () => uuidv7(t));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('版(7)とバリアントのビットを保つ', () => {
    const t = Date.now();
    for (const id of [uuidv7(t), uuidv7(t), uuidv7(t + 1)]) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});
