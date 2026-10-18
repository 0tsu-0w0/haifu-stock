import type { HaifuDB } from '../db/local';
import { computeMoney, moneyAfterClosing, planCounts } from './closing';
import { eventReport, salesDuration } from './report';
import { loadEventSnapshot, type EventSnapshot } from './snapshot';
import { daysOf } from './eventDays';

// イベントをまたいだ比較(Issue #13)。どの即売会に出ると効率がよいかを見る

export interface CompareRow {
  eventId: string;
  name: string;
  heldOn: string;
  venue: string | null;
  /** イベントの種別の名前(F-301) */
  type: string | null;
  /** 開催日数(Issue #19) */
  days: number;
  /** 1日あたりの売上(全体) */
  perDay: number;
  closed: boolean;
  /** 売上(全体・受託分を含む) */
  amount: number;
  /** 自分の分の売上 */
  own: number;
  qty: number;
  txns: number;
  perCustomer: number | null;
  /** 販売時間(分、休憩を除く) */
  minutes: number | null;
  /** 1時間あたりの売上(全体) */
  perHour: number | null;
  expenses: number;
  /** 収支(自分の分の売上 − 原価 + 受託手数料 − 経費) */
  profit: number;
}

/** 1つのイベントの比較用の数字。確定済みはいまの持ち主で計算し直した値を使う(F-709 と同じ) */
export function compareRow(s: EventSnapshot, typeName: Map<string, string> = new Map()): CompareRow {
  const r = eventReport(s);
  const money = s.closing ? moneyAfterClosing(s) : computeMoney(s, planCounts(s));
  const d = salesDuration(s);
  return {
    eventId: s.event.id, name: s.event.name, heldOn: s.event.held_on, venue: s.event.venue?.trim() || null,
    type: s.event.event_type_id ? typeName.get(s.event.event_type_id) ?? null : null,
    days: daysOf(s.event),
    perDay: Math.round(r.amount / daysOf(s.event)),
    closed: !!s.closing,
    amount: r.amount, own: money.own, qty: r.qty, txns: r.txnCount, perCustomer: r.perCustomer,
    minutes: d?.minutes ?? null,
    perHour: d && d.minutes > 0 ? Math.round((r.amount / d.minutes) * 60) : null,
    expenses: money.expenses, profit: money.profit,
  };
}

/** 販売のあったイベントを、古い順に並べる(削除したイベントは除く) */
export async function loadComparison(db: HaifuDB, circleId: string): Promise<CompareRow[]> {
  const events = (await db.events.where('circle_id').equals(circleId).toArray()).filter((e) => !e.deleted_at);
  const typeName = new Map((await db.event_types.where('circle_id').equals(circleId).toArray()).map((t) => [t.id, t.name]));
  const rows: CompareRow[] = [];
  for (const e of events) {
    const s = await loadEventSnapshot(db, e.id);
    if (!s) continue;
    const row = compareRow(s, typeName);
    if (row.txns > 0) rows.push(row);
  }
  return rows.sort((a, b) => a.heldOn.localeCompare(b.heldOn) || a.name.localeCompare(b.name, 'ja'));
}

export interface VenueRow {
  venue: string;
  count: number;
  avgAmount: number;
  avgPerHour: number | null;
  avgProfit: number;
}

/** keyOf で分けた組ごとの平均(2回以上あった組だけ。1時間あたりの高い順) */
function groupAverages(rows: CompareRow[], keyOf: (r: CompareRow) => string | null) {
  const groups = new Map<string, CompareRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    if (k) groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const avg = (xs: number[]) => Math.round(xs.reduce((a, x) => a + x, 0) / xs.length);
  return [...groups]
    .filter(([, g]) => g.length >= 2)
    .map(([key, g]) => {
      const ph = g.map((r) => r.perHour).filter((x): x is number => x !== null);
      return { key, count: g.length, avgAmount: avg(g.map((r) => r.amount)), avgPerHour: ph.length ? avg(ph) : null, avgProfit: avg(g.map((r) => r.profit)) };
    })
    .sort((a, b) => (b.avgPerHour ?? 0) - (a.avgPerHour ?? 0));
}

/** 会場ごとの平均(会場を入れたイベントが2回以上ある会場だけ) */
export function byVenue(rows: CompareRow[]): VenueRow[] {
  return groupAverages(rows, (r) => r.venue).map(({ key, ...rest }) => ({ venue: key, ...rest }));
}

export interface TypeRow extends Omit<VenueRow, 'venue'> {
  type: string;
}

/** 種別ごとの平均(F-301。種別を入れたイベントが2回以上ある種別だけ) */
export function byType(rows: CompareRow[]): TypeRow[] {
  return groupAverages(rows, (r) => r.type).map(({ key, ...rest }) => ({ type: key, ...rest }));
}
