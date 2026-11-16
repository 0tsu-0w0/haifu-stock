import { describe, expect, it } from 'vitest';
import type { Remote } from './engine';

/**
 * 同期の相手(Remote)が守る決まり(Issue #45)。新しいサーバーの Remote を作ったら、
 * このテストを通るか確かめる。いまはメモリ上の偽物で確かめている(src/sync/remoteContract.test.ts)。
 * 決まりの元は db/schema.sql(後勝ち・追記だけ・server_seq)
 */
export function describeRemoteContract(name: string, make: () => Promise<Remote> | Remote) {
  const t = (s: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, s)).toISOString();

  describe(`Remote の決まり: ${name}`, () => {
    it('送った行は、server_seq を付けて受け取れる', async () => {
      const r = await make();
      await r.push('items', [{ id: 'a', name: 'A', client_updated_at: t(1) }]);
      const rows = await r.pull('items', 0, 100);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 'a', name: 'A' });
      expect(Number(rows[0].server_seq)).toBeGreaterThan(0);
    });

    it('マスタは client_updated_at の後勝ち(古い書き込みは無視する)', async () => {
      const r = await make();
      await r.push('items', [{ id: 'a', name: '新', client_updated_at: t(5) }]);
      await r.push('items', [{ id: 'a', name: '古', client_updated_at: t(1) }]);
      expect((await r.pull('items', 0, 100))[0].name).toBe('新');
      await r.push('items', [{ id: 'a', name: 'もっと新', client_updated_at: t(9) }]);
      expect((await r.pull('items', 0, 100))[0].name).toBe('もっと新');
    });

    it('台帳は追記だけ(同じ主キーは最初の行のまま)', async () => {
      const r = await make();
      await r.push('stock_movements', [{ id: 'm', qty: 1 }]);
      await r.push('stock_movements', [{ id: 'm', qty: 99 }]);
      const rows = await r.pull('stock_movements', 0, 100);
      expect(rows).toHaveLength(1);
      expect(rows[0].qty).toBe(1);
    });

    it('since より新しい行だけを、server_seq の小さい順に limit 件まで返す', async () => {
      const r = await make();
      for (let i = 0; i < 5; i++) await r.push('items', [{ id: `i${i}`, client_updated_at: t(i) }]);
      const all = await r.pull('items', 0, 100);
      const seqs = all.map((x) => Number(x.server_seq));
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      const page = await r.pull('items', seqs[1], 2);
      expect(page.map((x) => x.id)).toEqual([all[2].id, all[3].id]);
      expect(await r.pull('items', seqs[4], 100)).toEqual([]);
    });

    it('書き直した行は、新しい server_seq で受け取り直せる', async () => {
      const r = await make();
      await r.push('items', [{ id: 'a', name: '1', client_updated_at: t(1) }]);
      const [first] = await r.pull('items', 0, 100);
      await r.push('items', [{ id: 'a', name: '2', client_updated_at: t(2) }]);
      const again = await r.pull('items', Number(first.server_seq), 100);
      expect(again.map((x) => x.name)).toEqual(['2']);
    });

    it('heads を返すなら、表ごとの最新の server_seq と同じかそれ以上', async () => {
      const r = await make();
      await r.push('items', [{ id: 'a', client_updated_at: t(1) }]);
      const heads = await r.heads?.();
      if (!heads) return; // heads のないサーバーでも同期はできる(全部の表を見に行く)
      const rows = await r.pull('items', 0, 100);
      expect(heads.items).toBeGreaterThanOrEqual(Math.max(...rows.map((x) => Number(x.server_seq))));
    });
  });
}
