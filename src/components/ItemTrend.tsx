import { useMemo, useState } from 'react';
import type { AnalysisData } from '../domain/analysis';
import { decayByAppearance, itemTrend, type TrendRow } from '../domain/trend';
import { ChartSave } from './ChartSave';

// 分析の「推移」(F-705)。頒布物ごとに、イベントをまたいだ販売の推移と、新刊から既刊になったあとの落ち方を出す

const pct = (r: number) => `${Math.round(r * 100)}%`;

export function ItemTrendView({ data, selected, onSelect }: { data: AnalysisData; selected: string | null; onSelect: (id: string) => void }) {
  // 2回以上出したものを先に、初めて出した日の新しい順
  const list = useMemo(() => [...data.histories.values()]
    .filter((h) => h.observations.length > 0 && !h.item.deleted_at)
    .sort((a, b) => Number(b.observations.length > 1) - Number(a.observations.length > 1)
      || b.observations[0].heldOn.localeCompare(a.observations[0].heldOn)), [data]);
  const decay = useMemo(() => decayByAppearance(data.histories.values()), [data]);
  const h = list.find((x) => x.item.id === selected) ?? list[0];
  if (!h) return <div className="card"><p className="note">終了したイベントの記録がたまると、頒布物ごとの売れ方の推移を出します。</p></div>;
  const rows = itemTrend(h);
  const last = rows[rows.length - 1];

  return (
    <>
      <label className="label-like" htmlFor="trend-item">頒布物</label>
      <select id="trend-item" value={h.item.id} onChange={(e) => onSelect(e.target.value)}>
        {list.map((x) => <option key={x.item.id} value={x.item.id}>{x.item.name}({x.observations.length}回)</option>)}
      </select>

      <TrendBars rows={rows} name={h.item.name} />
      {rows.length > 1 && last.vsFirst !== null && (
        <p className="note">
          初めて出した{rows[0].eventName}から{rows.length - 1}回あと、1日あたりの需要は初回の{pct(last.vsFirst)}です。
        </p>
      )}

      <div className="card table-scroll">
        <table className="tbl small report-tbl">
          <thead><tr><th>イベント</th><th>回</th><th>持ち込み</th><th>販売</th><th>消化率</th><th>需要</th><th>初回比</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.eventId}>
                <td>{r.eventName}<br /><small className="k">{r.heldOn}{r.days > 1 ? `・${r.days}日` : ''}</small></td>
                <td className="num">{r.nth}</td>
                <td className="num">{r.brought}</td>
                <td className="num">{r.sold}</td>
                <td className="num">{pct(r.sellThrough)}</td>
                <td className="num">{r.corrected ? `${Math.round(r.demand)}*` : Math.round(r.demand)}</td>
                <td className="num">{r.vsFirst === null ? '—' : pct(r.vsFirst)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">需要の * は、完売したので、売れ方から完売しなかったときの部数を見積もった値です。初回比は1日あたりの需要で比べます。</p>

      <h3 className="section">既刊になってからの落ち方</h3>
      {decay.length === 0 ? (
        <div className="card"><p className="note">2回以上出した頒布物があると、初回に比べてどれだけ売れるかをまとめます。</p></div>
      ) : (
        <>
          <div className="card table-scroll">
            <table className="tbl small report-tbl">
              <thead><tr><th>何回目</th><th>初回比(中央値)</th><th>頒布物の数</th></tr></thead>
              <tbody>
                {decay.map((d) => (
                  <tr key={d.nth}>
                    <td>{d.nth}回目</td>
                    <td className="num">{pct(d.ratio)}</td>
                    <td className="num">{d.samples}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">自分の頒布物すべてについて、n回目に出したイベントの1日あたりの需要を、初めて出したイベントと比べた中央値です。数が少ない回は、当てにしすぎないでください。</p>
        </>
      )}
    </>
  );
}

const W = 340;
const ROW = 30;
const PAD = { l: 112, r: 44, t: 8, b: 8 };

/** 横向きの棒グラフ。上が古いイベント。棒が販売数、細い線が持ち込み数 */
function TrendBars({ rows, name }: { rows: TrendRow[]; name: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const hi = Math.max(1, ...rows.map((r) => Math.max(r.brought, r.demand)));
  const H = PAD.t + PAD.b + rows.length * ROW;
  const x = (v: number) => PAD.l + (v / hi) * (W - PAD.l - PAD.r);
  const short = (s: string) => (s.length > 9 ? `${s.slice(0, 8)}…` : s);
  const h = hover !== null ? rows[hover] : null;
  return (
    <figure className="chart">
      <figcaption className="chart-head"><span className="chart-title">{name}の販売数(部)</span><ChartSave name={`${name}の推移`} /></figcaption>
      <div className="chart-box">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${name}のイベントごとの販売数の棒グラフ`} onPointerLeave={() => setHover(null)}>
          <line className="axis-zero" x1={x(0)} x2={x(0)} y1={PAD.t} y2={H - PAD.b} />
          {rows.map((r, i) => {
            const y = PAD.t + i * ROW;
            return (
              <g key={r.eventId}>
                <text className="tick" x={PAD.l - 6} y={y + ROW / 2} textAnchor="end" dominantBaseline="middle">{short(r.eventName)}</text>
                <rect className={`bar${hover === i ? ' on' : ''}`} x={x(0)} y={y + 7} width={Math.max(x(r.sold) - x(0), r.sold ? 1 : 0)} height={ROW - 14} rx={3} />
                <line className="trend-bring" x1={x(r.brought)} x2={x(r.brought)} y1={y + 3} y2={y + ROW - 3} />
                <text className="tick" x={Math.max(x(r.sold), x(r.brought)) + 4} y={y + ROW / 2} dominantBaseline="middle">{r.sold}</text>
                <rect x={0} y={y} width={W} height={ROW} fill="transparent" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} />
              </g>
            );
          })}
        </svg>
        {h && (
          <div className="chart-tip" style={{ left: '50%' }}>
            <div><span>{h.eventName}</span></div>
            <div><span>{h.heldOn}・{h.nth}回目</span></div>
            <div><span>販売 / 持ち込み</span><b className="num">{h.sold} / {h.brought}</b></div>
          </div>
        )}
      </div>
      <p className="note sold-outs">棒が販売数、縦の線が持ち込み数です。棒が線に届いていれば完売です。</p>
    </figure>
  );
}
