import { describe, expect, it } from 'vitest';
import type { ItemHistory, Observation } from './analysis';
import type { Item } from '../db/types';
import { decayByAppearance, itemTrend } from './trend';

const ob = (heldOn: string, brought: number, sold: number, demand = sold, days = 1): Observation => ({
  eventId: heldOn, eventName: `E${heldOn}`, heldOn, brought, sold, demand, days,
  soldOutAt: null, soldOutFraction: null, corrected: demand > sold,
});
const hist = (id: string, observations: Observation[]): ItemHistory => ({ item: { id, name: id } as Item, observations });

describe('頒布物の横断レポート(F-705)', () => {
  it('何回目か・消化率・初回比(1日あたり)を出す', () => {
    const rows = itemTrend(hist('a', [ob('2026-01', 50, 50, 60), ob('2026-05', 40, 30), ob('2026-08', 40, 36, 36, 2)]));
    expect(rows.map((r) => r.nth)).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({ sellThrough: 1, vsFirst: 1, corrected: true });
    expect(rows[1].sellThrough).toBe(0.75);
    expect(rows[1].vsFirst).toBe(0.5);
    // 2日開催は1日あたりにして比べる(36 ÷ 2 = 18 → 18 / 60)
    expect(rows[2].vsFirst).toBeCloseTo(0.3);
  });

  it('品目をまたいで、n回目の初回比の中央値を出す', () => {
    const d = decayByAppearance([
      hist('a', [ob('1', 10, 10), ob('2', 10, 5), ob('3', 10, 2)]),
      hist('b', [ob('1', 20, 20), ob('2', 20, 10)]),
      hist('c', [ob('1', 20, 20), ob('2', 20, 16)]),
      hist('z', [ob('1', 5, 0), ob('2', 5, 3)]),
    ]);
    expect(d).toEqual([
      { nth: 2, ratio: 0.5, samples: 3 },
      { nth: 3, ratio: 0.2, samples: 1 },
    ]);
  });
});
