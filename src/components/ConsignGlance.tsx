import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { db } from '../app/db';
import { consigneeState } from '../domain/consignOut';
import { yen } from '../lib/format';

/** ホームに出す、委託のいまの様子(預けている部数と、まだ入金されていない金額)。委託を使っていなければ出さない */
export function ConsignHomeCard({ circleId }: { circleId: string }) {
  const t = useLiveQuery(async () => {
    let left = 0, unpaid = 0;
    for (const s of (await consigneeState(db, circleId)).values()) {
      left += s.left;
      unpaid += s.unpaid;
    }
    return { left, unpaid };
  }, [circleId]);
  if (!t || (t.left === 0 && t.unpaid === 0)) return null;
  return (
    <Link className="card row-link" to="/consign">
      <span>
        <b>委託</b>
        <small>
          {[t.left > 0 ? `預けている ${t.left}部` : '', t.unpaid > 0 ? `まだ入金されていない ${yen(t.unpaid)}` : ''].filter(Boolean).join('・')}
        </small>
      </span>
      <span className="k">›</span>
    </Link>
  );
}

/** 品目の画面に出す、この品目の委託先ごとの様子 */
export function ItemConsign({ circleId, itemId }: { circleId: string; itemId: string }) {
  const rows = useLiveQuery(async () => {
    const out: { id: string; name: string; left: number; sold: number; sales: number }[] = [];
    for (const s of (await consigneeState(db, circleId)).values()) {
      const x = s.items.get(itemId);
      if (x && x.sent > 0) out.push({ id: s.location.id, name: s.location.name, left: x.left, sold: x.sold, sales: x.sales });
    }
    return out.sort((a, b) => b.left - a.left || a.name.localeCompare(b.name, 'ja'));
  }, [circleId, itemId]);
  if (!rows || rows.length === 0) return null;
  return (
    <>
      <h3 className="section">委託</h3>
      <div className="card">
        {rows.map((r) => (
          <div className="rowx" key={r.id}>
            <span>{r.name}<small className="k"> 売れた {r.sold}部({yen(r.sales)})</small></span>
            <b className="num">預け中 {r.left}部</b>
          </div>
        ))}
        <Link className="sub-link" to="/consign">委託の画面へ</Link>
      </div>
    </>
  );
}
