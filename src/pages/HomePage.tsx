import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { db } from '../app/db';
import { useCtx } from '../app/useCtx';
import { SyncPill } from '../components/SyncPill';
import { useToast } from '../components/Toast';
import { addSampleData } from '../domain/setup';

export function HomePage() {
  const ctx = useCtx();
  const toast = useToast();
  const circle = useLiveQuery(() => (ctx ? db.circles.get(ctx.circleId) : undefined), [ctx?.circleId]);
  const events = useLiveQuery(
    () => (ctx ? db.events.where('circle_id').equals(ctx.circleId).reverse().sortBy('held_on') : []),
    [ctx?.circleId],
  );

  return (
    <main className="page">
      <header className="bar">
        <div className="ev">
          <b>{circle?.name ?? ''}</b>
          <span>イベント</span>
        </div>
        <SyncPill />
      </header>

      {events && events.length === 0 && (
        <div className="card">
          <p>まだイベントがありません。</p>
          <button
            className="btn"
            onClick={async () => {
              if (!ctx) return;
              await addSampleData(db, ctx);
              toast('見本のイベントを追加しました');
            }}
          >
            見本のイベントを追加
          </button>
        </div>
      )}

      <ul className="list">
        {events?.map((ev) => (
          <li key={ev.id}>
            <Link className="card row-link" to={`/events/${ev.id}/register`}>
              <span>
                <b>{ev.name}</b>
                <small>{ev.held_on}{ev.space_no ? `・${ev.space_no}` : ''}</small>
              </span>
              <span className="go-label">レジを開く</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="note">イベントの作成・品目の登録・終了処理の画面は、この土台の上に追加していきます。</p>
    </main>
  );
}
