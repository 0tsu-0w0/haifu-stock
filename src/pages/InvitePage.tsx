import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { createInvite, type InviteRow } from '../auth/account';
import { useAuth } from '../app/AuthProvider';
import { db } from '../app/db';
import { useSync } from '../app/SyncProvider';
import { useCtx } from '../app/useCtx';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { hhmm } from '../lib/format';

// 売り子の招待(F-1005)。QRコードを売り子のスマホで読んでもらう。招待はイベント単位で、期限つき
export function InvitePage() {
  const { eventId = '' } = useParams();
  const ctx = useCtx();
  const { configured, backend, session, role } = useAuth();
  const { syncNow, pending } = useSync();
  const toast = useToast();
  const [hours, setHours] = useState(24);
  const [current, setCurrent] = useState<{ url: string; qr: string; expiresAt: string } | null>(null);
  const [invites, setInvites] = useState<InviteRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loggedIn = !!session && !session.user.is_anonymous;

  const refresh = async () => {
    if (!backend || !loggedIn) return;
    try {
      setInvites(await backend.listInvites(eventId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void refresh();
  }, [eventId, loggedIn]); // eventId とログイン状態が変わったときだけ読み直す

  const back = <Link className="link-btn" to="/">ホームに戻る</Link>;

  if (!configured || !backend) {
    return <main className="page"><h1>売り子を招待</h1><p className="lead">同期先が設定されていないため、売り子を招待できません。</p>{back}</main>;
  }
  if (role === 'staff') {
    return <main className="page"><h1>売り子を招待</h1><p className="lead">招待できるのはサークル主だけです。</p>{back}</main>;
  }
  if (!loggedIn) {
    return (
      <main className="page">
        <h1>売り子を招待</h1>
        <p className="lead">売り子を招待するには、先にログインしてください。</p>
        <Link className="btn primary center" to="/login">ログインする</Link>
        {back}
      </main>
    );
  }

  async function issue() {
    if (!ctx) return;
    setError('');
    setBusy(true);
    try {
      // 売り子がイベントと品目を受け取れるよう、先にこの端末の記録をサーバーへ送っておく
      if (pending > 0) await syncNow();
      if ((await db.outbox.count()) > 0) throw new Error('この端末の記録をまだ送れていません。通信できる場所で同期してから招待してください');
      const r = await createInvite(backend!, ctx, eventId, { origin: location.origin, hours });
      const qr = await QRCode.toDataURL(r.url, { margin: 1, width: 560, errorCorrectionLevel: 'M' });
      setCurrent({ url: r.url, qr, expiresAt: r.invite.expires_at });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast('招待のリンクをコピーしました');
    } catch {
      toast('コピーできませんでした。リンクを長押しして選んでください');
    }
  }

  return (
    <main className="page">
      <PageHeader title="売り子を招待" sub="QRコードを売り子のスマホで読んでもらいます" />

      {current ? (
        <div className="card invite">
          <img className="qr" src={current.qr} alt="売り子用の招待のQRコード" />
          <p className="note">{new Date(current.expiresAt).toLocaleDateString('ja-JP')} {hhmm(current.expiresAt)} まで有効です。</p>
          <code className="invite-url">{current.url}</code>
          <div className="btns">
            <button className="sbtn" onClick={() => void copy(current.url)}>リンクをコピー</button>
            <button className="sbtn" onClick={() => setCurrent(null)}>閉じる</button>
          </div>
          <p className="note">このQRコードを読んだ人は、誰でもこのイベントの売り子になれます。人に見せたままにしないでください。</p>
        </div>
      ) : (
        <div className="card form">
          <label htmlFor="hours">有効な時間</label>
          <select id="hours" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            <option value={6}>6時間</option>
            <option value={24}>24時間</option>
            <option value={72}>3日間</option>
          </select>
          {error && <p className="error">{error}</p>}
          <button className="btn primary" disabled={busy} onClick={() => void issue()}>{busy ? '作成中…' : '招待のQRコードを出す'}</button>
          <p className="note">招待を作るには通信が必要です。売り子が参加したあとは、電波がなくても記録できます。</p>
        </div>
      )}

      <h3 className="section">有効な招待</h3>
      <div className="card">
        {invites === null && <span className="k">読み込み中…</span>}
        {invites?.length === 0 && <span className="k">ありません</span>}
        {invites?.map((inv) => (
          <div className="rowx" key={inv.id}>
            <span className="k">{new Date(inv.expires_at).toLocaleDateString('ja-JP')} {hhmm(inv.expires_at)} まで</span>
            <button
              className="sbtn danger"
              onClick={async () => {
                try {
                  await backend.revokeInvite(inv.id);
                  toast('招待を取り消しました。すでに参加した売り子は、期限まで記録できます');
                  if (current) setCurrent(null);
                  await refresh();
                } catch (e) {
                  toast(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              取り消す
            </button>
          </div>
        ))}
      </div>
      {back}
    </main>
  );
}
