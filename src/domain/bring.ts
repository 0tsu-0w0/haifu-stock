import { hhmm } from '../lib/format';
import { decayRates, newBookPlan, type AnalysisData, type ForecastOptions } from './analysis';

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

/**
 * 自分の品目ごとの持ち込み数の目安。準備しているイベント自身の記録は材料にしない。
 * 実績のない品目は、本なら次の新刊の目安を使い、グッズは出さない
 */
export function bringHints(data: AnalysisData, eventId: string | undefined, opts: ForecastOptions, margin = BRING_MARGIN): Map<string, BringHint> {
  const rates = decayRates(data, opts);
  const nb = newBookPlan(data, opts);
  const out = new Map<string, BringHint>();
  for (const item of data.ownItems) {
    const obs = (data.histories.get(item.id)?.observations ?? []).filter((o) => o.eventId !== eventId);
    const last = obs[obs.length - 1];
    if (last) {
      // 持ち込みは売り切れのほうが損が大きいので、減衰率は「強気」の値を使う
      const expected = last.demand * rates.aggressive;
      const result = last.soldOutAt
        ? `${hhmm(last.soldOutAt)}に完売${last.corrected ? `(売り切れなければ約${Math.round(last.demand)}部)` : ''}`
        : `${Math.max(last.brought - last.sold, 0)}部残り`;
      // 前回完売したなら、前回の持ち込み数より減らさない
      const floor = last.soldOutAt ? last.brought : 1;
      out.set(item.id, {
        qty: Math.max(Math.ceil(expected * (1 + margin)), floor),
        expected: Math.round(expected),
        basis: `前回「${last.eventName}」で${last.sold}部・${result}`,
        reference: obs.length < 2 && rates.samples === 0,
      });
    } else if (item.kind === 'book' && nb) {
      const first = nb.scenarios.find((s) => s.key === 'standard')!.firstEvent;
      if (first <= 0) continue;
      out.set(item.id, {
        qty: Math.max(Math.ceil(first * (1 + margin)), 1),
        expected: first,
        basis: `新刊: これまでの新刊の初回(約${first}部)から`,
        reference: true,
      });
    }
  }
  return out;
}
