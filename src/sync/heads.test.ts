import { describe, expect, it } from 'vitest';
import { setMeta } from '../db/local';
import { TABLES } from '../db/tables';
import { recordSale, type Ctx } from '../domain/record';
import { addSampleData, createCircle, deviceId, userId } from '../domain/setup';
import { freshDb, itemId } from '../test/helpers';
import { syncOnce } from './engine';
import { MemoryRemote } from './memoryRemote';

async function twoDevices(remote: MemoryRemote) {
  const owner = freshDb('h-owner');
  const ownerCtx = await createCircle(owner, 'テスト');
  const ev = await addSampleData(owner, ownerCtx);
  await syncOnce(owner, remote);
  const staff = freshDb('h-staff');
  await setMeta(staff, 'circle_id', ownerCtx.circleId);
  const staffCtx: Ctx = { circleId: ownerCtx.circleId, deviceId: await deviceId(staff), userId: await userId(staff) };
  await syncOnce(staff, remote);
  return { owner, ownerCtx, staff, staffCtx, ev };
}

describe('同期の軽量化: 変わった表だけを受け取る', () => {
  it('何も変わっていなければ、問い合わせは1回だけ', async () => {
    const remote = new MemoryRemote();
    const { staff } = await twoDevices(remote);
    const r = await syncOnce(staff, remote);
    expect(r.pullRequests).toBe(1);
    expect(r.pulled).toBe(0);
  });

  it('販売が増えたら、販売に関係する表だけを受け取り、結果は全部受け取ったときと同じ', async () => {
    const remote = new MemoryRemote();
    const { owner, ownerCtx, staff, ev } = await twoDevices(remote);
    await recordSale(owner, ownerCtx, { eventId: ev.id, lines: [{ itemId: await itemId(owner, '新刊A'), qty: 2 }] });
    await syncOnce(owner, remote);
    const r = await syncOnce(staff, remote);
    // 取引・明細・在庫の動き の3つの表と、最初の1回
    expect(r.pullRequests).toBe(1 + 3);
    expect(await staff.transactions.count()).toBe(1);
    expect(await staff.transaction_lines.count()).toBe(1);
  });

  it('サーバーに関数がないときは、これまでどおり全部の表を見に行く', async () => {
    const remote = new MemoryRemote();
    const { staff } = await twoDevices(remote);
    remote.headsEnabled = false;
    const r = await syncOnce(staff, remote);
    expect(r.pullRequests).toBe(1 + TABLES.length); // 調べる1回(関数がないと返る)と、全部の表
  });
});
