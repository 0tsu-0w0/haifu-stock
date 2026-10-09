import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { EventNav } from '../components/EventNav';
import { PageHeader } from '../components/PageHeader';
import { eventReport, SLOT_MIN, type ReportSlot } from '../domain/report';
import { hhmm, yen } from '../lib/format';
import { useEventData } from './useEventData';

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

// イベント後のレポート(F-701〜703)
export function ReportPage() {
  const { eventId = '' } = useParams();
  const data = useEventData(eventId);
  const r = useMemo(() => (data ? eventReport(data) : null), [data]);

  if (data === undefined) return <main className="page" />;
  if (data === null || !r) return <main className="page"><p>イベントが見つかりません。</p><Link to="/">ホームに戻る</Link></main>;

  return (
    <>
      <main className="page">
        <PageHeader title="レポート" sub={`${data.event.name}・${data.event.held_on}`} />
        {!data.closing && <p className="note">終了処理の前なので、途中経過です。</p>}

        <div className="metrics">
          <div className="metric"><small>売上</small><strong className="num">{yen(r.amount)}</strong></div>
          <div className="metric"><small>販売部数</small><strong className="num">{r.qty}部</strong></div>
          <div className="metric"><small>取引件数</small><strong className="num">{r.txnCount}件</strong></div>
          <div className="metric"><small>客単価</small><strong className="num">{r.perCustomer === null ? '—' : yen(r.perCustomer)}</strong></div>
        </div>
        {r.discount > 0 && <p className="note">値引きの合計 {yen(r.discount)}(売上は値引き後の金額です)</p>}

        <h3 className="section">時間帯ごとの売上({SLOT_MIN}分ごと)</h3>
        {r.slots.length === 0 ? <div className="card"><p className="note">まだ販売の記録がありません。</p></div> : <SlotChart slots={r.slots} soldOuts={r.soldOuts} />}

        <h3 className="section">品目ごと</h3>
        <div className="card table-scroll">
          <table className="tbl small report-tbl">
            <thead>
              <tr><th>品目</th><th>持込</th><th>販売</th><th>無償</th><th>残</th><th>消化率</th><th>完売</th></tr>
            </thead>
            <tbody>
              {r.rows.map((x) => (
                <tr key={x.itemId}>
                  <td>{x.name}{x.ownerName && <span className="ctag">{x.ownerName}</span>}</td>
                  <td className="num">{x.brought ?? '—'}</td>
                  <td className="num">{x.sold}</td>
                  <td className="num">{x.isSet ? '—' : x.given}</td>
                  <td className="num">{x.remaining ?? '—'}</td>
                  <td className="num">{pct(x.sellThrough)}</td>
                  <td className="num">{x.soldOutAt ? hhmm(x.soldOutAt) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">販売の部数には、セットで売れた分も含みます。セットの行は、セットとして売れた数です。消化率は 販売 ÷ 持ち込み です。</p>
        <Link className="sub-link" to={`/analysis?tab=event&event=${eventId}`}>このイベントの損益分岐のグラフを見る</Link>
      </main>
      <EventNav eventId={eventId} current="report" />
    </>
  );
}

const W = 340;
const H = 200;
const PAD = { l: 48, r: 8, t: 12, b: 28 };

function niceMax(v: number) {
  if (v <= 0) return 1000;
  const mag = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= v) ?? v);
}

/** 30分ごとの売上の棒グラフ。完売した時刻を点線で重ねる。棒をなぞる・押すと、その枠の数字を出す */
function SlotChart({ slots, soldOuts }: { slots: ReportSlot[]; soldOuts: { name: string; at: string }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(...slots.map((s) => s.amount)));
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const bw = iw / slots.length;
  const t0 = Date.parse(slots[0].start);
  const span = slots.length * SLOT_MIN * 60_000;
  const x = (iso: string) => PAD.l + ((Date.parse(iso) - t0) / span) * iw;
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(slots.length / 6);
  const h = hover !== null ? slots[hover] : null;

  return (
    <figure className="chart">
      <figcaption className="chart-title">売上(円)</figcaption>
      <div className="chart-box">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="30分ごとの売上の棒グラフ" onPointerLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? 'axis-zero' : 'grid'} x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
              <text className="tick" x={PAD.l - 6} y={y(t) + 3} textAnchor="end">{Math.round(t).toLocaleString('ja-JP')}</text>
            </g>
          ))}
          {slots.map((s, i) => {
            const bx = PAD.l + i * bw + 1;
            const w = Math.max(1, bw - 2);
            const top = y(s.amount);
            const r = Math.min(4, w / 2, PAD.t + ih - top);
            return (
              <g key={s.start}>
                {s.amount > 0 && (
                  <path
                    className={`bar${hover === i ? ' on' : ''}`}
                    d={`M${bx},${PAD.t + ih} V${top + r} Q${bx},${top} ${bx + r},${top} H${bx + w - r} Q${bx + w},${top} ${bx + w},${top + r} V${PAD.t + ih} Z`}
                  />
                )}
                {i % labelEvery === 0 && <text className="tick" x={bx + w / 2} y={H - 10} textAnchor="middle">{hhmm(s.start)}</text>}
                <rect x={PAD.l + i * bw} y={PAD.t} width={bw} height={ih} fill="transparent" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} />
              </g>
            );
          })}
          {soldOuts.map((s) => (
            <line key={s.name + s.at} className="vline" x1={x(s.at)} x2={x(s.at)} y1={PAD.t} y2={PAD.t + ih} />
          ))}
        </svg>
        {h && (
          <div className="chart-tip" style={{ left: `${((PAD.l + (hover! + 0.5) * bw) / W) * 100}%` }}>
            <div><span>{hhmm(h.start)}〜</span></div>
            <div><span>売上</span><b className="num">{yen(h.amount)}</b></div>
            <div><span>部数</span><b className="num">{h.qty}</b></div>
            <div><span>取引</span><b className="num">{h.txns}件</b></div>
          </div>
        )}
      </div>
      {soldOuts.length > 0 && (
        <p className="note sold-outs">点線は完売の時刻: {soldOuts.map((s) => `${s.name} ${hhmm(s.at)}`).join('、')}</p>
      )}
      <details className="slot-table">
        <summary>表で見る</summary>
        <table className="tbl small">
          <thead><tr><th>時刻</th><th>売上</th><th>部数</th><th>取引</th></tr></thead>
          <tbody>
            {slots.map((s) => (
              <tr key={s.start}><td>{hhmm(s.start)}〜</td><td className="num">{yen(s.amount)}</td><td className="num">{s.qty}</td><td className="num">{s.txns}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
