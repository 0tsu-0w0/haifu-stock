import { describe, expect, it } from 'vitest';
import { freshDb, itemId } from '../test/helpers';
import {
  cashDiffHints, computeMoney, confirmClosing, planCounts, plannedExtraSales, saveCash, saveCount, saveCountFrom,
} from './closing';
import { stockByLocation } from './ledger';
import { recordSale, voidTransaction } from './record';
import { addSampleData, createCircle } from './setup';
import { deriveEvent, loadEventSnapshot } from './snapshot';

async function setup() {
  const db = freshDb('closing');
  const ctx = await createCircle(db, 'テストサークル');
  const ev = await addSampleData(db, ctx);
  const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
  const snap = async () => (await loadEventSnapshot(db, ev.id))!;
  const row = async (name: string) => planCounts(await snap()).find((r) => r.item.name === name)!;
  return { db, ctx, ev, home, snap, row };
}

describe('終了処理', () => {
  it('実数が未入力なら理論残数が入り、差異はない', async () => {
    const { snap } = await setup();
    const rows = planCounts(await snap());
    expect(rows.map((r) => r.item.name)).not.toContain('A+Bセット');
    expect(rows.every((r) => r.diff === 0 && r.handling === null)).toBe(true);
  });

  it('足りないときの既定は「販売を追加」、多いときは「持ち込み数を直す」', async () => {
    const { db, ctx, ev, snap, row } = await setup();
    await saveCountFrom(db, ctx, ev.id, await row('既刊B'), 11);
    await saveCountFrom(db, ctx, ev.id, await row('既刊D'), 16);
    expect(await row('既刊B')).toMatchObject({ theo: 12, counted: 11, diff: -1, handling: 'add_sale' });
    expect(await row('既刊D')).toMatchObject({ diff: 1, handling: 'fix_bring' });
    expect(plannedExtraSales(await snap(), planCounts(await snap()))).toBe(500);

    await saveCount(db, ctx, ev.id, (await row('既刊B')).item.id, { handling: 'lost' });
    await saveCountFrom(db, ctx, ev.id, await row('既刊B'), 10);
    expect((await row('既刊B')).handling).toBe('lost'); // 選んだ扱いは、数を直しても保たれる
  });

  it('確定すると差異の扱いが台帳に入り、残りが戻され、精算書と確定の記録ができる', async () => {
    const { db, ctx, ev, home, snap, row } = await setup();
    const id = (n: string) => itemId(db, n);
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: await id('新刊A'), qty: 3 }] });
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: await id('A+Bセット'), qty: 1 }, { itemId: await id('友人の本'), qty: 2 }] });
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: await id('既刊C'), qty: 10 }] });
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: await id('既刊C'), qty: 1 }], zeroStockOverride: true });

    await saveCountFrom(db, ctx, ev.id, await row('既刊B'), 10);   // 理論11 → 1部足りない → 販売を追加
    await saveCountFrom(db, ctx, ev.id, await row('既刊C'), 0);    // 理論−1 → 持ち込み数を直す
    await saveCountFrom(db, ctx, ev.id, await row('コピー本'), 14); // 理論15
    await saveCount(db, ctx, ev.id, (await row('コピー本')).item.id, { handling: 'lost' });

    for (const [d, n] of [[10000, 2], [5000, 1], [1000, 2], [500, 6], [100, 20]] as const) await saveCash(db, ctx, ev.id, d, n);

    const closing = await confirmClosing(db, ctx, ev.id, { returnLocationId: home.id });
    const s = await snap();
    const d = deriveEvent(s);

    // 既刊Bの販売が1部増えている
    expect(d.totals.amount).toBe(800 * 3 + 1200 + 600 * 2 + 700 * 11 + 500);
    expect(closing.summary.sales).toBe(d.totals.amount);
    // 釣り銭15,000 + 売上13,000 = 28,000 に対し、数えた額は 32,000
    expect(d.totals.amount).toBe(13000);
    expect(closing.cash_diff).toBe(32000 - 28000);
    expect(closing.summary.fixes.map((f) => [f.name, f.handling, f.qty])).toEqual([
      ['既刊B', 'add_sale', 1], ['既刊C', 'fix_bring', 1], ['コピー本', 'lost', 1],
    ]);

    // イベントの置き場所は空になり、自分の分は自宅に戻る
    const stock = stockByLocation(await db.stock_movements.toArray(), s.txns);
    const at = async (name: string, loc: string) => stock.get(`${await id(name)}|${loc}`) ?? 0;
    for (const name of ['新刊A', '既刊B', '既刊C', '友人の本', 'コピー本']) expect(await at(name, s.location!.id)).toBe(0);
    expect(await at('新刊A', home.id)).toBe(5 + 26);
    expect(await at('既刊C', home.id)).toBe(5 - 1); // 持ち込み数の修正で自宅から1部
    expect(await at('友人の本', home.id)).toBe(0);    // 受託分は持ち主に返す

    const settlements = await db.consignment_settlements.toArray();
    const b = settlements.find((x) => x.lines.some((l) => l.name === '友人の本'))!;
    expect(b).toMatchObject({ sold_qty: 2, sales_amount: 1200, fee_amount: 0, payout_amount: 1200, returned_qty: 10 });

    // 確定後はレジからは記録できない
    await expect(recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: await id('新刊A'), qty: 1 }] })).rejects.toThrow('確定済み');
    await expect(voidTransaction(db, ctx, s.txns[0].id)).rejects.toThrow('確定済み');
    await expect(saveCash(db, ctx, ev.id, 100, 1)).rejects.toThrow('確定済み');
    await expect(confirmClosing(db, ctx, ev.id, { returnLocationId: home.id })).rejects.toThrow('確定済み');
  });

  it('収支は自分の分の売上 + 受託手数料 − 経費 − 原価', async () => {
    const { db, ctx, ev, snap } = await setup();
    await recordSale(db, ctx, { eventId: ev.id, lines: [{ itemId: await itemId(db, '新刊A'), qty: 7 }, { itemId: await itemId(db, 'コピー本'), qty: 5 }] });
    const s = await snap();
    const m = computeMoney(s, planCounts(s));
    expect(m.own).toBe(5600);
    expect(m.consigned).toBe(1000);
    expect(m.fee).toBe(100); // サークルCは10%
    expect(m.expenses).toBe(8280);
    expect(m.cost).toBe(Math.round((30000 / 35) * 7));
    expect(m.profit).toBe(5600 + 100 - 8280 - m.cost);
  });

  it('現金の差額が品目の価格と同じなら、その品目を原因の候補に挙げる', () => {
    const items = [{ name: '既刊B', price: 500 }] as never;
    expect(cashDiffHints(-500, items, [])[1]).toContain('既刊B');
    expect(cashDiffHints(1000, [], [])).toContain('お札の数え間違い(1000円単位の差)');
    expect(cashDiffHints(0, items, [])).toEqual([]);
  });
});
