import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../app/db';
import { useHasConsignors } from '../app/useConsign';
import { byType, byVenue, loadComparison, type CompareRow } from '../domain/compare';
import { yen } from '../lib/format';
import { ChartSave } from './ChartSave';

type Metric = 'amount' | 'perHour' | 'profit' | 'perCustomer';
const METRICS: [Metric, string][] = [['amount', '売上'], ['perHour', '1時間あたり'], ['profit', '収支'], ['perCustomer', '客単価']];

const man = (n: number) => (Math.abs(n) >= 10000 ? `${Math.round(n / 1000) / 10}万` : Math.round(n).toLocaleString('ja-JP'));
const sign = (n: number) => `${n >= 0 ? '+' : ''}${yen(n)}`;

/** 分析の「イベントの比較」(Issue #13) */
export function EventCompare({ circleId }: { circleId: string }) {
  const rows = useLiveQuery(() => loadComparison(db, circleId), [circleId]);
  const consign = useHasConsignors(circleId);
  const [metric, setMetric] = useState<Metric>('amount');
  if (!rows) return <p className="note">計算しています…</p>;
  if (rows.length === 0) return <div className="card"><p className="note">販売を記録したイベントがまだありません。</p></div>;
  const venues = byVenue(rows);
  const types = byType(rows);
  const label = METRICS.find(([k]) => k === metric)![1];

  return (
    <>
      <div className="chips" role="radiogroup" aria-label="比べる値">
        {METRICS.map(([k, l]) => (
          <button key={k} className="chip" role="radio" aria-checked={metric === k} aria-pressed={metric === k} onClick={() => setMetric(k)}>{l}</button>
        ))}
      </div>
      <CompareBars rows={rows} metric={metric} label={label} />

      <h3 className="section">イベントごと</h3>
      <div className="card table-scroll">
        <table className="tbl small report-tbl compare-tbl">
          <thead>
            <tr><th>イベント</th><th>売上</th><th>部数</th><th>取引</th><th>客単価</th><th>販売時間</th><th>1時間あたり</th><th>経費</th><th>収支</th></tr>
          </thead>
          <tbody>
            {[...rows].reverse().map((r) => (
              <tr key={r.eventId}>
                <td>
                  <Link to={`/events/${r.eventId}/report`}>{r.name}</Link>
                  <small className="k">{r.heldOn}{r.type ? `・${r.type}` : ''}{r.venue ? `・${r.venue}` : ''}{r.closed ? '' : '・途中'}</small>
                </td>
                <td className="num">{yen(r.amount)}</td>
                <td className="num">{r.qty}</td>
                <td className="num">{r.txns}</td>
                <td className="num">{r.perCustomer === null ? '—' : yen(r.perCustomer)}</td>
                <td className="num">{r.minutes === null ? '—' : `${Math.floor(r.minutes / 60)}:${String(r.minutes % 60).padStart(2, '0')}`}</td>
                <td className="num">{r.perHour === null ? '—' : yen(r.perHour)}</td>
                <td className="num">{yen(r.expenses)}</td>
                <td className={`num ${r.profit >= 0 ? 'pos' : 'neg-num'}`}>{sign(r.profit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">
        {consign ? '売上と1時間あたりは、受託分も含む全体の値です。収支は 自分の分の売上 − 原価 + 受託手数料 − 経費 です。' : '収支は 売上 − 原価 − 経費 です。'}
        販売時間は、開始時刻(なければ最初の販売)から最後の販売までで、休憩・離席を除きます。終了処理を済ませたイベントは、いまの品目の持ち主で計算し直した値です。
      </p>

      {venues.length > 0 && (
        <>
          <h3 className="section">会場ごとの平均</h3>
          <div className="card table-scroll">
            <table className="tbl small report-tbl">
              <thead><tr><th>会場</th><th>回数</th><th>売上</th><th>1時間あたり</th><th>収支</th></tr></thead>
              <tbody>
                {venues.map((v) => (
                  <tr key={v.venue}>
                    <td>{v.venue}</td>
                    <td className="num">{v.count}回</td>
                    <td className="num">{yen(v.avgAmount)}</td>
                    <td className="num">{v.avgPerHour === null ? '—' : yen(v.avgPerHour)}</td>
                    <td className={`num ${v.avgProfit >= 0 ? 'pos' : 'neg-num'}`}>{sign(v.avgProfit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">準備画面で会場を入れたイベントのうち、2回以上出た会場だけをまとめています。</p>
        </>
      )}

      {types.length > 0 && (
        <>
          <h3 className="section">種別ごとの平均</h3>
          <div className="card table-scroll">
            <table className="tbl small report-tbl">
              <thead><tr><th>種別</th><th>回数</th><th>売上</th><th>1時間あたり</th><th>収支</th></tr></thead>
              <tbody>
                {types.map((v) => (
                  <tr key={v.type}>
                    <td>{v.type}</td>
                    <td className="num">{v.count}回</td>
                    <td className="num">{yen(v.avgAmount)}</td>
                    <td className="num">{v.avgPerHour === null ? '—' : yen(v.avgPerHour)}</td>
                    <td className={`num ${v.avgProfit >= 0 ? 'pos' : 'neg-num'}`}>{sign(v.avgProfit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">準備画面で種別を入れたイベントのうち、2回以上ある種別だけをまとめています。</p>
        </>
      )}
    </>
  );
}

const W = 340;
const ROW = 26;
const PAD = { l: 112, r: 52, t: 8, b: 8 };

/** 横向きの棒グラフ。上が古いイベント。値が負なら0の線より左に伸ばす */
function CompareBars({ rows, metric, label }: { rows: CompareRow[]; metric: Metric; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const vals = rows.map((r) => r[metric]);
  const nums = vals.filter((v): v is number => v !== null);
  const lo = Math.min(0, ...nums);
  const hi = Math.max(0, ...nums, 1);
  const H = PAD.t + PAD.b + rows.length * ROW;
  const iw = W - PAD.l - PAD.r;
  const x = (v: number) => PAD.l + ((v - lo) / (hi - lo)) * iw;
  const short = (s: string) => (s.length > 9 ? `${s.slice(0, 8)}…` : s);
  const h = hover !== null ? rows[hover] : null;
  return (
    <figure className="chart">
      <figcaption className="chart-head"><span className="chart-title">イベントごとの{label}(円)</span><ChartSave name={`イベントごとの${label}`} /></figcaption>
      <div className="chart-box">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`イベントごとの${label}の棒グラフ`} onPointerLeave={() => setHover(null)}>
          <line className="axis-zero" x1={x(0)} x2={x(0)} y1={PAD.t} y2={H - PAD.b} />
          {rows.map((r, i) => {
            const v = vals[i];
            const y = PAD.t + i * ROW;
            const x0 = x(Math.min(0, v ?? 0));
            const w = v === null ? 0 : Math.max(Math.abs(x(v) - x(0)), v === 0 ? 0 : 1);
            return (
              <g key={r.eventId}>
                <text className="tick" x={PAD.l - 6} y={y + ROW / 2} textAnchor="end" dominantBaseline="middle">{short(r.name)}</text>
                {v !== null && (
                  <rect className={`bar${hover === i ? ' on' : ''}`} x={x0} y={y + 5} width={w} height={ROW - 10} rx={3} style={v < 0 ? { fill: 'var(--series-2)' } : undefined} />
                )}
                <text className="tick" x={(v ?? 0) < 0 ? x(0) + 4 : (v === null ? x(0) : x(v)) + 4} y={y + ROW / 2} dominantBaseline="middle">{v === null ? '—' : man(v)}</text>
                <rect x={0} y={y} width={W} height={ROW} fill="transparent" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} />
              </g>
            );
          })}
        </svg>
        {h && (
          <div className="chart-tip" style={{ left: '50%' }}>
            <div><span>{h.name}</span></div>
            <div><span>{h.heldOn}</span></div>
            <div><span>{label}</span><b className="num">{h[metric] === null ? '—' : metric === 'profit' ? sign(h[metric]!) : yen(h[metric]!)}</b></div>
          </div>
        )}
      </div>
      {metric === 'profit' && <p className="note sold-outs">赤字のイベントは、0の線より左に伸びる色違いの棒です。</p>}
    </figure>
  );
}
