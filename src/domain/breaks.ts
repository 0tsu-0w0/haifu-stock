import { putAndQueue, type HaifuDB } from '../db/local';
import type { EventBreak } from '../db/types';
import { uuidv7 } from '../lib/uuid';
import type { Ctx } from './record';

// 休憩・離席(F-411)。休憩の時間帯は、集計のときに販売時間から除く

type Span = Pick<EventBreak, 'starts_at' | 'ends_at'>;

/** 休憩を始める。すでに休憩中なら何もしない */
export async function startBreak(db: HaifuDB, ctx: Ctx, eventId: string): Promise<void> {
  await db.transaction('rw', ['event_breaks', 'outbox'], async () => {
    if (await openBreak(db, eventId)) return;
    const now = (ctx.now?.() ?? new Date()).toISOString();
    await putAndQueue(db, 'event_breaks', {
      id: uuidv7(), circle_id: ctx.circleId, event_id: eventId, starts_at: now, ends_at: null, client_updated_at: now,
    } satisfies EventBreak);
  });
}

/** 休憩を終える。休憩中でなければ false */
export async function endBreak(db: HaifuDB, ctx: Ctx, eventId: string): Promise<boolean> {
  return db.transaction('rw', ['event_breaks', 'outbox'], async () => {
    const cur = await openBreak(db, eventId);
    if (!cur) return false;
    const now = (ctx.now?.() ?? new Date()).toISOString();
    await putAndQueue(db, 'event_breaks', { ...cur, ends_at: now, client_updated_at: now });
    return true;
  });
}

export async function openBreak(db: HaifuDB, eventId: string): Promise<EventBreak | undefined> {
  return db.event_breaks.where('event_id').equals(eventId).filter((b) => !b.ends_at).first();
}

/** from〜to のうち、休憩と重なる時間(ミリ秒)。終わっていない休憩は now まで続いているとみなす */
export function breakOverlapMs(from: number, to: number, breaks: Span[], now = Date.now()): number {
  if (to <= from) return 0;
  // 重なった休憩を二重に数えないよう、まとめてから数える
  const spans = breaks
    .map((b) => [Date.parse(b.starts_at), b.ends_at ? Date.parse(b.ends_at) : now] as const)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curS = -Infinity, curE = -Infinity;
  const flush = () => {
    const s = Math.max(curS, from), e = Math.min(curE, to);
    if (e > s) total += e - s;
  };
  for (const [s, e] of spans) {
    if (s > curE) {
      flush();
      curS = s; curE = e;
    } else curE = Math.max(curE, e);
  }
  flush();
  return total;
}

/** 開催時間のうち t までに過ぎた割合。休憩の時間は数えない(F-411) */
export function activeFraction(t: number, window: [number, number], breaks: Span[]): number {
  const [s, e] = window;
  const total = e - s - breakOverlapMs(s, e, breaks);
  if (total <= 0) return 0;
  const done = Math.min(Math.max(t, s), e) - s - breakOverlapMs(s, Math.min(Math.max(t, s), e), breaks);
  return Math.min(Math.max(done / total, 0), 1);
}

/** 休憩の合計(分) */
export const breakMinutes = (breaks: Span[], now = Date.now()) =>
  Math.round(breaks.reduce((a, b) => a + Math.max((b.ends_at ? Date.parse(b.ends_at) : now) - Date.parse(b.starts_at), 0), 0) / 60_000);
