import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { db } from '../app/db';
import { usePref } from '../app/prefs';
import type { Item } from '../db/types';
import { DEFAULT_FORECAST, SCENARIO_LABEL, loadAnalysis, type ScenarioKey } from '../domain/analysis';
import { deletePriceTier, priceTiers, savePriceTier, setPrintLot } from '../domain/catalog';
import type { Ctx } from '../domain/record';
import { simulateItem, tierCost } from '../domain/simulation';
import { yen } from '../lib/format';
import { LineChart } from './LineChart';
import { useToast } from './Toast';

const man = (n: number) => (Math.abs(n) >= 10000 ? `${Math.round(n / 1000) / 10}万` : Math.round(n).toLocaleString('ja-JP'));
const LINE_STYLE: Record<ScenarioKey, { color: string; dashed?: boolean }> = {
  conservative: { color: 'var(--series-2)', dashed: true },
  standard: { color: 'var(--series-1)' },
  aggressive: { color: 'var(--ink-3)', dashed: true },
};

/**
 * 品目の画面の「印刷所の価格表と刷り部数」(F-106、F-108、F-1105)。
 * 部数の刻みと価格表を入れると、刷り部数ごとの予想利益を3案で描く。
 * 次に刷るかを考えるときにしか使わないので、最初はたたんでおく(Issue #23)。
 * 分析のデータは重いので、開いているときだけ読む。分析の画面から来たとき(?plan=1)は開いて見せる
 */
