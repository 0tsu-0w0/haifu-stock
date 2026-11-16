import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { deviceLabel, deviceStatuses, loadDeviceNames, saveDeviceName } from './devices';
import { createCircle } from './setup';

describe('端末の名前', () => {
  it('名前を付けて同期待ちに積み、付け直すと上書きする。空や長すぎる名前は断る', async () => {
    const db = freshDb('devices');
    const ctx = await createCircle(db, 'テスト');
    await saveDeviceName(db, ctx, ctx.deviceId, '  主のスマホ ');
    await saveDeviceName(db, ctx, 'dev-staff-0001', 'Aさん');
    await saveDeviceName(db, ctx, 'dev-staff-0001', 'Aさんのスマホ');
    const names = await loadDeviceNames(db, ctx.circleId);
    expect(names.get(ctx.deviceId)).toBe('主のスマホ');
    expect(names.get('dev-staff-0001')).toBe('Aさんのスマホ');
    const queued = await db.outbox.where('table').equals('devices').toArray();
    expect(new Set(queued.map((q) => q.key)).size).toBe(2); // 送るときは行ごとに最新の1回
    await expect(saveDeviceName(db, ctx, ctx.deviceId, '  ')).rejects.toThrow('名前を入れてください');
    await expect(saveDeviceName(db, ctx, ctx.deviceId, 'あ'.repeat(31))).rejects.toThrow('30文字まで');
  });

  it('表示名: 名前があれば名前、なければ「この端末」か末尾の4文字', () => {
    const names = new Map([['aaaa-1111', 'Aさん'], ['me-2222', '主']]);
    expect(deviceLabel(names, 'aaaa-1111', 'me-2222')).toBe('Aさん');
    expect(deviceLabel(names, 'me-2222', 'me-2222')).toBe('主(この端末)');
    expect(deviceLabel(new Map(), 'me-2222', 'me-2222')).toBe('この端末');
    expect(deviceLabel(names, 'bbbb-9876', 'me-2222')).toBe('端末 …9876');
  });
});

describe('ほかの端末の同期の様子(F-500)', () => {
  const now = new Date('2026-11-16T15:00:00Z');
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const sync = (id: string, min: number, pending = 0) => ({ id, circle_id: 'c', user_id: 'u', synced_at: ago(min), pending, client_updated_at: ago(min) });

  it('記録した端末と最近同期した端末を並べ、未送信・しばらく同期していない端末を先に出す', () => {
    const list = deviceStatuses({
      txns: [
        { device_id: 'me', recorded_at: ago(1) },
        { device_id: 'a', recorded_at: ago(30) }, { device_id: 'a', recorded_at: ago(20) },
        { device_id: 'b', recorded_at: ago(5) },
        { device_id: 'c', recorded_at: ago(40) },
        { device_id: 'old', recorded_at: ago(50) },
      ],
      syncs: [sync('a', 2), sync('b', 3, 4), sync('c', 30), sync('idle', 60), sync('gone', 60 * 30), sync('me', 0)],
      names: new Map([['a', '売り子A']]),
      myDeviceId: 'me',
      now,
    });
    expect(list.map((d) => d.id)).toEqual(['b', 'c', 'a', 'old', 'idle']);
    expect(list.find((d) => d.id === 'b')!.warn).toContain('まだ送れていない');
    expect(list.find((d) => d.id === 'c')!.warn).toContain('しばらく同期していません');
    expect(list.find((d) => d.id === 'a')).toMatchObject({ label: '売り子A', count: 2, lastRecord: ago(20), pending: 0, warn: '' });
    expect(list.find((d) => d.id === 'old')).toMatchObject({ syncedAt: null, warn: '' });
    expect(list.find((d) => d.id === 'idle')).toMatchObject({ count: 0, warn: '' }); // 記録していない端末は、古くても警告しない
  });
});
