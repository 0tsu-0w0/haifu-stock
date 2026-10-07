import { describe, expect, it } from 'vitest';
import { setMeta } from '../db/local';
import { recordSale, voidTransaction, type Ctx } from '../domain/record';
import { addSampleData, createCircle, deviceId, userId } from '../domain/setup';
import { eventState, freshDb, itemId } from '../test/helpers';
import { syncOnce } from './engine';
import { exportLedger, importLedger } from './file';
import { MemoryRemote } from './memoryRemote';

/** サークル主の端末と、同じサークルに参加した売り子の端末を用意する */
async function twoDevices() {
  const remote = new MemoryRemote();
  const owner = freshDb('owner');
  const ownerCtx = await createCircle(owner, 'テストサークル');
  const ev = await addSampleData(owner, ownerCtx);
  await syncOnce(owner, remote);

  const staff = freshDb('staff');
  await setMeta(staff, 'circle_id', ownerCtx.circleId);
  const staffCtx: Ctx = { circleId: ownerCtx.circleId, deviceId: await deviceId(staff), userId: await userId(staff) };
  await syncOnce(staff, remote);
  return { remote, owner, ownerCtx, staff, staffCtx, ev };
}

describe('同期', () => {
  it('売り子の端末は、サーバー経由で品目とイベントを受け取る', async () => {
    const { staff, ev } = await twoDevices();
    expect(await staff.items.count()).toBe(9);
    expect((await eventState(staff, ev.id)).byName('新刊A').remaining).toBe(30);
  });

  it('2台がオフラインで別々に記録しても、同期すると同じ結果になる', async () => {
    const { remote, owner, ownerCtx, staff, staffCtx, ev } = await twoDevices();
    remote.offline = true;
    const a = await itemId(owner, '新刊A');
    for (let i = 0; i < 3; i++) await recordSale(owner, ownerCtx, { eventId: ev.id, lines: [{ itemId: a, qty: 1 }] });
    await recordSale(staff, staffCtx, { eventId: ev.id, lines: [{ itemId: a, qty: 1 }] });
    const mistake = await recordSale(staff, staffCtx, { eventId: ev.id, lines: [{ itemId: await itemId(staff, 'アクスタ'), qty: 1 }] });
    await voidTransaction(staff, staffCtx, mistake.id);

    await expect(syncOnce(owner, remote)).rejects.toThrow('offline');
    expect(await owner.outbox.count()).toBeGreaterThan(0); // 送れなかった記録は残る

    remote.offline = false;
    await syncOnce(owner, remote);
    await syncOnce(staff, remote);
    await syncOnce(owner, remote);

    const o = await eventState(owner, ev.id);
    const s = await eventState(staff, ev.id);
    expect(o.byName('新刊A').remaining).toBe(26);
    expect(s.byName('新刊A').remaining).toBe(26);
    expect(o.totals).toEqual(s.totals);
    expect(o.totals.amount).toBe(800 * 4);
    expect(o.txns).toHaveLength(6); // 販売5 + 取り消し1
    expect(await owner.outbox.count()).toBe(0);
    expect(await staff.outbox.count()).toBe(0);
  });

  it('同期を繰り返しても、サーバーの記録は増えない', async () => {
    const { remote, owner, ownerCtx, staff, ev } = await twoDevices();
    await recordSale(owner, ownerCtx, { eventId: ev.id, lines: [{ itemId: await itemId(owner, '新刊A'), qty: 1 }] });
    await syncOnce(owner, remote);
    const before = remote.count('transactions');
    for (let i = 0; i < 3; i++) {
      await syncOnce(owner, remote);
      await syncOnce(staff, remote);
    }
    expect(remote.count('transactions')).toBe(before);
  });

  it('マスタは後から編集した方が残る', async () => {
    const { remote, owner, staff } = await twoDevices();
    const id = await itemId(owner, '新刊A');
    await staff.items.update(id, { price: 700, client_updated_at: '2026-01-01T00:00:00.000Z' });
    await staff.outbox.add({ table: 'items', key: JSON.stringify([id]), queued_at: new Date().toISOString() });
    await owner.items.update(id, { price: 900, client_updated_at: '2030-01-01T00:00:00.000Z' });
    await owner.outbox.add({ table: 'items', key: JSON.stringify([id]), queued_at: new Date().toISOString() });
    await syncOnce(owner, remote);
    await syncOnce(staff, remote);
    await syncOnce(staff, remote);
    expect((await staff.items.get(id))?.price).toBe(900);
  });

  it('通信できないままでも、ファイルで取り込める。2回取り込んでも重複しない', async () => {
    const { remote, owner, staff, staffCtx, ev } = await twoDevices();
    remote.offline = true;
    await recordSale(staff, staffCtx, { eventId: ev.id, lines: [{ itemId: await itemId(staff, '友人の本'), qty: 2 }] });
    await recordSale(staff, staffCtx, { eventId: ev.id, lines: [{ itemId: await itemId(staff, 'A+Bセット'), qty: 1 }] });

    const file = JSON.parse(JSON.stringify(await exportLedger(staff, ev.id, staffCtx.deviceId)));
    expect(await importLedger(owner, file)).toBe(2);
    expect(await importLedger(owner, file)).toBe(0);

    const s = await eventState(owner, ev.id);
    expect(s.byName('友人の本').remaining).toBe(10);
    expect(s.byName('既刊B').remaining).toBe(11);
    expect(s.totals.amount).toBe(2400);

    // あとでつながったら、両方の端末から送っても1件ずつ
    remote.offline = false;
    await syncOnce(owner, remote);
    await syncOnce(staff, remote);
    expect(remote.count('transactions')).toBe(2);
  });
});
