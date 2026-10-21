import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../app/db';
import { DEFAULT_FORECAST, loadAnalysis } from '../domain/analysis';
import { VERDICT_LABEL, bringAccuracy, eventReview } from '../domain/review';
import type { EventSnapshot } from '../domain/snapshot';
import { hhmm } from '../lib/format';

/** レポートの「目安と実際」(F-807、Issue #37)。終了処理を確定したイベントだけに出す */
export function BringReview({ data }: { data: EventSnapshot }) {
  const analysis = useLiveQuery(() => loadAnalysis(db, data.event.circle_id, DEFAULT_FORECAST), [data.event.circle_id]);
  if (!data.closing) return null;
  if (!analysis) return <p className="note">計算しています…</p>;
  const rows = eventReview(data, analysis);
  if (rows.length === 0) return null;
  const anySuggested = rows.some((r) => r.suggested !== null);
  return (
    <>
      <h3 className="section">目安と実際</h3>
      <div className="card table-scroll">
        <table className="tbl small report-tbl review-tbl">
          <thead>
            <tr><th>品目</th>{anySuggested && <th>目安</th>}<th>持ち込み</th><th>販売</th><th>需要</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.itemId}>
                <td>{r.name}{r.soldOutAt && <small className="k">{hhmm(r.soldOutAt)}に完売</small>}</td>
                {anySuggested && <td className="num">{r.suggested ?? '—'}</td>}
                <td className="num">{r.brought}</td>
                <td className="num">{r.sold}</td>
                <td className="num">{Math.round(r.demand)}</td>
                <td>
                  <span className={`verdict ${r.verdict}`}>{VERDICT_LABEL[r.verdict]}</span>
                  <small className="k">
                    {r.verdict === 'short' ? `約${Math.round(r.demand - r.brought)}部足りない` : r.verdict === 'over' ? `${r.left}部持ち帰り` : ''}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">
        需要は、完売したときは売り切れなければ売れた部数の見込みです(刷り部数の目安と同じ計算)。
        「目安」は、準備で持ち込みを反映したときに出ていた部数です{anySuggested ? '' : '(このイベントでは控えていません)'}。
      </p>
    </>
  );
}

/** イベントの比較の「目安の当たり具合」(Issue #37) */
export function BringAccuracyCard({ circleId }: { circleId: string }) {
  const acc = useLiveQuery(async () => bringAccuracy(db, await loadAnalysis(db, circleId, DEFAULT_FORECAST)), [circleId]);
  if (!acc || acc.items === 0) return null;
  return (
    <>
      <h3 className="section">持ち込みの目安の当たり具合</h3>
      <div className="card">
        <div className="metrics">
          <div className="metric"><small>目安より売れた</small><strong className="num">{acc.under}品目</strong></div>
          <div className="metric"><small>ちょうどよい</small><strong className="num">{acc.ok}品目</strong></div>
          <div className="metric"><small>半分も売れず</small><strong className="num">{acc.over}品目</strong></div>
        </div>
        <p className="note">確定済みの{acc.events}回のイベントで、準備のときに目安が出ていた{acc.items}品目を数えています。</p>
        {acc.advice && <p className="warnnote">{acc.advice}</p>}
      </div>
    </>
  );
}
