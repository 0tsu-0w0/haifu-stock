import { useLiveQuery } from 'dexie-react-hooks';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../app/db';
import { usePref } from '../app/prefs';
import { useCtx } from '../app/useCtx';
import { NumberField } from '../components/NumberField';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import type { ConsignmentReport, Item, Location } from '../db/types';
import { decodeCsv, matchSales, readSalesCsv, type CsvSale } from '../domain/consignCsv';
import {
  consigneeState, defaultFee, markConsigneePaid, recordConsignReport, returnFromConsignee, saveConsignee, sendToConsignee,
  setConsigneeArchived, setConsignReportPaid, setConsignReportVoided, updateConsignReport, type ConsigneeState,
} from '../domain/consignOut';
import { storageStock } from '../domain/stock';
import { yen } from '../lib/format';

type Mode = 'send' | 'report' | 'return';
const MODE_LABEL: Record<Mode, string> = { send: '預ける', report: '売れた報告', return: '返ってきた' };

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const pct = (r: number | null | undefined) => `${Math.round((r ?? 0) * 1000) / 10}%`;

// 委託に出す(F-601〜603): 書店・ほかのサークルに預けた本の、預けた・売れた・返ってきた・受け取る金額
export function ConsignPage() {
  const ctx = useCtx();
  const toast = useToast();
  const [trackHome] = usePref('trackHome');
  const [open, setOpen] = useState<{ shopId: string; mode: Mode } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [newShop, setNewShop] = useState({ name: '', fee: '' });
  const data = useLiveQuery(async () => {
    if (!ctx) return null;
    const [items, owners, storages, states, stock] = await Promise.all([
      db.items.where('circle_id').equals(ctx.circleId).filter((i) => !i.deleted_at && i.kind !== 'set').toArray(),
      db.owners.where('circle_id').equals(ctx.circleId).toArray(),
      db.locations.where('circle_id').equals(ctx.circleId).filter((l) => l.kind === 'storage' && !l.archived_at).toArray(),
      consigneeState(db, ctx.circleId),
      storageStock(db, ctx.circleId),
    ]);
    const self = new Set(owners.filter((o) => o.is_self).map((o) => o.id));
    return { items: items.filter((i) => self.has(i.owner_id)).sort((a, b) => a.name.localeCompare(b.name, 'ja')), storages, states, stock };
  }, [ctx?.circleId]);

  if (!ctx || !data) return <main className="page" />;
  const shops = [...data.states.values()].sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '') || a.location.name.localeCompare(b.location.name, 'ja'));
  const active = shops.filter((s) => !s.location.archived_at);
  const archived = shops.filter((s) => s.location.archived_at);
  const total = active.reduce((a, s) => ({ left: a.left + s.left, net: a.net + s.net, unpaid: a.unpaid + s.unpaid }), { left: 0, net: 0, unpaid: 0 });

  async function attempt(fn: () => Promise<unknown>, done: string) {
    try {
      await fn();
      toast(done);
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  return (
    <main className="page">
      <PageHeader title="委託" sub="書店・ほかのサークルに預ける" />

      {active.length > 0 && (
        <div className="metrics">
          <div className="metric"><small>預けている</small><strong className="num">{total.left}部</strong></div>
          <div className="metric"><small>まだ入金されていない</small><strong className="num">{yen(total.unpaid)}</strong><small>受け取る金額の累計 {yen(total.net)}</small></div>
        </div>
      )}

      {active.length === 0 && (
        <div className="card">
          <p>本を書店やほかのサークルに預けて売ってもらうときに使います。</p>
          <p className="note">委託先を足して「預ける」を入れ、売れたと連絡があったら「売れた報告」を入れます。売上はイベントの売上と分けて、分析の「委託」で見られます。</p>
        </div>
      )}

      {active.map((s) => (
        <ShopCard
          key={s.location.id} s={s} items={data.items} open={open?.shopId === s.location.id ? open.mode : null}
          onOpen={(mode) => setOpen(open?.shopId === s.location.id && open.mode === mode ? null : { shopId: s.location.id, mode })}
          storages={data.storages} stock={data.stock} trackHome={trackHome}
          onDone={() => setOpen(null)} attempt={attempt}
        />
      ))}

      <h3 className="section">委託先を足す</h3>
      <form
        className="card owner-add"
        onSubmit={(e) => {
          e.preventDefault();
          void attempt(() => saveConsignee(db, ctx, { name: newShop.name, feeRate: Number(newShop.fee || 0) / 100 }), `「${newShop.name.trim()}」を足しました`)
            .then((ok) => ok && setNewShop({ name: '', fee: '' }));
        }}
      >
        <input aria-label="委託先の名前" placeholder="例: とある書店、サークルC" value={newShop.name} onChange={(e) => setNewShop({ ...newShop, name: e.target.value })} />
        <span className="exp-amount">
          <input className="price-in fee-in" inputMode="decimal" aria-label="委託先の手数料(%)" placeholder="30" value={newShop.fee} onChange={(e) => setNewShop({ ...newShop, fee: e.target.value.replace(/[^\d.]/g, '') })} />
          <small className="k">%</small>
        </span>
        <button className="sbtn" disabled={!newShop.name.trim()}>足す</button>
      </form>
      <p className="note">手数料は、委託先が売上から引く割合です(書店なら30〜40%くらいが多いです)。報告を入れるときに金額で直せます。</p>

      {archived.length > 0 && (
        <>
          <button className="link-btn" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? 'しまった委託先を隠す' : `しまった委託先(${archived.length}件)`}
          </button>
          {showArchived && (
            <div className="card">
              {archived.map((s) => (
                <div className="rowx" key={s.location.id}>
                  <span>{s.location.name}<small className="k"> 売上 {yen(s.sales)}</small></span>
                  <button className="sbtn" onClick={() => void attempt(() => setConsigneeArchived(db, s.location.id, false), `「${s.location.name}」を戻しました`)}>戻す</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <Link className="link-btn" to="/analysis?tab=consign">分析でイベントと委託の売上を比べる</Link>
    </main>
  );
}

function ShopCard(props: {
  s: ConsigneeState; items: Item[]; open: Mode | null; onOpen: (m: Mode) => void; onDone: () => void;
  storages: Location[]; stock: Map<string, number>; trackHome: boolean;
  attempt: (fn: () => Promise<unknown>, done: string) => Promise<boolean>;
}) {
  const { s, items, open, onOpen, attempt } = props;
  const [edit, setEdit] = useState(false);
  const [showReports, setShowReports] = useState(false);
  const [paying, setPaying] = useState(false);
  const [paidOn, setPaidOn] = useState(today());
  const [fixing, setFixing] = useState<ConsignmentReport | null>(null);
  const nameOf = (id: string) => items.find((i) => i.id === id)?.name ?? '品目';
  const rows = [...s.items.values()].filter((x) => x.sent > 0).sort((a, b) => b.left - a.left || nameOf(a.itemId).localeCompare(nameOf(b.itemId), 'ja'));
  const ctx = useCtx();

  return (
    <section className="card consign-shop" aria-label={s.location.name}>
      <div className="rowx">
        <span>
          <b>{s.location.name}</b>
          <small className="k"> 手数料 {pct(s.location.fee_rate)}</small>
        </span>
        <span className="k num">残り {s.left}部</span>
      </div>
      <div className="consign-figs">
        <span><small className="k">売れた</small> <b className="num">{s.sold}部</b></span>
        <span><small className="k">売上</small> <b className="num">{yen(s.sales)}</b></span>
        <span><small className="k">受け取る</small> <b className="num">{yen(s.net)}</b></span>
      </div>
      {s.unpaid > 0 && (
        <div className="rowx consign-unpaid">
          <span>まだ入金されていない <b className="num">{yen(s.unpaid)}</b></span>
          <button className="sbtn" aria-expanded={paying} onClick={() => setPaying((v) => !v)}>{paying ? '閉じる' : '入金があった'}</button>
        </div>
      )}
      {paying && s.unpaid > 0 && (
        <form
          className="consign-form"
          onSubmit={(e) => {
            e.preventDefault();
            void attempt(() => markConsigneePaid(db, s.location.id, paidOn), `${yen(s.unpaid)} を入金済みにしました`).then((ok) => ok && setPaying(false));
          }}
        >
          <div className="rowx">
            <label className="k" htmlFor={`pay-${s.location.id}`}>入金の日</label>
            <input id={`pay-${s.location.id}`} type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
          </div>
          <button className="btn primary" disabled={!paidOn}>{yen(s.unpaid)} を入金済みにする</button>
          <p className="note">まだ入金されていない報告を、まとめて入金済みにします。一部だけのときは「これまでの報告」から1件ずつ入れられます。</p>
        </form>
      )}
      <div className="chips" role="group" aria-label={`${s.location.name}の記録`}>
        {(['send', 'report', 'return'] as Mode[]).map((m) => (
          <button key={m} className="chip" aria-pressed={open === m} disabled={m !== 'send' && s.left === 0} onClick={() => onOpen(m)}>{MODE_LABEL[m]}</button>
        ))}
      </div>

      {open && ctx && (
        <MoveForm
          key={open} mode={open} s={s} items={items} storages={props.storages} stock={props.stock} trackHome={props.trackHome}
          onSubmit={async (lines, extra) => {
            const ok = await attempt(async () => {
              if (open === 'send') await sendToConsignee(db, ctx, { to: s.location.id, from: extra.storageId, lines });
              else if (open === 'return') await returnFromConsignee(db, ctx, { from: s.location.id, to: extra.storageId, lines });
              else await recordConsignReport(db, ctx, { locationId: s.location.id, reportedOn: extra.date, lines, fee: extra.fee, note: extra.note });
            }, open === 'send' ? `「${s.location.name}」に預けました` : open === 'return' ? '返ってきた分を記録しました' : '売れた報告を記録しました');
            if (ok) props.onDone();
          }}
        />
      )}

      {rows.length > 0 && (
        <table className="tbl small report-tbl">
          <thead><tr><th>品目</th><th>預けた</th><th>売れた</th><th>返った</th><th>残り</th></tr></thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.itemId}>
                <td>{nameOf(x.itemId)}</td>
                <td className="num">{x.sent}</td>
                <td className="num">{x.sold}</td>
                <td className="num">{x.returned}</td>
                <td className="num"><b>{x.left}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {s.reports.length > 0 && (
        <button className="link-btn small-link" onClick={() => setShowReports((v) => !v)}>
          {showReports ? '報告を隠す' : `これまでの報告(${s.reports.length}件)`}
        </button>
      )}
      {showReports && <Reports locationId={s.location.id} nameOf={nameOf} attempt={attempt} fixingId={fixing?.id ?? null} onFix={(r) => setFixing(fixing?.id === r.id ? null : r)} />}
      {fixing && (
        <MoveForm
          key={fixing.id} mode="report" initial={fixing} s={s} items={items} storages={props.storages} stock={props.stock} trackHome={props.trackHome}
          onSubmit={async (lines, extra) => {
            const ok = await attempt(() => updateConsignReport(db, fixing.id, { reportedOn: extra.date, lines, fee: extra.fee, note: extra.note }), '報告を直しました');
            if (ok) setFixing(null);
          }}
        />
      )}

      <div className="sub-links">
        <button className="link-btn small-link" onClick={() => setEdit((v) => !v)}>{edit ? '閉じる' : '名前・手数料を直す'}</button>
        {s.left === 0 && (
          <button className="link-btn small-link" onClick={() => void attempt(() => setConsigneeArchived(db, s.location.id, true), `「${s.location.name}」をしまいました`)}>しまう</button>
        )}
      </div>
      {edit && ctx && <ShopEdit loc={s.location} onSave={(name, fee) => attempt(() => saveConsignee(db, ctx, { id: s.location.id, name, feeRate: fee }), '保存しました').then((ok) => ok && setEdit(false))} />}
    </section>
  );
}

function ShopEdit({ loc, onSave }: { loc: Location; onSave: (name: string, fee: number) => void }) {
  const [name, setName] = useState(loc.name);
  const [fee, setFee] = useState(String(Math.round((loc.fee_rate ?? 0) * 1000) / 10));
  return (
    <form className="owner-add" onSubmit={(e) => { e.preventDefault(); onSave(name, Number(fee || 0) / 100); }}>
      <input aria-label="委託先の名前" value={name} onChange={(e) => setName(e.target.value)} />
      <span className="exp-amount">
        <input className="price-in fee-in" inputMode="decimal" aria-label="手数料(%)" value={fee} onChange={(e) => setFee(e.target.value.replace(/[^\d.]/g, ''))} />
        <small className="k">%</small>
      </span>
      <button className="sbtn" disabled={!name.trim()}>保存</button>
    </form>
  );
}

function Reports({ locationId, nameOf, attempt, fixingId, onFix }: {
  locationId: string; nameOf: (id: string) => string; attempt: (fn: () => Promise<unknown>, done: string) => Promise<boolean>;
  fixingId: string | null; onFix: (r: ConsignmentReport) => void;
}) {
  // 取り消した報告も出す(戻せるように)
  const reports = useLiveQuery(() => db.consignment_reports.where('location_id').equals(locationId).toArray(), [locationId]);
  if (!reports) return null;
  return (
    <ul className="cands">
      {reports.sort((a, b) => b.reported_on.localeCompare(a.reported_on)).map((r) => (
        <li key={r.id} className={r.voided_at ? 'archived' : ''}>
          <div className="rowx">
            <span>
              <b>{r.reported_on}</b> {yen(r.sales_amount)}<small className="k">(手数料 {yen(r.fee_amount)}){r.voided_at ? '・取り消し済み' : r.paid_on ? `・${r.paid_on} 入金` : '・まだ入金されていない'}</small>
            </span>
            {!r.voided_at && (
              <button
                className="link-btn small-link"
                onClick={() => void attempt(() => setConsignReportPaid(db, r.id, r.paid_on ? null : today()), r.paid_on ? '入金をまだに戻しました' : `${yen(r.sales_amount - r.fee_amount)} を入金済みにしました`)}
              >
                {r.paid_on ? '入金を戻す' : '入金済みにする'}
              </button>
            )}
            {!r.voided_at && (
              <button className="link-btn small-link" aria-pressed={fixingId === r.id} onClick={() => onFix(r)}>{fixingId === r.id ? '直すのをやめる' : '直す'}</button>
            )}
            <button className="link-btn small-link" onClick={() => void attempt(() => setConsignReportVoided(db, r.id, !r.voided_at), r.voided_at ? '報告を戻しました' : '報告を取り消しました')}>
              {r.voided_at ? '戻す' : '取り消す'}
            </button>
          </div>
          <small className="k">{r.lines.map((l) => `${nameOf(l.item_id)} ${l.qty}部×${yen(l.unit_price)}`).join('、')}{r.note ? `・${r.note}` : ''}</small>
        </li>
      ))}
    </ul>
  );
}

type Line = { itemId: string; qty: number; unitPrice: number };

function MoveForm(props: {
  mode: Mode; s: ConsigneeState; items: Item[]; storages: Location[]; stock: Map<string, number>; trackHome: boolean;
  /** 直している報告(売れた報告のときだけ)。その分の部数は、預け中に戻して数える */
  initial?: ConsignmentReport;
  onSubmit: (lines: Line[], extra: { storageId: string; date: string; fee: number | null; note: string }) => Promise<void>;
}) {
  const { mode, s, items, storages, stock, trackHome, initial } = props;
  const own = new Map<string, number>();
  for (const l of initial?.lines ?? []) own.set(l.item_id, (own.get(l.item_id) ?? 0) + l.qty);
  const [qty, setQty] = useState<Map<string, number>>(new Map(own));
  const [price, setPrice] = useState<Map<string, string>>(new Map((initial?.lines ?? []).map((l) => [l.item_id, String(l.unit_price)])));
  const [storageId, setStorageId] = useState(storages[0]?.id ?? '');
  const [date, setDate] = useState(initial?.reported_on ?? today());
  // 手数料が手数料率どおりだった報告は、空のままにする(部数を直したら手数料も計算し直す)
  const [fee, setFee] = useState(initial && initial.fee_amount !== defaultFee(initial.sales_amount, s.location.fee_rate) ? String(initial.fee_amount) : '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [busy, setBusy] = useState(false);
  // CSV から読んだ行のうち、どの品目か分からなかったもの(F-604)
  const [loose, setLoose] = useState<CsvSale[]>([]);
  const [csvMsg, setCsvMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const leftOf = (id: string) => (s.items.get(id)?.left ?? 0) + (own.get(id) ?? 0);
  const list = mode === 'send' ? items.filter((i) => !i.archived_at || leftOf(i.id) > 0) : items.filter((i) => leftOf(i.id) > 0);
  const priceOf = (i: Item) => {
    const v = price.get(i.id);
    return v === undefined || v === '' ? i.price : Number(v);
  };
  const lines: Line[] = list.filter((i) => (qty.get(i.id) ?? 0) > 0).map((i) => ({ itemId: i.id, qty: qty.get(i.id)!, unitPrice: priceOf(i) }));
  const count = lines.reduce((a, l) => a + l.qty, 0);
  const sales = lines.reduce((a, l) => a + l.qty * l.unitPrice, 0);
  const autoFee = defaultFee(sales, s.location.fee_rate);
  const cap = (id: string, v: number) => (mode === 'send' ? v : Math.min(v, leftOf(id)));

  /** CSV の1行を品目に足す。預けている部数より多い分は入れない */
  function addSale(itemId: string, sale: { qty: number; unitPrice: number | null }): number {
    const had = qty.get(itemId) ?? 0;
    const add = Math.min(sale.qty, Math.max(0, leftOf(itemId) - had));
    if (add > 0) {
      setQty((m) => new Map(m).set(itemId, had + add));
      // すでに入っている分と売値が違うときは、ならした売値にする(売上の合計が変わらないように)
      const item = list.find((i) => i.id === itemId);
      if (sale.unitPrice !== null && item) {
        const blended = Math.round((had * priceOf(item) + add * sale.unitPrice) / (had + add));
        setPrice((m) => new Map(m).set(itemId, String(blended)));
      }
    }
    return sale.qty - add;
  }

  async function loadCsv(file: File) {
    try {
      const draft = matchSales(readSalesCsv(decodeCsv(await file.arrayBuffer())), list);
      setQty(new Map());
      setPrice(new Map());
      const next = new Map<string, number>();
      const prices = new Map<string, string>();
      let over = 0;
      for (const m of draft.matched) {
        const add = Math.min(m.qty, leftOf(m.itemId));
        over += m.qty - add;
        if (add > 0) next.set(m.itemId, add);
        if (m.unitPrice !== null) prices.set(m.itemId, String(m.unitPrice));
      }
      setQty(next);
      setPrice(prices);
      setLoose(draft.unmatched);
      const got = [...next.values()].reduce((a, n) => a + n, 0);
      setCsvMsg(`${file.name} から ${draft.matched.length}品目・${got}部を入れました。`
        + (over > 0 ? `預けている部数より ${over}部多かったので、その分は入れていません(先に「預ける」を入れてください)。` : '')
        + (draft.unmatched.length > 0 ? `どの品目か分からない行が ${draft.unmatched.length}件あります。下で選んでください。` : '')
        + '数と売値を確かめてから記録してください。');
    } catch (e) {
      setLoose([]);
      setCsvMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <form
      className="consign-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void props.onSubmit(lines, { storageId, date, fee: fee === '' ? null : Number(fee), note }).finally(() => setBusy(false));
      }}
    >
      {initial && <p className="k"><b>{initial.reported_on} の報告を直す</b></p>}
      {list.length === 0 && <p className="note">{mode === 'send' ? '自分の品目がまだありません。' : '預けている本がありません。'}</p>}
      {list.map((i) => (
        <div key={i.id} className="prep-row">
          <div className="rowx">
            <span>
              <b>{i.name}</b>
              <small className="k">
                {mode === 'send'
                  ? (trackHome ? ` ${storages.find((l) => l.id === storageId)?.name ?? '自宅'} ${stock.get(`${i.id}|${storageId}`) ?? 0}部` : '') + (leftOf(i.id) ? `・預け中 ${leftOf(i.id)}部` : '')
                  : ` 預け中 ${leftOf(i.id)}部`}
              </small>
            </span>
            <NumberField id={`cs-${mode}-${i.id}`} label={`${i.name}の部数`} value={qty.get(i.id) ?? 0} onCommit={(v) => setQty((m) => new Map(m).set(i.id, cap(i.id, v)))} />
          </div>
          {mode === 'report' && (qty.get(i.id) ?? 0) > 0 && (
            <div className="rowx">
              <label className="k" htmlFor={`cs-price-${i.id}`}>1部の売値</label>
              <input
                id={`cs-price-${i.id}`} className="price-in" inputMode="numeric" placeholder={String(i.price)} value={price.get(i.id) ?? ''}
                onChange={(e) => setPrice((m) => new Map(m).set(i.id, e.target.value.replace(/\D/g, '')))}
              />
            </div>
          )}
        </div>
      ))}

      {mode !== 'report' && trackHome && storages.length > 1 && (
        <div className="rowx">
          <label className="k" htmlFor="cs-storage">{mode === 'send' ? '持ち出す保管場所' : '戻す保管場所'}</label>
          <select id="cs-storage" value={storageId} onChange={(e) => setStorageId(e.target.value)}>
            {storages.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
      )}

      {mode === 'report' && !initial && list.length > 0 && (
        <div className="consign-csv">
          <input
            ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv" hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void loadCsv(f);
            }}
          />
          <button type="button" className="link-btn small-link" onClick={() => fileRef.current?.click()}>販売実績のCSVから入れる</button>
          {csvMsg && <p className="note" role="status">{csvMsg}</p>}
          {loose.map((u, n) => (
            <div className="rowx" key={`${u.name}-${n}`}>
              <span>{u.name}<small className="k"> {u.qty}部{u.unitPrice !== null ? `×${yen(u.unitPrice)}` : ''}</small></span>
              <select
                aria-label={`「${u.name}」の品目`} value=""
                onChange={(e) => {
                  const id = e.target.value;
                  if (!id) return;
                  const rest = id === '-' ? 0 : addSale(id, u);
                  setLoose((xs) => xs.filter((_, i) => i !== n));
                  if (rest > 0) setCsvMsg(`「${u.name}」は預けている部数より ${rest}部多かったので、その分は入れていません。`);
                }}
              >
                <option value="">品目を選ぶ</option>
                {list.map((i) => <option key={i.id} value={i.id}>{i.name}(預け中 {leftOf(i.id)}部)</option>)}
                <option value="-">入れない</option>
              </select>
            </div>
          ))}
        </div>
      )}

      {mode === 'report' && (
        <>
          <div className="two">
            <span>
              <label htmlFor="cs-date">報告の日</label>
              <input id="cs-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </span>
            <span>
              <label htmlFor="cs-fee">手数料(円)</label>
              <input id="cs-fee" inputMode="numeric" placeholder={String(autoFee)} value={fee} onChange={(e) => setFee(e.target.value.replace(/\D/g, ''))} />
            </span>
          </div>
          <label htmlFor="cs-note">メモ</label>
          <input id="cs-note" placeholder="任意(精算書の番号など)" value={note} onChange={(e) => setNote(e.target.value)} />
          {sales > 0 && (
            <p className="k">売上 {yen(sales)} − 手数料 {yen(fee === '' ? autoFee : Number(fee))} = 受け取る {yen(sales - (fee === '' ? autoFee : Number(fee)))}</p>
          )}
        </>
      )}

      <button className="btn primary" disabled={busy || count === 0 || (mode === 'report' && !date)}>
        {count === 0 ? '部数を入れてください' : mode === 'send' ? `${count}部を預ける` : mode === 'return' ? `${count}部が返ってきた` : initial ? `${count}部の報告として保存する` : `${count}部が売れたと記録する`}
      </button>
    </form>
  );
}
