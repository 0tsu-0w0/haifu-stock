import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { deviceLabel, loadDeviceNames, saveDeviceName } from './devices';
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
