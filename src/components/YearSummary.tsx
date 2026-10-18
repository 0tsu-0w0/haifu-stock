import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../app/db';
import { useHasConsignors } from '../app/useConsign';
import { loadYearSummary, yearCsv, yearsWithData } from '../domain/yearly';
import { downloadText, fileStamp } from '../lib/download';
import { yen } from '../lib/format';

type View = 'printing' | 'cost';

/** 確定申告用の年間の集計(Issue #38) */
export function YearSummaryView({ circleId }: { circleId: string }) {
  const years = useLiveQuery(() => yearsWithData(db, circleId), [circleId]);
  const [picked, setPicked] = useState<number | null>(null);
  const year = picked ?? years?.[0] ?? new Date().getFullYear();
  const y = useLiveQuery(() => loadYearSummary(db, circleId, year), [circleId, year]);
  const [view, setView] = useState<View>('printing');
  const consign = useHasConsignors(circleId);

  if (!years || !y) return <p className="note">計算しています…</p>;
  const t = y.totals;
  const net = view === 'printing' ? y.net.byPrinting : y.net.byCost;
  const sign = (n: number) => `${n >= 0 ? '+' : '−'}${yen(Math.abs(n))}`;

  return (
    <>
      <div className="year-bar">
        <label className="k" htmlFor="year-pick">年</label>
        <select id="year-pick" value={year} onChange={(e) => setPicked(Number(e.target.value))}>
          {years.map((v) => <option key={v} value={v}>{v}年(1〜12月)</option>)}
        </select>
        <button className="sbtn acc" onClick={() => downloadText(`haifu-${year}年の集計-${fileStamp()}.csv`, yearCsv(y), 'text/csv')}>CSVで書き出す</button>
      </div>

      <div className="metrics">
        <div className="metric"><small>収入</small><strong className="num">{yen(t.own + t.fee)}</strong></div>
        <div className="metric"><small>費用</small><strong className="num">{yen(t.expenses + (view === 'printing' ? t.printing + t.production : t.cost))}</strong></div>
        <div className="metric"><small>差し引き</small><strong className={`num ${net >= 0 ? 'pos' : 'neg-num'}`}>{sign(net)}</strong></div>
      </div>

      <div className="chips" role="radiogroup" aria-label="印刷費の数え方">
        <button className="chip" role="radio" aria-checked={view === 'printing'} aria-pressed={view === 'printing'} onClick={() => setView('printing')}>印刷費は刷った年</button>
        <button className="chip" role="radio" aria-checked={view === 'cost'} aria-pressed={view === 'cost'} onClick={() => setView('cost')}>売れた分だけ原価</button>
      </div>
      <p className="note">
        {view === 'printing'
          ? 'この年に刷った印刷費と、この年に初版を刷った品目の制作費を、この年の費用にしています。'
          : '印刷費は、この年に売れた部数の分だけを原価にしています(制作費は含みません)。売れ残りは在庫として残ります。'}
      </p>

      <h3 className="section">収入</h3>
      <div className="card table-scroll">
        <table className="tbl small report-tbl">
          <tbody>
            <tr><td>{consign ? '自分の分の売上' : '売上'}</td><td className="num">{yen(t.own)}</td></tr>
            {consign && <tr><td>受託手数料</td><td className="num">{yen(t.fee)}</td></tr>}
            {consign && <tr className="muted-row"><td>受託分の売上(受託元のもの・収入に含めない)</td><td className="num">{yen(t.consigned)}</td></tr>}
            {t.cashless > 0 && <tr className="muted-row"><td>うちキャッシュレスで受け取った分</td><td className="num">{yen(t.cashless)}</td></tr>}
          </tbody>
        </table>
      </div>

      <h3 className="section">費用</h3>
      <div className="card table-scroll">
        <table className="tbl small report-tbl">
          <tbody>
            {y.expensesByCategory.map((c) => <tr key={c.category}><td>{c.label}</td><td className="num">{yen(c.amount)}</td></tr>)}
            {y.expensesByCategory.length === 0 && <tr><td>経費</td><td className="num">{yen(0)}</td></tr>}
            {view === 'printing' ? (
              <>
                <tr><td>印刷費(この年に刷った分)</td><td className="num">{yen(t.printing)}</td></tr>
                <tr><td>制作費(この年に初版を刷った品目)</td><td className="num">{yen(t.production)}</td></tr>
              </>
            ) : (
              <tr><td>売れた分の印刷費(原価)</td><td className="num">{yen(t.cost)}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {view === 'printing' && y.printRuns.length > 0 && (
        <details>
          <summary>この年の刷り記録({y.printRuns.length}件)</summary>
          <ul className="cands">
            {y.printRuns.map((r, i) => (
              <li key={i}>{r.printedOn} {r.itemName}・{r.edition === 1 ? '初版' : `第${r.edition}版`}・{r.qty}部 {yen(r.cost)}</li>
            ))}
          </ul>
        </details>
      )}
      {(y.undated.printRuns.length > 0 || y.undated.production.length > 0) && (
        <p className="warnnote">
          刷った日のない刷り記録が{y.undated.printRuns.length}件{y.undated.production.length ? `、年の分からない制作費が${y.undated.production.length}件` : ''}あり、どの年にも入れていません。
          品目の画面で刷った日を入れると、その年に入ります。
        </p>
      )}

      <h3 className="section">月ごと(開催日の月)</h3>
      <div className="card table-scroll">
        <table className="tbl small report-tbl">
          <thead><tr><th>月</th><th>売上</th>{consign && <th>手数料</th>}<th>経費</th></tr></thead>
          <tbody>
            {y.months.filter((m) => m.own || m.fee || m.expenses).map((m) => (
              <tr key={m.month}>
                <td>{m.month}月</td>
                <td className="num">{yen(m.own)}</td>
                {consign && <td className="num">{yen(m.fee)}</td>}
                <td className="num">{yen(m.expenses)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {y.events.length === 0 && <p className="note">この年のイベントはありません。</p>}
      </div>

      {y.events.length > 0 && (
        <>
          <h3 className="section">イベントごと</h3>
          <div className="card table-scroll">
            <table className="tbl small report-tbl">
              <thead><tr><th>イベント</th><th>売上</th>{consign && <th>手数料</th>}<th>経費</th></tr></thead>
              <tbody>
                {y.events.map((e) => (
                  <tr key={e.eventId}>
                    <td><Link to={`/events/${e.eventId}/report`}>{e.name}</Link><small className="k">{e.heldOn}{e.closed ? '' : '・途中'}</small></td>
                    <td className="num">{yen(e.own)}</td>
                    {consign && <td className="num">{yen(e.fee)}</td>}
                    <td className="num">{yen(e.expenses)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="note">
        確定申告の目安としての集計です。どの費用をどの年に入れるか(在庫の扱い・按分など)は人によって違うので、申告のしかたは税務署や税理士の案内で確かめてください。
        経費は実際の金額(なければ予定の金額)で数えています。
      </p>
    </>
  );
}
