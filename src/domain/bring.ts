import { hhmm } from '../lib/format';
import { decayRates, newBookPlan, type AnalysisData, type ForecastOptions, type Observation } from './analysis';

// 次のイベントの持ち込み数の目安(F-304、F-901、F-902。Issue #28)。
// 刷り部数の目安と同じ需要の見込み(完売補正・減衰率)を使い、売り切れで機会を逃さないよう余裕を足す

/** 見込みに足す余裕(持ち込みすぎより、売り切れのほうが損が大きいため多めにする) */
export const BRING_MARGIN = 0.2;

export interface BringHint {
  /** 目安の部数(1以上) */
  qty: number;
  /** 見込みの部数(余裕を足す前) */
  expected: number;
  /** 根拠のひとこと */
  basis: string;
  /** 材料が少ない(実績が1回だけ・新刊の見込み) */
  reference: boolean;
}

/** 種別の規模の比べに要る、種別ごとの終わったイベントの数 */
export const TYPE_MIN_EVENTS = 2;

/**
 * イベント種別ごとの規模(要件 §6.2)。終わったイベントごとに、自分の品目の推定需要を1日あたりで足し、種別ごとに平均する。
 * 終わったイベントが TYPE_MIN_EVENTS 回に満たない種別は出さない
 */
export function typeScales(data: AnalysisData): Map<string, { perDay: number; events: number }> {
  const typeOf = new Map(data.events.map((e) => [e.id, e.event_type_id ?? null]));
  const size = new Map<string, number>();
  for (const h of data.histories.values()) {
    for (const o of h.observations) size.set(o.eventId, (size.get(o.eventId) ?? 0) + o.demand / Math.max(o.days, 1));
  }
  const byType = new Map<string, number[]>();
  for (const [eventId, v] of size) {
    const t = typeOf.get(eventId);
    if (t) byType.set(t, [...(byType.get(t) ?? []), v]);
  }
  const out = new Map<string, { perDay: number; events: number }>();
  for (const [t, vs] of byType) {
    if (vs.length >= TYPE_MIN_EVENTS) out.set(t, { perDay: vs.reduce((a, x) => a + x, 0) / vs.length, events: vs.length });
  }
  return out;
}

/** 規模の比は、外れた値で目安が極端にならないよう 1/4〜4倍に収める */
const clampScale = (x: number) => Math.min(4, Math.max(0.25, x));

/**
 * 自分の品目ごとの持ち込み数の目安。準備しているイベント自身の記録は材料にしない。
 * 実績のない品目は、本なら次の新刊の目安を使い、グッズは出さない
 */
export function bringHints(
  data: AnalysisData, eventId: string | undefined, opts: ForecastOptions, margin = BRING_MARGIN, days = 1,
  /** 準備しているイベントの種別(§6.2 の種別の補正に使う) */
  targetTypeId: string | null = null,
): Map<string, BringHint> {
  const rates = decayRates(data, opts);
  const nb = newBookPlan(data, opts);
  const typeOf = new Map(data.events.map((e) => [e.id, e.event_type_id ?? null]));
  const scales = targetTypeId ? typeScales(data) : new Map<string, { perDay: number; events: number }>();
  const target = targetTypeId ? scales.get(targetTypeId) : undefined;
  const out = new Map<string, BringHint>();
  for (const item of data.ownItems) {
    const obs = (data.histories.get(item.id)?.observations ?? []).filter((o) => o.eventId !== eventId);
    // 同じ種別の実績があれば、それを優先する(§6.2)
    const sameType = targetTypeId ? obs.filter((o) => typeOf.get(o.eventId) === targetTypeId) : [];
    const last: Observation | undefined = sameType[sameType.length - 1] ?? obs[obs.length - 1];
    if (last) {
      // 種別が違うときは、種別ごとの規模の比を掛ける。どちらかの種別の材料が足りなければ掛けない
      const lastType = typeOf.get(last.eventId) ?? null;
      const from = lastType ? scales.get(lastType) : undefined;
      const scale = targetTypeId && lastType !== targetTypeId && target && from && from.perDay > 0 ? clampScale(target.perDay / from.perDay) : 1;
      // 持ち込みは売り切れのほうが損が大きいので、減衰率は「強気」の値を使う
      // 2日・3日開催は、1日あたりにそろえてから、準備しているイベントの日数を掛ける(Issue #19)
      const expected = (last.demand / Math.max(last.days, 1)) * days * rates.aggressive * scale;
      const result = last.soldOutAt
        ? `${hhmm(last.soldOutAt)}に完売${last.corrected ? `(売り切れなければ約${Math.round(last.demand)}部)` : ''}`
        : `${Math.max(last.brought - last.sold, 0)}部残り`;
      // 前回完売したなら、前回の持ち込み数より減らさない
      const floor = last.soldOutAt && scale >= 1 ? Math.ceil((last.brought / Math.max(last.days, 1)) * days) : 1;
      out.set(item.id, {
        qty: Math.max(Math.ceil(expected * (1 + margin)), floor),
        expected: Math.round(expected),
        basis: `${last === obs[obs.length - 1] ? '前回' : '同じ種別の前回'}「${last.eventName}」${last.days > 1 ? `(${last.days}日間)` : ''}で${last.sold}部・${result}`
          + `${days > 1 || last.days > 1 ? `。${days}日分にそろえています` : ''}`
          + `${scale !== 1 ? `。種別の規模の違い(×${Math.round(scale * 100) / 100})を掛けています` : ''}`,
        reference: obs.length < 2 && rates.samples === 0,
      });
    } else if (item.kind === 'book' && nb) {
      const first = nb.scenarios.find((s) => s.key === 'standard')!.firstEvent * days;
      if (first <= 0) continue;
      out.set(item.id, {
        qty: Math.max(Math.ceil(first * (1 + margin)), 1),
        expected: first,
        basis: `新刊: これまでの新刊の初回(約${Math.round(first / days)}部${days > 1 ? ` × ${days}日` : ''})から`,
        reference: true,
      });
    }
  }
  return out;
}
