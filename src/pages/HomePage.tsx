import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../app/AuthProvider';
import { db } from '../app/db';
import { isIos, isStandalone, useInstallPrompt } from '../app/install';
import { useCtx } from '../app/useCtx';
import { AccountBar } from '../components/AccountBar';
import { SyncPill } from '../components/SyncPill';
import { useToast } from '../components/Toast';
import type { EventRow } from '../db/types';
import { restoreEvent } from '../domain/catalog';

const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

export function HomePage() {
  const ctx = useCtx();
  const toast = useToast();
  const { configured, role } = useAuth();
  const [showDeleted, setShowDeleted] = useState(false);
  const circle = useLiveQuery(() => (ctx ? db.circles.get(ctx.circleId) : undefined), [ctx?.circleId]);
  const all = useLiveQuery(
    () => (ctx ? db.events.where('circle_id').equals(ctx.circleId).reverse().sortBy('held_on') : []),
    [ctx?.circleId],
  );
  // はじめの準備の進み具合(品目 → イベント → 持ち込み)
  const setup = useLiveQuery(async () => {
    if (!ctx) return null;
    const [items, eventItems] = await Promise.all([
      db.items.where('circle_id').equals(ctx.circleId).filter((i) => !i.deleted_at).count(),
      db.event_items.filter((e) => e.circle_id === ctx.circleId && !e.removed_at).toArray(),
    ]);
    return { items, bringEvents: new Set(eventItems.map((e) => e.event_id)) };
  }, [ctx?.circleId]);

  const events = all?.filter((e) => !e.deleted_at);
  const deleted = all?.filter((e) => e.deleted_at) ?? [];
  const owner = role === 'owner';
  const today = localDate();
  // 今日か、これから先でいちばん近いイベントを大きく出す
  const next = events?.filter((e) => e.held_on >= today).sort((a, b) => a.held_on.localeCompare(b.held_on))[0];
  const rest = events?.filter((e) => e.id !== next?.id) ?? [];

  const steps = setup && events && [
    { done: setup.items > 0, label: '品目を登録する', note: '頒布する本やグッズと、刷った部数・印刷費', to: '/items/new' },
    { done: events.length > 0, label: 'イベントを作る', note: 'イベント名と開催日、スペース番号', to: '/events/new' },
    {
      done: events.some((e) => setup.bringEvents.has(e.id)),
      label: '持ち込み数を入れる',
      note: '準備の画面で、持ち込む品目と数、釣り銭',
      to: events[0] ? `/events/${(next ?? events[0]).id}/prepare` : '/events/new',
    },
  ];
  const doneCount = steps?.filter((s) => s.done).length ?? 0;

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

      {owner && steps && doneCount < steps.length && (
        <section className="card onboard" aria-label="はじめの準備">
          <div className="rowx">
            <b>はじめの準備</b>
            <span className="k num">{doneCount} / {steps.length}</span>
          </div>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneCount}>
            <span style={{ width: `${(doneCount / steps.length) * 100}%` }} />
          </div>
          <ol className="steps">
            {steps.map((s, i) => {
              const current = !s.done && steps.slice(0, i).every((x) => x.done);
              return (
                <li key={s.label} className={s.done ? 'done' : current ? 'current' : ''}>
                  <span className="mark num" aria-hidden="true">{s.done ? '✓' : i + 1}</span>
                  <span className="step-text">
                    <b>{s.label}</b>
                    <small>{s.done ? '済み' : s.note}</small>
                  </span>
                  {current && <Link className="sbtn acc" to={s.to}>始める</Link>}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {next && <NextEvent ev={next} today={today} owner={owner} invite={configured} />}

      <InstallCard />

      {owner && (
        <div className="home-actions">
          <Link className="btn center" to="/events/new">イベントを作る</Link>
          <Link className="btn center" to="/items">品目</Link>
          <Link className="btn center" to="/analysis">分析</Link>
        </div>
      )}

      {events && events.length === 0 && !owner && (
        <div className="card"><p>イベントを受け取っています。少し待っても出ないときは、上の同期の表示を押してください。</p></div>
      )}

      {rest.length > 0 && <h3 className="section">{next ? 'ほかのイベント' : 'これまでのイベント'}</h3>}
      <ul className="list">
        {rest.map((ev) => (
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

      {owner && deleted.length > 0 && (
        <>
          <button className="link-btn" onClick={() => setShowDeleted((v) => !v)}>
            {showDeleted ? '削除したイベントを隠す' : `削除したイベント(${deleted.length}件)`}
          </button>
          {showDeleted && (
            <div className="card">
              {deleted.map((ev) => (
                <div className="rowx" key={ev.id}>
                  <span><span className="k">{ev.held_on}</span> {ev.name}</span>
                  <button className="sbtn" onClick={async () => { await restoreEvent(db, ev.id); toast(`${ev.name} を元に戻しました`); }}>元に戻す</button>
                </div>
              ))}
              <p className="note">削除したイベントは、一覧と分析に出なくなります。記録は残っているので、元に戻せます。</p>
            </div>
          )}
        </>
      )}
    </main>
  );
}

/** 今日・次のイベント。会場で開いてすぐレジに入れるよう、大きなボタンにする */
function NextEvent({ ev, today, owner, invite }: { ev: EventRow; today: string; owner: boolean; invite: boolean }) {
  const days = daysBetween(today, ev.held_on);
  return (
    <section className={`card hero${days === 0 ? ' today' : ''}`} aria-label={days === 0 ? '今日のイベント' : '次のイベント'}>
      <small className="hero-when">{days === 0 ? '今日のイベント' : days === 1 ? '次のイベント・明日' : `次のイベント・${days}日後`}</small>
      <b className="hero-name">{ev.name}</b>
      <span className="k">{ev.held_on}{ev.space_no ? `・${ev.space_no}` : ''}{ev.venue ? `・${ev.venue}` : ''}</span>
      <Link className="btn primary center hero-go" to={`/events/${ev.id}/register`}>レジを開く</Link>
      {owner && (
        <span className="sub-links">
          <Link className="sub-link" to={`/events/${ev.id}/prepare`}>準備(持ち込み・釣り銭・経費)</Link>
          {invite && <Link className="sub-link" to={`/events/${ev.id}/invite`}>売り子を招待</Link>}
        </span>
      )}
    </section>
  );
}

const DISMISS_KEY = 'install-card-dismissed';

/** ホーム画面への追加の案内。入れておくと、会場で電波がなくても確実に開ける */
function InstallCard() {
  const install = useInstallPrompt();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (dismissed || isStandalone() || (!install && !isIos())) return null;
  const close = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* 次に開いたときにまた出るだけ */
    }
  };
  return (
    <section className="card install" aria-label="ホーム画面に追加">
      <b>ホーム画面に追加しておきましょう</b>
      <p className="note">アプリとして入れておくと、会場で電波がなくてもすぐ開けます。</p>
      {install ? (
        <div className="btns">
          <button className="sbtn acc" onClick={() => void install().then((ok) => ok && close())}>ホーム画面に追加</button>
          <button className="sbtn" onClick={close}>あとで</button>
        </div>
      ) : (
        <>
          <p className="k">Safari の共有ボタン(四角から矢印が出たアイコン)を押し、「ホーム画面に追加」を選んでください。</p>
          <button className="link-btn" onClick={close}>閉じる</button>
        </>
      )}
    </section>
  );
}
