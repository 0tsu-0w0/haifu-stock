import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db } from '../app/db';
import { saveFloat } from '../domain/catalog';
import { floatSuggestion, payStats } from '../domain/float';
import type { Ctx } from '../domain/record';
import { yen } from '../lib/format';
import { useToast } from './Toast';

/** 釣り銭の目安(F-306)。持ち込む品目の価格と部数から見積もり、押すと準備金に入れる */
export function FloatSuggest(props: {
  ctx: Ctx;
  eventId: string;
  lines: { price: number; qty: number }[];
  current: Map<number, number>;
  locked: boolean;
}) {
  const { ctx, eventId, lines, current, locked } = props;
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const stats = useLiveQuery(async () => {
    if (!open) return undefined;
    const txns = await db.transactions.filter((t) => t.circle_id === ctx.circleId).toArray();
    const ids = new Set(txns.map((t) => t.id));
    const ls = await db.transaction_lines.filter((l) => ids.has(l.transaction_id)).toArray();
    return payStats(txns, ls);
  }, [open, ctx.circleId]);
  if (!open) {
    return <button type="button" className="link-btn" onClick={() => setOpen(true)}>持ち込む品目の価格から、釣り銭の目安を出す</button>;
  }
  if (stats === undefined) return <p className="note">計算しています…</p>;
  const s = floatSuggestion(lines, stats);
  if (!s) return <p className="note">持ち込む品目と部数を入れると、目安を出せます。</p>;
  const denoms = [...s.counts.keys()].sort((a, b) => b - a);
  return (
    <div className="float-suggest">
      <b>釣り銭の目安 {yen(s.total)}</b>
      <table className="tbl small">
        <thead><tr><th>金種</th><th>目安</th><th>いま</th></tr></thead>
        <tbody>
          {denoms.map((d) => (
            <tr key={d}>
              <td className="num">{d.toLocaleString('ja-JP')}円</td>
              <td className="num">{s.counts.get(d)}枚</td>
              <td className="num">{current.get(d) ?? 0}枚</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">
        買う人 約{s.buyers}人(1人 平均1.5部)、ちょうど払う人 {Math.round(s.exactShare * 100)}%、1万円札で払う人 {Math.round(s.bigBillShare * 100)}%
        {s.fromHistory ? '(これまでの預かり金額の記録から)' : '(記録が少ないので、よくある割合)'}として、
        お釣りの4割を準備金から出し、残りはほかのお客さんから受け取ったお金で回せるものと見ています。あくまで目安です。
      </p>
      {!locked && (
        <button
          type="button" className="btn"
          onClick={async () => {
            try {
              for (const d of denoms) await saveFloat(db, ctx, eventId, d, Math.max(current.get(d) ?? 0, s.counts.get(d) ?? 0));
              toast('足りない分を目安まで増やしました');
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e));
            }
          }}
        >足りない金種を目安まで増やす</button>
      )}
    </div>
  );
}
