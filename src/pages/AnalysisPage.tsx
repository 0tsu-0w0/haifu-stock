import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { db } from '../app/db';
import { useCtx } from '../app/useCtx';
import { LineChart } from '../components/LineChart';
import { PageHeader } from '../components/PageHeader';
import {
  DEFAULT_FORECAST, SCENARIO_LABEL, decayRates, editionsOf, eventBreakEven, itemBreakEven, loadAnalysis, newBookPlan, reprintPlans,
  type AnalysisData, type ForecastOptions, type ReprintPlan,
} from '../domain/analysis';
import { computeMoney, planCounts } from '../domain/closing';
import { loadEventSnapshot } from '../domain/snapshot';
import { hhmm, yen } from '../lib/format';

type Tab = 'forecast' | 'item' | 'event';
const TABS: [Tab, string][] = [['forecast', '刷り部数'], ['item', '頒布物の損益'], ['event', 'イベントの損益']];
const man = (n: number) => (Math.abs(n) >= 10000 ? `${Math.round(n / 1000) / 10}万` : n.toLocaleString('ja-JP'));

// 分析: 刷り部数の目安(F-801〜806)と損益分岐のグラフ(F-1101〜1103、F-1110)
export function AnalysisPage() {
  const ctx = useCtx();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'forecast';
  const [opts, setOpts] = useState<ForecastOptions>(DEFAULT_FORECAST);
  const data = useLiveQuery(() => (ctx ? loadAnalysis(db, ctx.circleId, opts) : undefined), [ctx?.circleId, opts.capFactor, opts.defaultHours]);

  return (
    <main className="page">
      <PageHeader title="分析" />
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className="tab" onClick={() => setParams({ tab: k }, { replace: true })}>{label}</button>
        ))}
      </div>
      {!data ? <p className="note">計算しています…</p>
        : tab === 'forecast' ? <Forecast data={data} opts={opts} setOpts={setOpts} />
        : tab === 'item' ? <ItemBreakEvens data={data} selected={params.get('item')} onSelect={(id) => setParams({ tab: 'item', item: id }, { replace: true })} />
        : <EventBreakEven data={data} selected={params.get('event')} onSelect={(id) => setParams({ tab: 'event', event: id }, { replace: true })} />}
    </main>
  );
}

