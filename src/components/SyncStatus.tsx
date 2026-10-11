import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../app/db';
import { useSync } from '../app/SyncProvider';
import { getMeta } from '../db/local';
import { TABLE_BY_NAME } from '../db/tables';
import { SYNC_ERRORS_KEY, type TableError } from '../sync/engine';
import { useToast } from './Toast';

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'まだ');

/** 設定の「同期の状態」(#17)。最後に同期した時刻と、同期できなかった表とその理由を出す */
export function SyncStatus() {
  const { pending, syncNow } = useSync();
  const toast = useToast();
  const info = useLiveQuery(async () => ({
    last: await getMeta<string>(db, 'last_synced_at'),
    errors: (await getMeta<TableError[]>(db, SYNC_ERRORS_KEY)) ?? [],
    byTable: new Map((await db.outbox.toArray()).reduce((m, e) => m.set(e.table, (m.get(e.table) ?? 0) + 1), new Map<string, number>())),
  }), [pending]);
  if (!info) return null;
  const label = (t: string) => TABLE_BY_NAME[t]?.label ?? t;
  return (
    <div className="card sync-status">
      <div className="rowx"><span className="k">最後に同期した時刻</span><span className="num">{when(info.last)}</span></div>
      <div className="rowx"><span className="k">未送信</span><span className="num">{pending}件</span></div>
      {info.errors.length === 0 ? (
        <p className="note">前回の同期では、すべての記録を送り受けできました。</p>
      ) : (
        <>
          <p className="warnnote">前回の同期で、次の記録は同期できませんでした。ほかの記録(販売など)は同期しています。</p>
          <ul className="sync-errors">
            {info.errors.map((e) => (
              <li key={`${e.table}-${e.phase}`}>
                <b>{label(e.table)}</b>
                <span className="k">
                  {e.phase === 'push' ? '送れていません' : '受け取れていません'}
                  {e.phase === 'push' && info.byTable.get(e.table) ? `(${info.byTable.get(e.table)}件)` : ''}
                  {e.blockedBy ? `。先に「${label(e.blockedBy)}」を送る必要があります` : ''}
                </span>
                {!e.blockedBy && <small className="sync-err-msg">{e.message}</small>}
              </li>
            ))}
          </ul>
          <p className="note">記録は端末に残っていて、次の同期でもう一度送ります。直らないときは、この画面のスクリーンショットを共有してください。</p>
        </>
      )}
      <button className="btn" onClick={async () => toast(await syncNow())}>今すぐ同期する</button>
    </div>
  );
}
