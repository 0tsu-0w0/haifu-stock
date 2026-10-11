import { changeBreakdown, denomLabel } from '../../domain/change';
import { yen } from '../../lib/format';

export interface Flash {
  total: number;
  /** お釣り。預かり金額を入れなかったら null */
  change: number | null;
  discount: number;
  /** 同じ金額でも出し直すための番号 */
  n: number;
}

/** 決済できたことを、品目の上に大きく出す(合計とお釣り)。押した操作は邪魔しない */
export function PaidFlash({ flash, instant }: { flash: Flash; instant: boolean }) {
  return (
    <div key={flash.n} className="paid-flash" role="status" aria-live="polite">
      <div className="pf-row">
        <span>{instant ? '記録しました' : '決済しました'}</span>
        <strong className="num">{yen(flash.total)}</strong>
      </div>
      {flash.discount > 0 && <p className="pf-sub">値引き {yen(flash.discount)}</p>}
      {flash.change !== null && (
        <div className="pf-row pf-change">
          <span>{flash.change > 0 ? 'お釣り' : 'お釣りなし'}</span>
          {flash.change > 0 && <strong className="num">{yen(flash.change)}</strong>}
        </div>
      )}
      {flash.change !== null && flash.change > 0 && (
        <p className="pf-sub">{changeBreakdown(flash.change).map((x) => `${denomLabel(x.denom)}×${x.count}`).join('・')}</p>
      )}
    </div>
  );
}
