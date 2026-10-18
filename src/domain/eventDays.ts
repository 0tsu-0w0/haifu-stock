import type { EventBreak, EventRow } from '../db/types';
import { breakOverlapMs } from './breaks';

// 2日・3日開催のイベント(Issue #19)。1つのイベントのまま、開催日から続けて days 日開く。
// 開始・終了の時刻は、毎日同じとして扱う(1日目の時刻を、2日目以降にもずらして使う)

export const DAY_MS = 24 * 3600_000;
export const MAX_DAYS = 5;

type Span = Pick<EventBreak, 'starts_at' | 'ends_at'>;
type Ev = Pick<EventRow, 'held_on' | 'starts_at' | 'ends_at'> & { days?: number | null };

/** 開催日数(古いデータは1日) */
export const daysOf = (ev: { days?: number | null }) => Math.min(Math.max(Math.round(ev.days ?? 1), 1), MAX_DAYS);

/** 'YYYY-MM-DD' に n 日足す */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 最終日('YYYY-MM-DD') */
export const lastDayOf = (ev: Ev) => addDays(ev.held_on, daysOf(ev) - 1);

/** 端末の時刻での日付('YYYY-MM-DD') */
function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** その時刻が何日目か(0 から。開催日より前は 0、最終日より後は最終日) */
export function dayIndexOf(ev: Ev, ms: number): number {
  const diff = Math.round((Date.parse(`${localDate(ms)}T00:00:00Z`) - Date.parse(`${ev.held_on}T00:00:00Z`)) / DAY_MS);
  return Math.min(Math.max(diff, 0), daysOf(ev) - 1);
}

/** 「2日目」のような呼び名 */
export const dayLabel = (i: number) => `${i + 1}日目`;

/**
 * 日ごとの開催時間 [開始, 終了](ミリ秒)。開始時刻がなければ、その日の最初の販売から既定の時間。
 * その日に販売も開始時刻もなければ、その日は入れない
 */
export function dayWindows(ev: Ev, saleTimes: number[], hours: number): [number, number][] {
  const out: [number, number][] = [];
  const start0 = ev.starts_at ? Date.parse(ev.starts_at) : null;
  const end0 = ev.ends_at ? Date.parse(ev.ends_at) : null;
  for (let k = 0; k < daysOf(ev); k++) {
    const firstOfDay = saleTimes.filter((t) => dayIndexOf(ev, t) === k).reduce((a, t) => Math.min(a, t), Infinity);
    const start = start0 !== null ? start0 + k * DAY_MS : Number.isFinite(firstOfDay) ? firstOfDay : null;
    if (start === null) continue;
    const end = end0 !== null && start0 !== null ? end0 + k * DAY_MS : start + hours * 3600_000;
    if (end > start) out.push([start, end]);
  }
  return out;
}

/** 開催時間(全日程)のうち t までに過ぎた割合。休憩と、日と日のあいだの夜は数えない(F-411) */
export function activeFractionDays(t: number, windows: [number, number][], breaks: Span[]): number {
  let total = 0;
  let done = 0;
  for (const [s, e] of windows) {
    const len = e - s - breakOverlapMs(s, e, breaks);
    total += len;
    const upTo = Math.min(Math.max(t, s), e);
    done += upTo - s - breakOverlapMs(s, upTo, breaks);
  }
  if (total <= 0) return 0;
  return Math.min(Math.max(done / total, 0), 1);
}