function Forecast({ data, opts, setOpts }: { data: AnalysisData; opts: ForecastOptions; setOpts: (o: ForecastOptions) => void }) {
  const plans = useMemo(() => reprintPlans(data, opts), [data, opts]);
  const nb = useMemo(() => newBookPlan(data, opts), [data, opts]);
  const rates = useMemo(() => decayRates(data, opts), [data, opts]);
  const set = (patch: Partial<ForecastOptions>) => setOpts({ ...opts, ...patch });

  return (
    <>
      <div className="card form">
        <div className="two">
          <span>
            <label htmlFor="fc-events">何回先のイベントまで</label>
            <select id="fc-events" value={opts.plannedEvents} onChange={(e) => set({ plannedEvents: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}回</option>)}
            </select>
          </span>
          <span>
            <label htmlFor="fc-safety">安全率</label>
            <select id="fc-safety" value={opts.safety} onChange={(e) => set({ safety: Number(e.target.value) })}>
              {[0, 0.1, 0.2, 0.3].map((n) => <option key={n} value={n}>{Math.round(n * 100)}%増し</option>)}
            </select>
          </span>
        </div>
        <label htmlFor="fc-reserve">イベント以外で確保したい部数(通販用など)</label>
        <input id="fc-reserve" inputMode="numeric" value={opts.reserve || ''} placeholder="0" onChange={(e) => set({ reserve: Number(e.target.value.replace(/\D/g, '') || 0) })} />
      </div>

      {plans.length === 0 && !nb && (
        <div className="card">
          <p>まだ計算の材料がありません。</p>
          <p className="note">終了処理を確定したイベント(または開催日を過ぎたイベント)の販売記録から計算します。自分の品目を持ち込んだイベントが1回以上あると、目安が出ます。</p>
        </div>
      )}

      {plans.length > 0 && <h3 className="section">既刊の再版</h3>}
      {plans.map((p) => <ReprintCard key={p.item.id} plan={p} opts={opts} />)}

      {nb && (
        <>
          <h3 className="section">次の新刊</h3>
          <div className="card">
            <div className="rowx">
              <span className="k">期待度</span>
              <div className="chips">
                {([[0.7, '新ジャンル'], [1, '通常'], [1.1, '続編']] as const).map(([v, l]) => (
                  <button key={v} className="chip" aria-pressed={opts.expectation === v} onClick={() => set({ expectation: v })}>{l} ×{v}</button>
                ))}
              </div>
            </div>
            <div className="scen">
              {nb.scenarios.map((s) => (
                <div key={s.key} className={`scen-tile${s.key === 'standard' ? ' main' : ''}`}>
                  <small>{SCENARIO_LABEL[s.key]}</small>
                  <strong className="num">{s.print}部</strong>
                  <span className="k">初回 {s.firstEvent}部の見込み</span>
                </div>
              ))}
            </div>
            {nb.reference && <p className="badge-ref">参考値: 材料の新刊が1冊だけなので、幅を広く見てください</p>}
            <details>
              <summary>計算の根拠</summary>
              <table className="tbl small">
                <thead><tr><th>新刊</th><th>初回のイベント</th><th>需要</th><th>重み</th></tr></thead>
                <tbody>{nb.basis.map((b) => <tr key={b.item.id}><td>{b.item.name}</td><td>{b.eventName}</td><td className="num">{b.demand}</td><td className="num">{b.weight}</td></tr>)}</tbody>
              </table>
              <p className="note">控えめ = 最も少なかった新刊、標準 = 新しい順に 3:2:1 の加重平均、強気 = 最も多かった新刊。期待度を掛け、2回目以降は既刊の減衰率で減らして、{opts.plannedEvents}回分を合計しています。10部単位に切り上げ。</p>
            </details>
          </div>
        </>
      )}

      <details className="card method">
        <summary>計算のしかた</summary>
        <ul className="cands">
          <li>需要: 完売しなかったら販売数。完売したら、完売した時刻までに売れる割合 F(t) で割って補正します(上限は販売数の{opts.capFactor}倍)。</li>
          <li>F(t): {data.curveSource === 'data'
            ? `完売しなかった品目の販売 ${data.curveSamples}部から作りました。`
            : `販売の実績がまだ少ないため(${data.curveSamples}部)、既定の曲線(開始1時間で約4割、2時間で約6.5割、3時間で約8割)を使っています。`}
            開催時間は、開始時刻から{opts.defaultHours}時間とみなします。</li>
          <li>既刊の減衰率: {rates.samples
            ? `続けて出したときの需要の比 ${rates.samples}件から。控えめ ${rates.conservative.toFixed(2)} / 標準 ${rates.standard.toFixed(2)} / 強気 ${rates.aggressive.toFixed(2)}`
            : `実績がないため既定値 ${opts.defaultDecay} を使っています`}。</li>
          <li>推奨刷り部数 = (予定イベントの予測需要の合計 + 確保したい部数)×(1 + 安全率)− 自宅などの在庫。印刷所の部数の刻みに切り上げます。</li>
          <li>イベント種別ごとの補正は、イベント種別を入れられるようになってから加えます。</li>
        </ul>
      </details>
    </>
  );
}

