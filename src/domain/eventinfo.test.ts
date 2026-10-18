import { describe, expect, it } from 'vitest';
import { freshDb } from '../test/helpers';
import { ensureEventType, eventTypes, saveEventInfo } from './catalog';
import { createCircle } from './setup';

describe('イベントの終了時刻と種別(F-301。Issue #29)', () => {
  it('終了時刻と種別を保存し、渡さない保存では今の値のまま。終了は開始より後', async () => {
    const db = freshDb('eventinfo');
    const ctx = await createCircle(db, 'テスト');
    const only = await ensureEventType(db, ctx, ' オンリー ');
    expect(await ensureEventType(db, ctx, 'オンリー')).toBe(only); // 同じ名前は作り直さない
    await ensureEventType(db, ctx, '大規模');
    expect((await eventTypes(db, ctx.circleId)).map((t) => t.name)).toEqual(['オンリー', '大規模']);

    const start = '2026-11-01T02:00:00.000Z';
    const end = '2026-11-01T06:00:00.000Z';
    const ev = await saveEventInfo(db, ctx, { name: 'オンリーイベント', heldOn: '2026-11-01', startsAt: start, endsAt: end, eventTypeId: only });
    expect(await db.events.get(ev.id)).toMatchObject({ starts_at: start, ends_at: end, event_type_id: only });

    // 名前だけ直す(古い画面などから終了時刻・種別を渡さない)
    await saveEventInfo(db, ctx, { id: ev.id, name: '名前を直した', heldOn: '2026-11-01', startsAt: start });
    expect(await db.events.get(ev.id)).toMatchObject({ name: '名前を直した', ends_at: end, event_type_id: only });

    // 消す
    await saveEventInfo(db, ctx, { id: ev.id, name: '名前を直した', heldOn: '2026-11-01', startsAt: start, endsAt: null, eventTypeId: null });
    expect(await db.events.get(ev.id)).toMatchObject({ ends_at: null, event_type_id: null });

    await expect(saveEventInfo(db, ctx, { id: ev.id, name: 'x', heldOn: '2026-11-01', startsAt: end, endsAt: start }))
      .rejects.toThrow('終了時刻は、開始時刻より後');
  });
});
