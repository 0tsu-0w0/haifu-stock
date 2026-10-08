import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { useAuth } from '../app/AuthProvider';
import { db } from '../app/db';
import { useCtx } from '../app/useCtx';
import { AccountBar } from '../components/AccountBar';
import { SyncPill } from '../components/SyncPill';
import { useToast } from '../components/Toast';
import { addSampleData } from '../domain/setup';

export function HomePage() {
  const ctx = useCtx();
  const toast = useToast();
  const { configured, role } = useAuth();
  const circle = useLiveQuery(() => (ctx ? db.circles.get(ctx.circleId) : undefined), [ctx?.circleId]);
  const events = useLiveQuery(
    () => (ctx ? db.events.where('circle_id').equals(ctx.circleId).reverse().sortBy('held_on') : []),
    [ctx?.circleId],
  );
  const owner = role === 'owner';

  return (
    <main className="page">
      <header className="bar">
        <div className="ev">
          <b>{circle?.name ?? (owner ? '' : '売り子')}</b>
          <span>イベント</span>
        </div>
        <SyncPill />
      </header>
      <AccountBar />

      {owner && (
        <div className="home-actions">
          <Link className="btn primary center" to="/events/new">イベントを作る</Link>
          <Link className="btn center" to="/items">品目</Link>
          <Link className="btn center" to="/analysis">分析</Link>
        </div>
      )}

      {events && events.length === 0 && (
        owner ? (
          <div className="card">
            <p>まだイベントがありません。品目を登録してから、イベントを作ってください。</p>
            <button
              className="link-btn"
              onClick={async () => {
                if (!ctx) return;
                await addSampleData(db, ctx);
                toast('見本のイベントを追加しました');
              }}
            >
              見本のイベントで試す
            </button>
          </div>
        ) : (
          <div className="card"><p>イベントを受け取っています。少し待っても出ないときは、上の同期の表示を押してください。</p></div>
        )
      )}

      <ul className="list">
        {events?.map((ev) => (
          <li key={ev.id} className="event-row">
            <Link className="card row-link" to={`/events/${ev.id}/register`}>
              <span>
                <b>{ev.name}</b>
                <small>{ev.held_on}{ev.space_no ? `・${ev.space_no}` : ''}</small>
              </span>
              <span className="go-label">レジを開く</span>
            </Link>
            {owner && (
              <span className="sub-links">
                <Link className="sub-link" to={`/events/${ev.id}/prepare`}>準備(持ち込み・釣り銭・経費)</Link>
                {configured && <Link className="sub-link" to={`/events/${ev.id}/invite`}>売り子を招待</Link>}
              </span>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