function ReprintCard({ plan, opts }: { plan: ReprintPlan; opts: ForecastOptions }) {
  const std = plan.scenarios.find((s) => s.key === 'standard')!;
  return (
    <div className="card">
      <div className="rowx">
        <b>{plan.item.name}</b>
        <span className="k">在庫 {plan.stock}部・直近の需要 {plan.base}</span>
      </div>
      <div className="scen">
        {plan.scenarios.map((s) => (
          <div key={s.key} className={`scen-tile${s.key === 'standard' ? ' main' : ''}`}>
            <small>{SCENARIO_LABEL[s.key]}</small>
            <strong className="num">{s.print ? `${s.print}部` : '不要'}</strong>
            <span className="k">余り {s.leftover}部{s.leftoverCost ? `(${yen(s.leftoverCost)})` : ''}</span>
          </div>
        ))}
      </div>
      <p className="note">
        {std.print ? `標準では ${std.print}部の再版をおすすめします。` : '在庫で足りる見込みです。'}
        {plan.lot > 1 ? `${plan.lot}部単位に切り上げています。` : ''}
      </p>
      {plan.reference && <p className="badge-ref">参考値: この品目を出したイベントが1回だけです</p>}
      <details>
        <summary>計算の根拠</summary>
        <table className="tbl small">
          <thead><tr><th>イベント</th><th>持込</th><th>販売</th><th>完売</th><th>需要</th></tr></thead>
          <tbody>
            {plan.history.observations.map((o) => (
              <tr key={o.eventId}>
                <td>{o.eventName}<br /><small className="k">{o.heldOn}</small></td>
                <td className="num">{o.brought}</td>
                <td className="num">{o.sold}</td>
                <td className="num">{o.soldOutAt ? hhmm(o.soldOutAt) : '—'}</td>
                <td className="num">{o.demand}{o.corrected ? '*' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note">* 完売した時刻から補正した値。標準の予測: {std.perEvent.join(' → ')}(次の{opts.plannedEvents}回)</p>
      </details>
    </div>
  );
}

function ItemBreakEvens({ data, selected, onSelect }: { data: AnalysisData; selected: string | null; onSelect: (id: string) => void }) {
  const list = useMemo(() => data.ownItems.filter((i) => !i.archived_at).map((i) => itemBreakEven(data, i)), [data]);
  const [edition, setEdition] = useState<number | undefined>(undefined);
  const total = list.find((b) => b.item.id === selected) ?? list.find((b) => b.fixedCost > 0) ?? list[0];
  if (!total) return <div className="card"><p className="note">自分の品目がまだありません。</p></div>;
  // 再版した品目は「初版から通算」と「その版だけ」を切り替えられる(F-1107)
  const editions = editionsOf(data, total.item.id);
  const ed = edition !== undefined && editions.includes(edition) ? edition : undefined;
  const cur = ed === undefined ? total : itemBreakEven(data, total.item, ed);

  const missing = cur.fixedCost === 0;
  const be = cur.breakEvenQty ?? 0;
  const xMax = Math.max(cur.printed * 1.1, be * 1.3, cur.soldQty * 1.15, 10);
  const yMax = Math.max(cur.unitRevenue * xMax, cur.fixedCost * 1.15);
  const recovered = cur.soldAmount >= cur.fixedCost && cur.fixedCost > 0;

  return (
    <>
      <label className="label-like" htmlFor="be-item">頒布物</label>
      <select id="be-item" value={cur.item.id} onChange={(e) => { setEdition(undefined); onSelect(e.target.value); }}>
        {list.map((b) => <option key={b.item.id} value={b.item.id}>{b.item.name}{b.fixedCost === 0 ? '(印刷費が未入力)' : ''}</option>)}
      </select>
      {editions.length > 1 && (
        <div className="chips" role="group" aria-label="版の見方">
          <button className="chip" aria-pressed={ed === undefined} onClick={() => setEdition(undefined)}>初版から通算</button>
          {editions.map((n) => (
            <button key={n} className="chip" aria-pressed={ed === n} onClick={() => setEdition(n)}>{n === editions[0] ? '初版' : `第${n}版`}だけ</button>
          ))}
        </div>
      )}

      {missing ? (
        <div className="card">
          <p>{cur.item.name} の印刷費が未入力です。</p>
          <p className="note">刷り記録(部数と印刷費)を入れると、何部売れば元が取れるかを出せます。</p>
          <Link className="btn center" to={`/items/${cur.item.id}`}>刷り記録を入れる</Link>
        </div>
      ) : (
        <>
          <div className="metrics">
            <div className="metric"><small>損益分岐</small><strong className="num">{be}部</strong></div>
            <div className="metric">
              <small>{recovered ? '回収済み' : '回収まで'}</small>
              <strong className="num">{recovered ? `${be}部目で回収` : `あと${Math.max(be - cur.soldQty, 0)}部`}</strong>
            </div>
          </div>
          <LineChart
            title={`${cur.item.name}${ed === undefined ? '' : ed === editions[0] ? '(初版)' : `(第${ed}版)`} の損益分岐`}
            xMax={xMax}
            yMax={yMax}
            xLabel="販売部数"
            formatX={(x) => `${Math.round(x)}`}
            formatY={(y) => man(y)}
            series={[
              { key: 'rev', label: '売上', color: 'var(--series-1)', y: (x) => cur.unitRevenue * x },
              { key: 'cost', label: '費用', color: 'var(--series-2)', y: () => cur.fixedCost, dashed: true },
            ]}
            markers={[
              { kind: 'point', x: be, y: cur.unitRevenue * be, label: `${be}部で回収` },
              ...(cur.soldQty > 0 ? [{ kind: 'vline' as const, x: cur.soldQty, label: `いま ${cur.soldQty}部` }] : []),
              ...(cur.printed > 0 ? [{ kind: 'vline' as const, x: cur.printed, label: `刷った ${cur.printed}部` }] : []),
            ]}
            tooltip={(x) => [
              ['販売', `${x}部`],
              ['売上', yen(Math.round(cur.unitRevenue * x))],
              ['費用', yen(cur.fixedCost)],
              ['差', `${cur.unitRevenue * x - cur.fixedCost >= 0 ? '+' : ''}${yen(Math.round(cur.unitRevenue * x - cur.fixedCost))}`],
            ]}
          />
          <table className="tbl small">
            <tbody>
              <tr><td>{ed === undefined || ed === editions[0] ? '費用(印刷費 + 制作費)' : '費用(この版の印刷費)'}</td><td className="num">{yen(cur.fixedCost)}</td></tr>
              <tr><td>1部あたりの売上{cur.soldQty ? '(実績の平均)' : '(定価)'}</td><td className="num">{yen(Math.round(cur.unitRevenue))}</td></tr>
              <tr><td>{ed === undefined ? 'これまでの販売' : 'この版の販売(古い版から売れた順に数える)'}</td><td className="num">{cur.soldQty}部 {yen(cur.soldAmount)}</td></tr>
              <tr><td>{ed === undefined ? '刷った部数(全版)' : '刷った部数(この版)'}</td><td className="num">{cur.printed}部</td></tr>
            </tbody>
          </table>
          {cur.cannotRecover && <p className="msg">刷った{cur.printed}部をすべて売っても、費用を回収できません。</p>}
          <p className="note">セットで売れた分は、セット価格を構成品の通常価格の比で分けて数えています。通販の販売は含みません。</p>
        </>
      )}
    </>
  );
}

function EventBreakEven({ data, selected, onSelect }: { data: AnalysisData; selected: string | null; onSelect: (id: string) => void }) {
  const events = useMemo(() => [...data.events].sort((a, b) => b.held_on.localeCompare(a.held_on)), [data.events]);
  const evId = selected ?? events[0]?.id ?? null;
  const result = useLiveQuery(async () => {
    if (!evId) return null;
    const snap = await loadEventSnapshot(db, evId);
    if (!snap) return null;
    const money = computeMoney(snap, planCounts(snap));
    // 売上がまだないときに使う、前回までの粗利率
    const earlier = events.filter((e) => e.held_on < snap.event.held_on);
    let prev: number | null = null;
    for (const e of earlier) {
      const s = await loadEventSnapshot(db, e.id);
      if (!s) continue;
      const m = computeMoney(s, planCounts(s));
      if (m.own > 0) { prev = (m.own - m.cost) / m.own; break; }
    }
    return { snap, money, be: eventBreakEven(money, prev) };
  }, [evId, events]);

  if (events.length === 0) return <div className="card"><p className="note">イベントがまだありません。</p></div>;
  if (!result) return <p className="note">計算しています…</p>;
  const { be, money, snap } = result;

  return (
    <>
      <label className="label-like" htmlFor="be-event">イベント</label>
      <select id="be-event" value={evId ?? ''} onChange={(e) => onSelect(e.target.value)}>
        {events.map((e) => <option key={e.id} value={e.id}>{e.held_on} {e.name}</option>)}
      </select>

      {be.fixed === 0 ? (
        <div className="card">
          <p>このイベントの経費が未入力です。</p>
          <p className="note">出展費や交通費を入れると、いくら売れば黒字になるかを出せます。</p>
          <Link className="btn center" to={`/events/${snap.event.id}/prepare`}>経費を入れる</Link>
        </div>
      ) : be.breakEvenSales === null ? (
        <div className="card">
          <p className="note">まだ売上がなく、前回までの実績もないため、損益分岐を出せません。販売を記録すると出ます。</p>
        </div>
      ) : (
        <EventChart be={be} ownName={snap.event.name} />
      )}
      <table className="tbl small">
        <tbody>
          <tr><td>経費</td><td className="num">{yen(money.expenses)}</td></tr>
          <tr><td>受託手数料</td><td className="num">+{yen(money.fee)}</td></tr>
          <tr><td>自分の分の売上</td><td className="num">{yen(money.own)}</td></tr>
          <tr><td>頒布分の原価</td><td className="num">−{yen(money.cost)}</td></tr>
          <tr className="total-row"><td>収支</td><td className={`num ${money.profit >= 0 ? 'pos' : 'neg-num'}`}>{money.profit >= 0 ? '+' : ''}{yen(money.profit)}</td></tr>
        </tbody>
      </table>
      <p className="note">受託分の売上は自分の収入に含めず、受け取る手数料だけを含めます。</p>
    </>
  );
}

function EventChart({ be, ownName }: { be: ReturnType<typeof eventBreakEven>; ownName: string }) {
  const m = be.margin!;
  const bes = be.breakEvenSales!;
  const xMax = Math.max(bes * 1.4, be.ownSales * 1.15, 10000);
  const f = (x: number) => m * x + be.fee - be.fixed;
  const yMin = Math.min(f(0), 0);
  const yMax = Math.max(f(xMax), 1000);
  const black = be.ownSales >= bes;
  return (
    <>
      <div className="metrics">
        <div className="metric"><small>損益分岐売上(自分の分)</small><strong className="num">{yen(bes)}</strong></div>
        <div className="metric">
          <small>{black ? '黒字' : 'あと'}</small>
          <strong className={`num ${black ? 'pos' : ''}`}>{black ? `+${yen(Math.round(f(be.ownSales)))}` : yen(bes - be.ownSales)}</strong>
        </div>
      </div>
      <LineChart
        title={`${ownName} の損益分岐`}
        xMax={xMax}
        yMin={yMin}
        yMax={yMax}
        xLabel="自分の分の売上(円)"
        formatX={(x) => man(x)}
        formatY={(y) => man(y)}
        series={[{ key: 'profit', label: '収支', color: 'var(--series-1)', y: f }]}
        markers={[
          { kind: 'point', x: bes, y: 0, label: `${man(bes)}円で黒字` },
          ...(be.ownSales > 0 ? [{ kind: 'vline' as const, x: be.ownSales, label: `いま ${man(be.ownSales)}円` }] : []),
        ]}
        tooltip={(x) => [['売上', yen(x)], ['収支', `${f(x) >= 0 ? '+' : ''}${yen(Math.round(f(x)))}`]]}
      />
      <p className="note">
        粗利率 {Math.round(m * 100)}%{be.marginSource === 'previous' ? '(このイベントはまだ売上がないため、前回のイベントの粗利率)' : ''}。
        収支 = 売上 × 粗利率 + 受託手数料 − 経費。
      </p>
    </>
  );
}
