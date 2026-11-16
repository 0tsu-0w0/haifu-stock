import { describe, expect, it } from 'vitest';
import { createCircle } from '../domain/setup';
import { freshDb } from '../test/helpers';
import { syncOnce } from './engine';
import { MemoryRemote } from './memoryRemote';
import { REPORT_EVERY_MS, reportDeviceSync } from './deviceSync';

describe('端末ごとの最後の同期(F-500)', () => {
  it('同期のあとに自分の行を直接書き、送信待ちには積まない。続けては書かない', async () => {
    const db = freshDb('devsync');
    const ctx = await createCircle(db, 'テスト');
    const remote = new MemoryRemote();
    await syncOnce(db, remote);
    const t0 = new Date('2026-11-16T10:00:00Z');
    expect(await reportDeviceSync(db, remote, t0)).toBe(true);
    expect(await db.outbox.count()).toBe(0);
    const [row] = await remote.pull('device_syncs', 0, 10);
    expect(row).toMatchObject({ id: ctx.deviceId, circle_id: ctx.circleId, pending: 0, synced_at: t0.toISOString() });
    expect((await db.device_syncs.get(ctx.deviceId))?.synced_at).toBe(t0.toISOString());

    expect(await reportDeviceSync(db, remote, new Date(t0.getTime() + 1000))).toBe(false);
    expect(await reportDeviceSync(db, remote, new Date(t0.getTime() + REPORT_EVERY_MS))).toBe(true);
  });

  it('未送信の件数が変わったら、間隔を待たずに書く。書けなくても投げない', async () => {
    const db = freshDb('devsync2');
    await createCircle(db, 'テスト'); // サークルを作ると送信待ちが積まれる
    const remote = new MemoryRemote();
    const t0 = new Date('2026-11-16T10:00:00Z');
    expect(await reportDeviceSync(db, remote, t0)).toBe(true);
    expect((await remote.pull('device_syncs', 0, 10))[0].pending).toBeGreaterThan(0);
    await syncOnce(db, remote);
    expect(await reportDeviceSync(db, remote, new Date(t0.getTime() + 1000))).toBe(true);
    expect((await remote.pull('device_syncs', 0, 10))[0].pending).toBe(0);

    remote.offline = true;
    expect(await reportDeviceSync(db, remote, new Date(t0.getTime() + 10 * REPORT_EVERY_MS))).toBe(false);
  });
});