export function PrintPlan({ item, ctx }: { item: Item; ctx: Ctx }) {
  const toast = useToast();
  const [params] = useSearchParams();
  const fromAnalysis = params.get('plan') === '1';
  const [savedOpen, setSavedOpen] = usePref('printPlanOpen');
  const [open, setOpen] = useState(savedOpen || fromAnalysis);
  const head = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (fromAnalysis) head.current?.scrollIntoView({ block: 'start' });
  }, [fromAnalysis]);
  const tiers = useLiveQuery(() => priceTiers(db, item.id), [item.id]) ?? [];
  const data = useLiveQuery(() => (open ? loadAnalysis(db, ctx.circleId, DEFAULT_FORECAST) : undefined), [open, ctx.circleId]);
  const [lot, setLot] = useState(item.print_lot ? String(item.print_lot) : '');
  const [row, setRow] = useState({ qty: '', cost: '' });
  const result = data && tiers.length > 0 ? simulateItem(data, item, tiers, DEFAULT_FORECAST) : null;

  const run = async (p: Promise<unknown>, ok: string) => {
    try {
      await p;
      toast(ok);
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const toggle = () => {
    setOpen(!open);
    setSavedOpen(!open);
  };
  const summary = tiers.length > 0 || item.print_lot
    ? [tiers.length > 0 && `価格表 ${tiers.length}行`, item.print_lot && `刻み ${item.print_lot}部`].filter(Boolean).join('・')
    : 'まだ入れていません';

  return (
    <>
      <h3 className="section">印刷所の価格表と刷り部数</h3>
      <button ref={head} type="button" className="card row-link wide fold" aria-expanded={open} aria-controls="print-plan-body" onClick={toggle}>
        <span>
          <b>{summary}</b>
          <small>部数の刻み・価格表・刷り部数ごとの予想利益</small>
        </span>
        <span className="fold-mark">{open ? 'たたむ ▴' : '開く ▾'}</span>
      </button>
      {open && <div id="print-plan-body" className="fold-body">
      <div className="card form">
        <label htmlFor="print-lot">部数の刻み(印刷所で頼める単位)</label>
        <div className="copy-row">
          <input id="print-lot" inputMode="numeric" value={lot} placeholder="50" onChange={(e) => setLot(e.target.value.replace(/\D/g, ''))} />
          <button
            type="button" className="sbtn acc" disabled={(lot === '' ? null : Number(lot)) === (item.print_lot ?? null)}
            onClick={() => void run(setPrintLot(db, item.id, lot === '' ? null : Number(lot)), '部数の刻みを保存しました')}
          >保存</button>
        </div>
        <small className="k">刷り部数の目安とシミュレーションを、この単位に切り上げます。空にすると1部単位です。</small>

        <span className="label-like">価格表(部数ごとの総額)</span>
        {tiers.length === 0 && <small className="k">まだありません。印刷所の見積もりの「50部 18,000円」のような行を入れてください。間の部数は、前後の値から直線で求めます。</small>}
        {tiers.length > 0 && (
          <table className="tbl small tier-tbl">
            <thead><tr><th>部数</th><th>総額</th><th>1部あたり</th><th /></tr></thead>
            <tbody>
              {tiers.map((t) => (
                <tr key={t.id}>
                  <td className="num">{t.qty}部</td>
                  <td className="num">{yen(t.total_cost)}</td>
                  <td className="num">{yen(Math.round(t.total_cost / t.qty))}</td>
                  <td><button type="button" className="link-btn" aria-label={`${t.qty}部の行を消す`} onClick={() => void run(deletePriceTier(db, t.id), `${t.qty}部の行を消しました`)}>消す</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="tier-add">
          <input inputMode="numeric" aria-label="部数" placeholder="部数 100" value={row.qty} onChange={(e) => setRow({ ...row, qty: e.target.value.replace(/\D/g, '') })} />
          <input inputMode="numeric" aria-label="総額(円)" placeholder="総額 24000" value={row.cost} onChange={(e) => setRow({ ...row, cost: e.target.value.replace(/\D/g, '') })} />
          <button
            type="button" className="sbtn" disabled={!row.qty || !row.cost}
            onClick={async () => {
              const ok = await run(savePriceTier(db, ctx, { itemId: item.id, qty: Number(row.qty), totalCost: Number(row.cost) }), `${row.qty}部の値段を保存しました`);
              if (ok) setRow({ qty: '', cost: '' });
            }}
          >追加</button>
        </div>
        <small className="k">同じ部数を入れると、その行を上書きします。</small>
      </div>

      {tiers.length > 0 && data && !result && (
        <div className="card"><p className="note">需要の見込みがまだないため、シミュレーションを出せません。この品目を売ったイベントで終了処理をすると(本なら、ほかの新刊を売った実績があっても)出ます。</p></div>
      )}
      {open && tiers.length > 0 && data === undefined && <p className="note">計算しています…</p>}
      {result && <SimulationChart item={item} result={result} tiers={tiers} />}
      </div>}
    </>
  );
}

function SimulationChart({ item, result, tiers }: { item: Item; result: NonNullable<ReturnType<typeof simulateItem>>; tiers: { qty: number; total_cost: number }[] }) {
  const { sim } = result;
  const std = sim.lines.find((l) => l.key === 'standard')!;
  const values = sim.lines.flatMap((l) => [0, ...sim.breaks, sim.xMax].map((q) => l.profit(q)));
  const yMin = Math.min(0, ...values);
  const yMax = Math.max(1000, ...values);
  const pad = (yMax - yMin) * 0.08;
  const worth = !!sim.best && sim.best.profit > 0;
  return (
    <div className="card">
      {worth ? (
        <div className="metrics">
          <div className="metric">
            <small>利益がいちばん大きい部数(標準)</small>
            <strong className="num">{sim.best!.q}部</strong>
          </div>
          <div className="metric">
            <small>そのときの利益</small>
            <strong className="num pos">+{yen(sim.best!.profit)}</strong>
          </div>
        </div>
      ) : (
        <p className="lead">
          標準の見込みでは、どの部数を刷っても利益が出ません。
          {result.basis === 'reprint' && std.demand === 0 ? `いまの在庫 ${result.stock}部で足りる見込みです。` : '見込みの部数に対して、印刷費が高すぎます。'}
        </p>
      )}
      <LineChart
        title={`${item.name} の刷り部数と予想利益`}
        xMax={sim.xMax}
        yMin={yMin - pad}
        yMax={yMax + pad}
        xLabel="刷り部数"
        formatX={(x) => `${Math.round(x)}`}
        formatY={(y) => man(y)}
        series={sim.lines.map((l) => ({
          key: l.key, label: SCENARIO_LABEL[l.key], color: LINE_STYLE[l.key].color, dashed: LINE_STYLE[l.key].dashed,
          y: l.profit, breaks: sim.breaks,
        }))}
        markers={sim.best && sim.best.profit > 0 ? [{ kind: 'point', x: sim.best.q, y: std.profit(sim.best.q), label: `${sim.best.q}部` }] : []}
        tooltip={(x) => [
          ['刷り部数', `${x}部`],
          ['印刷費', yen(Math.round(tierCost(tiers, x) ?? 0))],
          ...sim.lines.map((l): [string, string] => [SCENARIO_LABEL[l.key], `${l.profit(x) >= 0 ? '+' : ''}${yen(Math.round(l.profit(x)))}`]),
        ]}
      />
      <p className="note">
        {sim.lossRanges.length === 0
          ? '調べた範囲では、どの案でも赤字になりません。'
          : `どれかの案で赤字になる部数: ${sim.lossRanges.map(([a, b]) => (a === b ? `${a}部` : `${a}〜${b}部`)).join('、')}`}
      </p>
      <details>
        <summary>計算のしかた</summary>
        <ul className="cands">
          <li>予想利益 = 価格 {yen(item.price)} × min(刷り部数, 見込み) − 印刷費{result.fixed > 0 ? ` − 制作費 ${yen(result.fixed)}` : ''}</li>
          <li>
            見込み({sim.lines.map((l) => `${SCENARIO_LABEL[l.key]} ${Math.round(l.demand)}部`).join(' / ')}):
            {result.basis === 'reprint'
              ? ` 再版の目安の需要から、いまの在庫 ${result.stock}部を引いた部数です。`
              : ' まだ売っていない本なので、次の新刊の目安(過去の新刊の初回の需要)を使います。'}
            {result.reference && '材料が少ないので参考値です。'}
          </li>
          <li>印刷費は価格表から求めます。いちばん少ない部数より少なく刷っても、その部数の値段がかかるものとします。いちばん多い部数より上は、最後の区間の傾きで延ばします。</li>
          <li>{sim.step}部ごとに調べています{item.print_lot ? '(部数の刻み)' : ''}。</li>
        </ul>
      </details>
    </div>
  );
}
