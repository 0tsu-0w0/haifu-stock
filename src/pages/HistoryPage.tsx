import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { db } from '../app/db';
import { useCtx } from '../app/useCtx';
import { EventNav } from '../components/EventNav';
import { useToast } from '../components/Toast';
import { filterHistory, historyRows, type HistoryFilter, type HistoryRow } from '../domain/history';
import { voidTransaction } from '../domain/record';
import { hhmm, yen } from '../lib/format';
import { useEventData } from './useEventData';

const FILTERS: [HistoryFilter, string][] = [['all', 'すべて'], ['sale', '販売'], ['giveaway', '見本誌など'], ['voided', '取り消し済み']];

// レジの履歴(F-404、F-1008)。どの端末の記録でも、ここから取り消せる。
// 取り消しても記録は消えず、「取り消し済み」として残る
export function HistoryPage() {
  const { eventId = '' } = useParams();
  const ctx = useCtx();
  const data = useEventData(eventId);
  const toast = useToast();
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [armed, setArmed] = useState<string | null>(null);

  const rows = useMemo(() => (data ? historyRows(data.txns, data.linesByTxn, data.itemById) : []), [data]);
  const shown = useMemo(() => filterHistory(rows, filter), [rows, filter]);

  if (data === undefined || ctx === undefined) return <main className="page" />;
  if (data === null || ctx === null) {
    return (
      <main className="page">
        <p>イベントが見つかりません。</p>
        <Link to="/">ホームに戻る</Link>
      </main>
    );
  }

  const locked = !!data.closing;
  const active = rows.filter((r) => !r.voided);
  const sales = active.filter((r) => r.kind === 'sale');
  const deviceLabel = (id: string) => (id === ctx.deviceId ? 'この端末' : `端末 …${id.slice(-6)}`);

  async function undo(r: HistoryRow) {
    if (armed !== r.txn.id) {
      setArmed(r.txn.id);
      return;
    }
    setArmed(null);
    try {
      await voidTransaction(db, ctx!, r.txn.id);
      toast(`取り消し: ${r.label}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="closing">
      <header className="c-top">
        <div className="c-title">
          <b>記録の履歴</b>
          <span>{data.event.name}</span>
        </div>
      </header>

      <main className="c-body">
        <div className="metrics">
          <div className="metric"><small>販売</small><strong className="num">{sales.length}件 {yen(sales.reduce((a, r) => a + r.amount, 0))}</strong></div>
          <div className="metric"><small>取り消し済み</small><strong className="num">{rows.length - active.length}件</strong></div>
        </div>
        {locked && <p className="note">終了処理を確定済みのため、取り消しはできません。</p>}

        <div className="chips" role="group" aria-label="表示する記録">
          {FILTERS.map(([k, label]) => (
            <button key={k} className="chip" aria-pressed={filter === k} onClick={() => { setFilter(k); setArmed(null); }}>
              {label}
            </button>
          ))}
        </div>

        {shown.length === 0 && <p className="note">該当する記録はありません。</p>}
        <ul className="hist">
          {shown.map((r) => (
            <li key={r.txn.id} className={`hr${r.voided ? ' void' : ''}`}>
              <time className="num">{hhmm(r.txn.recorded_at)}</time>
              <span className="what">
                <span className="label">{r.label}</span>
                <small>
                  {deviceLabel(r.txn.device_id)}
                  {r.discount > 0 && `・値引き ${yen(r.discount)}${r.txn.note ? `(${r.txn.note})` : ''}`}
                  {r.txn.paid_amount !== null && `・預かり ${yen(r.txn.paid_amount)}`}
                  {r.txn.zero_stock_override && '・残数0で記録'}
                  {r.txn.source === 'closing' && '・終了処理で追加'}
                  {r.voided && `・${hhmm(r.voided.recorded_at)} に取り消し`}
                </small>
              </span>
              <span className="amt num">{r.kind === 'sale' ? yen(r.amount) : '—'}</span>
              {!r.voided && !locked && (
                <button
                  className={`undo${armed === r.txn.id ? ' armed' : ''}`}
                  onClick={() => void undo(r)}
                  aria-label={armed === r.txn.id ? `${r.label} の取り消しを確定` : `${r.label} を取り消す`}
                >
                  {armed === r.txn.id ? 'もう一度押すと取り消し' : '取り消し'}
                </button>
              )}
            </li>
          ))}
        </ul>
      </main>
      <EventNav eventId={eventId} current="history" />
    </div>
  );
}
