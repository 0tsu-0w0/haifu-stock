import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { db } from '../app/db';
import { useSync } from '../app/SyncProvider';
import { useCtx } from '../app/useCtx';
import { NumberField } from '../components/NumberField';
import { useToast } from '../components/Toast';
import type { CountHandling } from '../db/types';
import {
  DENOMINATIONS, cashDiffHints, computeMoney, confirmClosing, planCounts, plannedExtraSales, saveCash, saveCount,
  saveCountFrom, settlementText, type CountRow,
} from '../domain/closing';
import type { Ctx } from '../domain/record';
import { exportLedger, importLedger } from '../sync/file';
import { hhmm, yen } from '../lib/format';
import { useEventData } from './useEventData';

const STEPS = ['同期の確認', '残数の確認', '現金の数え合わせ', '精算と在庫'] as const;
const HANDLING_LABEL: Record<CountHandling, string> = {
  add_sale: '販売を追加', lost: '紛失として記録', fix_bring: '持ち込み数を修正', keep: 'そのまま',
};

type Data = NonNullable<ReturnType<typeof useEventData>>;

// 終了処理(F-500〜506)。数えた値は入れるそばから保存されるので、途中で閉じても続きから再開できる
export function ClosingPage() {
  const { eventId = '' } = useParams();
  const ctx = useCtx();
  const data = useEventData(eventId);
  const navigate = useNavigate();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [dest, setDest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLElement>(null);

  const rows = useMemo(() => (data ? planCounts(data) : []), [data]);
  const money = useMemo(() => (data ? computeMoney(data, rows) : null), [data, rows]);

  if (data === undefined || ctx === undefined) return <main className="page" />;
  if (data === null || ctx === null || !money) {
    return (
      <main className="page">
        <p>イベントが見つかりません。</p>
        <Link to="/">ホームに戻る</Link>
      </main>
    );
  }

  const done = !!data.closing;
  const returnTo = dest ?? data.storages[0]?.id ?? null;
  const go = (n: number) => {
    setStep(n);
    body.current?.scrollTo({ top: 0 });
  };

  async function confirm() {
    if (!returnTo) return toast('戻し先の置き場所がありません');
    setBusy(true);
    try {
      await confirmClosing(db, ctx!, eventId, { returnLocationId: returnTo });
      toast('終了処理を確定しました');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="closing">
      <header className="c-top">
        <Link className="icon-btn" to={`/events/${eventId}/register`} aria-label="レジに戻る">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </Link>
        <div className="c-title">
          <b>終了処理</b>
          <span>{done ? '確定済み' : `${step + 1} / 4 ${STEPS[step]}`}</span>
        </div>
      </header>
      <div className="c-steps">{STEPS.map((s, i) => <span key={s} className={done || i <= step ? 'on' : ''} />)}</div>

      <main className="c-body" ref={body}>
        {done ? <DoneView data={data} />
          : step === 0 ? <SyncStep data={data} ctx={ctx} />
          : step === 1 ? <CountStep data={data} ctx={ctx} rows={rows} />
          : step === 2 ? <CashStep data={data} ctx={ctx} rows={rows} money={money} />
          : <SettleStep data={data} rows={rows} money={money} returnTo={returnTo} setDest={setDest} />}
        {done && (
          <button className="btn primary" onClick={() => navigate(`/events/${eventId}/register`)}>レジに戻る</button>
        )}
      </main>

      {!done && (
        <footer className="foot">
          <button className="fbtn" onClick={() => (step === 0 ? navigate(`/events/${eventId}/register`) : go(step - 1))}>
            {step === 0 ? 'レジに戻る' : '戻る'}
          </button>
          <button className="fbtn primary" disabled={busy} onClick={() => (step < 3 ? go(step + 1) : void confirm())}>
            {step < 3 ? '次へ' : '終了処理を確定'}
          </button>
        </footer>
      )}
    </div>
  );
}

function SyncStep({ data, ctx }: { data: Data; ctx: Ctx }) {
  const { pending, state, syncNow } = useSync();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const others = useMemo(() => {
    const m = new Map<string, { count: number; last: string }>();
    for (const t of data.txns) {
      if (t.device_id === ctx.deviceId) continue;
      const x = m.get(t.device_id) ?? { count: 0, last: '' };
      m.set(t.device_id, { count: x.count + 1, last: t.recorded_at > x.last ? t.recorded_at : x.last });
    }
    return [...m];
  }, [data.txns, ctx.deviceId]);

  async function sendFile() {
    const ledger = await exportLedger(db, data.event.id, ctx.deviceId);
    const name = `haifu-${data.event.held_on}-${ctx.deviceId.slice(-6)}.json`;
    const file = new File([JSON.stringify(ledger)], name, { type: 'application/json' });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: '頒布レジの記録' });
        return;
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return (
    <>
      <p className="lead">すべての端末の記録がそろってから数え合わせます。</p>
      <div className={`card${pending ? ' warn' : ''}`}>
        <div className="rowx">
          <div className="dev"><b>この端末</b><small>{pending ? `未送信 ${pending}件` : '未送信 0件'}{state.kind === 'local' ? '・同期先は未設定' : ''}</small></div>
        </div>
        <div className="btns">
          <button className="sbtn acc" onClick={async () => toast(await syncNow())}>同期する</button>
          <button className="sbtn" onClick={() => void sendFile()}>記録をファイルで送る</button>
        </div>
      </div>
      <div className="card">
        <b>ほかの端末の記録</b>
        {others.length === 0 && <p className="note">この端末に届いている、ほかの端末の記録はありません。</p>}
        {others.map(([id, x]) => (
          <div className="rowx" key={id}>
            <span>端末 …{id.slice(-6)}</span>
            <span className="k">{x.count}件・最後 {hhmm(x.last)}</span>
          </div>
        ))}
        <p className="note">売り子の端末がまだ送れていないときは、売り子の端末で「記録をファイルで送る」を押し、AirDropなどでこの端末に送って取り込んでください。</p>
        <button className="sbtn" onClick={() => fileInput.current?.click()}>ファイルを取り込む</button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            try {
              const n = await importLedger(db, JSON.parse(await f.text()));
              toast(n ? `${n}件を取り込みました` : '取り込み済みです。重複はありません');
            } catch (err) {
              toast(err instanceof Error ? err.message : 'このファイルは読み込めません');
            }
          }}
        />
      </div>
    </>
  );
}

