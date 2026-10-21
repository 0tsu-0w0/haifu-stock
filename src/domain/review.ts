import type { HaifuDB } from '../db/local';
import type { AnalysisData } from './analysis';
import { BRING_MARGIN } from './bring';
import { deriveEvent, type EventSnapshot } from './snapshot';

// 目安と実際の結果の振り返り(F-807、Issue #37)。
// 持ち込みを反映したときに控えた目安と、持ち込み・販売・完売の時刻・推定需要を並べる

export type Verdict = 'short' | 'over' | 'ok';
export const VERDICT_LABEL: Record<Verdict, string> = { short: '足りなかった', over: '多すぎた', ok: 'ちょうどよい' };

export interface ReviewRow {
  itemId: string;
  name: string;
  /** 準備のときの目安(なければ null) */
  suggested: number | null;
  brought: number;
  sold: number;
  soldOutAt: string | null;
  /** 推定需要(完売したら、売り切れなければ売れた部数の見込み) */
  demand: number;
  /** 持ち帰った(残った)部数 */
  left: number;
  verdict: Verdict;
}

/**
 * 持ち込みの判定: 完売して需要が持ち込みを上回れば「足りなかった」、
 * 半分以上かつ3部以上残れば「多すぎた」、ほかは「ちょうどよい」
 */
export function verdictOf(brought: number, demand: number, soldOut: boolean, left: number): Verdict {
  if (soldOut && demand > brought) return 'short';
  if (brought > 0 && left >= 3 && left / brought >= 0.5) return 'over';
  return 'ok';
}

/** 1つのイベントの振り返り。推定需要は分析の観測(完売補正つき)を使い、なければ販売数 */
export function eventReview(s: EventSnapshot, analysis: AnalysisData | undefined): ReviewRow[] {
  const { summary, itemById, ownerById } = deriveEvent(s);
  const rows: ReviewRow[] = [];
  for (const ei of s.allEventItems) {
    const item = itemById.get(ei.item_id);
    if (!item || item.kind === 'set' || !ownerById.get(item.owner_id)?.is_self) continue;
    const sm = summary.get(item.id);
    const brought = sm?.brought ?? 0;
    if (brought <= 0 && ei.suggested_qty == null) continue;
    const sold = sm?.sold ?? 0;
    const obs = analysis?.histories.get(item.id)?.observations.find((o) => o.eventId === s.event.id);
    const demand = obs ? obs.demand : sold;
    // 終了処理で持ち帰った分はもうイベントの残数にないので、持ち込みから販売・見本誌などを引いて数える
    const left = Math.max(brought - sold - (sm?.given ?? 0), 0);
    rows.push({
      itemId: item.id, name: item.name, suggested: ei.suggested_qty ?? null, brought, sold, soldOutAt: sm?.soldOutAt ?? null,
      demand, left, verdict: verdictOf(brought, demand, !!sm?.soldOutAt, left),
    });
  }
  return rows;
}

export interface AccuracySummary {
  /** 目安を控えていた、確定済みのイベントの数 */
  events: number;
  /** 目安のあった品目の数 */
  items: number;
  /** 目安より需要が多かった(目安どおりなら足りなかった) */
  under: number;
  /** 目安の半分も売れなかった */
  over: number;
  ok: number;
  /** 見直しの知らせ(なければ null) */
  advice: string | null;
}

/**
 * イベントをまたいだ目安の当たり具合(Issue #37)。確定済みのイベントで、目安を控えていた品目だけを数える。
 * 余裕の割合は自動では変えず、見直したほうがよさそうなときに知らせるだけ
 */
export async function bringAccuracy(db: HaifuDB, analysis: AnalysisData): Promise<AccuracySummary> {
  const closed = new Set((await db.event_closings.toArray()).filter((c) => !c.reopened_at).map((c) => c.event_id));
  const eventIds = analysis.events.filter((e) => closed.has(e.id)).map((e) => e.id);
  const eventItems = eventIds.length ? await db.event_items.where('event_id').anyOf(eventIds).toArray() : [];
  let under = 0, over = 0, ok = 0;
  const counted = new Set<string>();
  for (const ei of eventItems) {
    if (ei.suggested_qty == null || ei.suggested_qty <= 0) continue;
    const obs = analysis.histories.get(ei.item_id)?.observations.find((o) => o.eventId === ei.event_id);
    if (!obs) continue;
    counted.add(ei.event_id);
    if (obs.demand > ei.suggested_qty) under++;
    else if (obs.demand < ei.suggested_qty * 0.5) over++;
    else ok++;
  }
  const items = under + over + ok;
  const pct = Math.round(BRING_MARGIN * 100);
  let advice: string | null = null;
  if (items >= 5 && under / items >= 1 / 3) {
    advice = `目安より売れた品目が${under}/${items}あります。いまの余裕(${pct}%)では足りないことが多いようです。持ち込みを目安より多めにするか、余裕を増やすことを検討してください。`;
  } else if (items >= 5 && over / items >= 1 / 3) {
    advice = `目安の半分も売れなかった品目が${over}/${items}あります。目安より少なめに持ち込んでもよさそうです。`;
  }
  return { events: counted.size, items, under, over, ok, advice };
}
