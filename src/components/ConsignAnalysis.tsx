import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../app/db';
import type { AnalysisData } from '../domain/analysis';
import { consignAnalysis, consigneeState } from '../domain/consignOut';
import { yen } from '../lib/format';

const share = (part: number, all: number) => (all > 0 ? `${Math.round((part / all) * 100)}%` : '−');

/** イベントで売れた分と、委託先で売れた分を分けて見る(F-603) */
export function ConsignAnalysisView({ circleId, data }: { circleId: string; data: AnalysisData }) {
  const states = useLiveQuery(() => consigneeState(db, circleId), [circleId]);
  const a = useMemo(
    () => (states ? consignAnalysis(states, data.ownItems, new Map([...data.soldTotals].map(([id, v]) => [id, { qty: v.qty, sales: Math.round(v.amount) }]))) : null),
    [states, data],
  );
  if (!a) return <p className="note">計算しています…</p>;
  if (a.shops.length === 0) {
    return (
      <div className="card">
        <p>委託先がまだありません。</p>
        <p className="note">書店やほかのサークルに本を預けたら、委託の画面で記録すると、イベントの売上と分けてここに出ます。</p>
        <Link className="btn center" to="/consign">委託の画面へ</Link>
      </div>
    );
  }
  const t = a.totals;
  const all = t.eventSales + t.shopSales;
  return (
    <>
      <div className="metrics">
        <div className="metric"><small>イベントの売上</small><strong className="num">{yen(t.eventSales)}</strong><small>{share(t.eventSales, all)}</small></div>
        <div className="metric"><small>委託の売上</small><strong className="num">{yen(t.shopSales)}</strong><small>{share(t.shopSales, all)}・手数料 {yen(t.shopFee)}</small></div>
      </div>
      <p className="note">これまでの累計です(自分の頒布物だけ)。委託の売上は委託先の売値で数え、受け取る金額は手数料を引いた {yen(t.shopNet)} です{t.shopUnpaid > 0 ? `(うち ${yen(t.shopUnpaid)} は、まだ入金されていません)` : ''}。委託先に残っている本は {t.shopLeft}部です。</p>

      <h3 className="section">委託先ごと</h3>
      <div className="card table-scroll">
        <table className="tbl small report-tbl">
          <thead><tr><th>委託先</th><th>売れた</th><th>売上</th><th>手数料</th><th>受け取る</th><th>未入金</th><th>残り</th></tr></thead>
          <tbody>
            {a.shops.map((s) => (
              <tr key={s.id}>
                <td>{s.name}<small className="k"> {Math.round(s.feeRate * 1000) / 10}%</small></td>
                <td className="num">{s.sold}</td>
                <td className="num">{yen(s.sales)}</td>
                <td className="num">{yen(s.fee)}</td>
                <td className="num">{yen(s.net)}</td>
                <td className="num">{s.unpaid > 0 ? yen(s.unpaid) : '−'}</td>
                <td className="num">{s.left}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="section">品目ごと(イベント / 委託)</h3>
      <div className="card table-scroll">
        <table className="tbl small report-tbl">
          <thead><tr><th>品目</th><th>イベント</th><th>委託</th><th>委託の割合</th></tr></thead>
          <tbody>
            {a.items.map((r) => (
              <tr key={r.itemId}>
                <td>{r.name}</td>
                <td className="num">{r.eventQty}部<small className="k"> {yen(r.eventSales)}</small></td>
                <td className="num">{r.shopQty}部<small className="k"> {yen(r.shopSales)}</small></td>
                <td className="num">{share(r.shopQty, r.eventQty + r.shopQty)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">委託で売れた分は、持ち込み数の目安やイベントの損益には入れていません。刷り部数を考えるときは、委託に回す分を「イベント以外で確保したい部数」に入れてください。</p>
      <Link className="link-btn" to="/consign">委託の画面へ</Link>
    </>
  );
}
