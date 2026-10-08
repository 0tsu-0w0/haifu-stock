import { useRef, useState, type ReactNode } from 'react';

// 直線だけの折れ線グラフ(損益分岐用)。縦線の名前は、線の端の名前とぶつからないよう下に置く。縦軸は1本だけ。色は系列の役割で決め、文字は文字色のまま。
// 系列が2本以上なら凡例を出し、線の端にも名前を書く。なぞると、その位置の値を出す

export interface Series {
  key: string;
  label: string;
  /** CSS の色(トークン) */
  color: string;
  /** x を受け取って y を返す(直線なので両端だけ描けばよい) */
  y: (x: number) => number;
  dashed?: boolean;
}

export interface Marker {
  x: number;
  y?: number;
  label: string;
  kind: 'point' | 'vline';
}

const W = 340;
const H = 220;
const PAD = { l: 52, r: 14, t: 14, b: 34 };

function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

export function LineChart(props: {
  title: string;
  xMax: number;
  yMin?: number;
  yMax: number;
  series: Series[];
  markers?: Marker[];
  formatX: (x: number) => string;
  formatY: (y: number) => string;
  xLabel: string;
  /** なぞったときの表の行 */
  tooltip: (x: number) => [string, string][];
  children?: ReactNode;
}) {
  const { xMax, series, markers = [], formatX, formatY } = props;
  const yMin = props.yMin ?? 0;
  const yMax = props.yMax === yMin ? yMin + 1 : props.yMax;
  const sx = (x: number) => PAD.l + (x / xMax) * (W - PAD.l - PAD.r);
  const sy = (y: number) => PAD.t + (1 - (y - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
  const xTicks = niceTicks(xMax);
  const yTicks = [...niceTicks(Math.max(yMax, 0)), ...(yMin < 0 ? niceTicks(-yMin).slice(1).map((v) => -v) : [])].filter((v) => v >= yMin && v <= yMax);
  const svg = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const onMove = (clientX: number) => {
    const r = svg.current?.getBoundingClientRect();
    if (!r) return;
    const px = ((clientX - r.left) / r.width) * W;
    const x = ((px - PAD.l) / (W - PAD.l - PAD.r)) * xMax;
    setHover(x < 0 || x > xMax ? null : Math.round(x));
  };
  const clipY = (y: number) => Math.min(Math.max(y, yMin), yMax);

  return (
    <figure className="chart">
      <figcaption className="chart-title">{props.title}</figcaption>
      {series.length >= 2 && (
        <div className="legend" aria-hidden="true">
          {series.map((s) => (
            <span key={s.key}><i style={{ background: s.color }} className={s.dashed ? 'dashed' : ''} />{s.label}</span>
          ))}
        </div>
      )}
      <div className="chart-box">
        <svg
          ref={svg}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={props.title}
          onPointerMove={(e) => onMove(e.clientX)}
          onPointerDown={(e) => onMove(e.clientX)}
          onPointerLeave={() => setHover(null)}
        >
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line x1={PAD.l} x2={W - PAD.r} y1={sy(v)} y2={sy(v)} className={v === 0 ? 'axis-zero' : 'grid'} />
              <text x={PAD.l - 6} y={sy(v)} className="tick" textAnchor="end" dominantBaseline="middle">{formatY(v)}</text>
            </g>
          ))}
          {xTicks.map((v) => (
            <text key={`x${v}`} x={sx(v)} y={H - PAD.b + 14} className="tick" textAnchor="middle">{formatX(v)}</text>
          ))}
          <text x={(PAD.l + W - PAD.r) / 2} y={H - 4} className="tick axis-label" textAnchor="middle">{props.xLabel}</text>

          {markers.filter((m) => m.kind === 'vline').map((m) => (
            <g key={`v${m.label}`}>
              <line x1={sx(m.x)} x2={sx(m.x)} y1={PAD.t} y2={H - PAD.b} className="vline" />
              <text x={sx(m.x) + (sx(m.x) > W - 90 ? -4 : 4)} y={H - PAD.b - 6} className="mark-label" textAnchor={sx(m.x) > W - 90 ? 'end' : 'start'}>{m.label}</text>
            </g>
          ))}

          {series.map((s) => {
            const y0 = clipY(s.y(0));
            const y1 = clipY(s.y(xMax));
            return (
              <g key={s.key}>
                <line x1={sx(0)} y1={sy(y0)} x2={sx(xMax)} y2={sy(y1)} stroke={s.color} strokeWidth={2} strokeLinecap="round" strokeDasharray={s.dashed ? '6 4' : undefined} />
                {series.length >= 2 && (
                  <text x={sx(xMax) - 2} y={sy(y1) + (y1 > (yMax + yMin) / 2 ? 14 : -6)} className="series-label" textAnchor="end">{s.label}</text>
                )}
              </g>
            );
          })}

          {markers.filter((m) => m.kind === 'point').map((m) => (
            <g key={`p${m.label}`}>
              <circle cx={sx(m.x)} cy={sy(m.y ?? 0)} r={5} className="point" />
              <text x={sx(m.x) + (sx(m.x) > W - 110 ? -8 : 8)} y={sy(m.y ?? 0) + 18} className="mark-label strong" textAnchor={sx(m.x) > W - 110 ? 'end' : 'start'}>{m.label}</text>
            </g>
          ))}

          {hover !== null && (
            <g pointerEvents="none">
              <line x1={sx(hover)} x2={sx(hover)} y1={PAD.t} y2={H - PAD.b} className="crosshair" />
              {series.map((s) => <circle key={s.key} cx={sx(hover)} cy={sy(clipY(s.y(hover)))} r={4} fill={s.color} className="hover-dot" />)}
            </g>
          )}
          <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b} fill="transparent" />
        </svg>
        {hover !== null && (
          <div className="chart-tip" style={{ left: `${(sx(hover) / W) * 100}%` }}>
            {props.tooltip(hover).map(([k, v]) => <div key={k}><span>{k}</span><b className="num">{v}</b></div>)}
          </div>
        )}
      </div>
      {props.children}
    </figure>
  );
}
