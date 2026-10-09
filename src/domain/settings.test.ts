import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { renameLocation, saveCircleName, saveOwner, setOwnerArchived } from './catalog';
import { createCircle } from './setup';

describe('設定', () => {
  it('サークル名・保管場所の名前・受託元を変えられ、変更は同期の送信待ちに積まれる', async () => {
    const db = freshDb('settings');
    const ctx = await createCircle(db, '旧サークル');
    await db.outbox.clear();

    await saveCircleName(db, ctx, '  新サークル ');
    expect((await db.circles.get(ctx.circleId))?.name).toBe('新サークル');
    await expect(saveCircleName(db, ctx, ' ')).rejects.toThrow('サークル名を入れてください');

    const home = (await db.locations.filter((l) => l.kind === 'storage').first())!;
    await renameLocation(db, home.id, '実家');
    expect((await db.locations.get(home.id))?.name).toBe('実家');

    const friend = await saveOwner(db, ctx, { name: 'サークルB', feeRate: 0.1 });
    await setOwnerArchived(db, friend.id, true);
    expect((await db.owners.get(friend.id))?.archived_at).toBeTruthy();
    await setOwnerArchived(db, friend.id, false);
    expect((await db.owners.get(friend.id))?.archived_at).toBeNull();
    const self = (await db.owners.filter((o) => o.is_self).first())!;
    await expect(setOwnerArchived(db, self.id, true)).rejects.toThrow('自分はしまえません');

    const queued = new Set((await db.outbox.toArray()).map((e) => e.table));
    expect([...queued].sort()).toEqual(['circles', 'locations', 'owners']);
  });
});