function CountStep({ data, ctx, rows }: { data: Data; ctx: Ctx; rows: CountRow[] }) {
  const toast = useToast();
  const bad = rows.filter((r) => r.diff !== 0).length;
  const save = (p: Promise<void>) => p.catch((e: Error) => toast(e.message));
  return (
    <>
      <p className="lead">実際に数えた数を入れてください。最初は理論上の残数が入っています。</p>
      <div className={`card ${bad ? 'warn' : 'good'}`}><b>{bad ? `差異のある品目 ${bad}件` : 'すべて一致しています'}</b></div>
      {rows.map((r) => {
        const owner = data.ownerById.get(r.item.owner_id);
        const choices: CountHandling[] = r.diff < 0 ? ['add_sale', 'lost', 'keep'] : r.diff > 0 ? ['fix_bring', 'keep'] : [];
        const label = (h: CountHandling) =>
          h === 'add_sale' ? `販売を追加 ${yen(-r.diff * data.priceOf(r.item))}`
          : h === 'fix_bring' ? `持ち込み数を${r.diff}部増やす`
          : HANDLING_LABEL[h];
        return (
          <div key={r.item.id} className={`card${r.diff ? ' bad' : ''}`}>
            <div className="rowx">
              <span><b>{r.item.name}</b>{owner && !owner.is_self && <span className="ctag">受託: {owner.name}</span>}</span>
            </div>
            <div className="rowx">
              <span className="k">理論 <b className={`num${r.theo < 0 ? ' neg-num' : ''}`}>{r.theo}</b></span>
              <NumberField
                id={`count-${r.item.id}`}
                label={`${r.item.name}の実数`}
                value={r.counted}
                big
                onCommit={(v) => void save(saveCountFrom(db, ctx, data.event.id, r, v))}
              />
            </div>
            {r.diff < 0 && <p className="msg">{-r.diff}部足りません。打ち漏れの可能性があります。</p>}
            {r.diff > 0 && (
              <p className="msg">
                {r.theo < 0
                  ? `残数0のあとに${-r.theo}部販売しています。持ち込み数の入力漏れかもしれません。`
                  : `理論より${r.diff}部多くあります。持ち込み数の入力漏れか、記録のしすぎかもしれません。`}
              </p>
            )}
            {choices.length > 0 && (
              <div className="chips">
                {choices.map((h) => (
                  <button
                    key={h}
                    className="chip"
                    aria-pressed={r.handling === h}
                    onClick={() => void save(saveCount(db, ctx, data.event.id, r.item.id, { counted: r.counted, handling: h }))}
                  >
                    {label(h)}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function CashStep({ data, ctx, rows, money }: { data: Data; ctx: Ctx; rows: CountRow[]; money: ReturnType<typeof computeMoney> }) {
  const toast = useToast();
  const counts = new Map(data.cash.filter((c) => c.phase === 'close').map((c) => [c.denomination, c.count]));
  const extra = plannedExtraSales(data, rows);
  const theo = data.float + data.totals.amount + extra;
  const diff = data.counted - theo;
  const hints = cashDiffHints(diff, data.items, rows);
  return (
    <>
      <p className="lead">現金箱の中身を金種ごとに数えて入れてください。受託分の売上も同じ箱に入っている前提です。</p>
      <div className="card">
        {DENOMINATIONS.map((d) => (
          <div className="dn" key={d}>
            <span className="num">{d.toLocaleString('ja-JP')}円</span>
            <NumberField
              id={`cash-${d}`}
              label={`${d}円の枚数`}
              value={counts.get(d) ?? 0}
              onCommit={(v) => void saveCash(db, ctx, data.event.id, d, v).catch((e: Error) => toast(e.message))}
            />
            <span className="sub num">{yen(d * (counts.get(d) ?? 0))}</span>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="rowx"><span className="k">数えた額</span><b className="num">{yen(data.counted)}</b></div>
        <div className="rowx"><span className="k">理論残高</span><b className="num">{yen(theo)}</b></div>
        <table className="tbl num sub-tbl">
          <tbody>
            <tr><td>釣り銭準備金</td><td>{yen(data.float)}</td></tr>
            <tr><td>自分の分の売上</td><td>{yen(money.own)}</td></tr>
            <tr><td>受託分の売上</td><td>{yen(money.consigned)}</td></tr>
            {extra > 0 && <tr><td>うち残数確認で追加した販売</td><td>{yen(extra)}</td></tr>}
          </tbody>
        </table>
      </div>
      {data.counted === 0 ? (
        <p className="lead">枚数を入れると差異を表示します。</p>
      ) : (
        <>
          <div className={`bigdiff ${diff === 0 ? 'ok' : 'ng'}`}>
            <span>{diff === 0 ? '一致しました' : '差異'}</span>
            <strong className="num">{diff > 0 ? '+' : ''}{yen(diff)}</strong>
          </div>
          {hints.length > 0 && (
            <div className="card">
              <b>考えられる原因</b>
              <ul className="cands">{hints.map((h) => <li key={h}>{h}</li>)}</ul>
            </div>
          )}
        </>
      )}
    </>
  );
}

function SettleStep(props: {
  data: Data; rows: CountRow[]; money: ReturnType<typeof computeMoney>; returnTo: string | null; setDest: (id: string) => void;
}) {
  const { data, rows, money, returnTo, setDest } = props;
  const toast = useToast();
  const [fallback, setFallback] = useState<{ owner: string; text: string } | null>(null);
  const ownLeft = rows.filter((r) => data.ownerById.get(r.item.owner_id)?.is_self).reduce((a, r) => a + r.counted, 0);

  return (
    <>
      <h3>受託分の精算</h3>
      {money.settlements.length === 0 && <p className="note">受託分はありません。</p>}
      {money.settlements.map((x) => (
        <div className="card" key={x.ownerId}>
          <div className="rowx">
            <b>{x.name}</b>
            <button
              className="sbtn"
              onClick={async () => {
                const text = settlementText(data.event.name, x);
                try {
                  await navigator.clipboard.writeText(text);
                  toast('精算書をコピーしました');
                } catch {
                  setFallback({ owner: x.ownerId, text });
                }
              }}
            >
              精算書をコピー
            </button>
          </div>
          <table className="tbl num">
            <tbody>
              {x.lines.map((l) => (
                <tr key={l.item.id}><td>{l.item.name}</td><td>{l.soldQty}部 {yen(l.amount)}・返却 {l.returnedQty}部</td></tr>
              ))}
              <tr><td>受託手数料({Math.round(x.feeRate * 100)}%)</td><td>−{yen(x.fee)}</td></tr>
              <tr className="sum"><td>お支払い</td><td>{yen(x.payout)}</td></tr>
            </tbody>
          </table>
          {fallback?.owner === x.ownerId && (
            <>
              <p className="note">コピーできなかったため、下の文章を選んでコピーしてください。</p>
              <textarea className="copyfallback" readOnly value={fallback.text} onFocus={(e) => e.target.select()} autoFocus />
            </>
          )}
        </div>
      ))}

      <h3>自分の分の持ち帰り</h3>
      <div className="card">
        <div className="rowx">
          <label htmlFor="dest">残り <b className="num">{ownLeft}</b>部の戻し先</label>
          <select id="dest" value={returnTo ?? ''} onChange={(e) => setDest(e.target.value)}>
            {data.storages.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <p className="note">受託分の残りは持ち主に返却します。</p>
      </div>

      <h3>このイベントの収支(自分の分)</h3>
      <div className="card">
        <table className="tbl num">
          <tbody>
            <tr><td>売上</td><td>{yen(money.own)}</td></tr>
            <tr><td>受託手数料</td><td>+{yen(money.fee)}</td></tr>
            <tr><td>経費</td><td>−{yen(money.expenses)}</td></tr>
            <tr><td>頒布分の原価</td><td>−{yen(money.cost)}</td></tr>
            <tr className="sum"><td>収支</td><td className={money.profit >= 0 ? 'pos' : 'neg-num'}>{money.profit >= 0 ? '+' : ''}{yen(money.profit)}</td></tr>
          </tbody>
        </table>
      </div>
      <p className="lead">確定すると、残数確認で選んだ「販売を追加」「紛失」「持ち込み数の修正」を記録に反映し、このイベントの記録をロックします。</p>
    </>
  );
}

function DoneView({ data }: { data: Data }) {
  const c = data.closing!;
  const settlements = useLiveQuery(() => db.consignment_settlements.filter((x) => x.event_closing_id === c.id).toArray(), [c.id]);
  return (
    <>
      <div className="card good">
        <b>{hhmm(c.closed_at)} に終了処理を確定しました</b>
        <span className="note">このイベントの記録はロックされています。</span>
      </div>
      <div className="metrics">
        <div className="metric"><small>売上(全体)</small><strong className="num">{yen(c.summary.sales)}</strong></div>
        <div className="metric"><small>販売部数</small><strong className="num">{c.summary.count}</strong></div>
        <div className="metric">
          <small>現金の差異</small>
          <strong className={`num${c.cash_diff ? ' neg-num' : ''}`}>
            {c.cash_diff === null ? '未入力' : `${c.cash_diff > 0 ? '+' : ''}${yen(c.cash_diff)}`}
          </strong>
        </div>
        <div className="metric">
          <small>収支(自分の分)</small>
          <strong className={`num ${c.summary.profit >= 0 ? 'pos' : 'neg-num'}`}>{c.summary.profit >= 0 ? '+' : ''}{yen(c.summary.profit)}</strong>
        </div>
      </div>
      <h3>残数確認で反映したこと</h3>
      <div className="card">
        {c.summary.fixes.length === 0 && <span className="k">なし</span>}
        {c.summary.fixes.map((f) => (
          <div className="rowx" key={f.item_id}><span>{f.name}</span><span className="k">{HANDLING_LABEL[f.handling]} {f.qty}部</span></div>
        ))}
      </div>
      <h3>受託分のお支払い</h3>
      <div className="card">
        {(settlements ?? []).length === 0 && <span className="k">なし</span>}
        {settlements?.map((x) => (
          <div className="rowx" key={x.id}>
            <span>{data.ownerById.get(x.owner_id)?.name}</span><b className="num">{yen(x.payout_amount)}</b>
          </div>
        ))}
      </div>
      <p className="lead">自分の分の残りは「{data.storages.find((l) => l.id === c.return_location_id)?.name ?? '戻し先'}」に戻しました。</p>
    </>
  );
}
