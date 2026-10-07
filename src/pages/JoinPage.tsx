import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { joinWithInvite } from '../auth/account';
import { useAuth } from '../app/AuthProvider';
import { db } from '../app/db';
import { useSync } from '../app/SyncProvider';
import { useToast } from '../components/Toast';

// 売り子の参加(F-1005)。サークル主のQRコードを読むとこの画面が開く。登録は不要
export function JoinPage() {
  const { configured, backend } = useAuth();
  const { syncNow } = useSync();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const token = typeof location !== 'undefined' ? location.hash.slice(1) : '';

  if (!configured || !backend) {
    return (
      <main className="page">
        <h1>売り子として参加</h1>
        <p className="lead">このアプリには同期先が設定されていないため、参加できません。</p>
      </main>
    );
  }

  async function join() {
    setError('');
    setBusy(true);
    try {
      const eventId = await joinWithInvite(db, backend!, token);
      // URLからトークンを消しておく(画面共有などで見えないように)
      history.replaceState(null, '', '/join');
      toast(await syncNow());
      navigate(`/events/${eventId}/register`, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <h1>売り子として参加</h1>
      <p className="lead">サークル主から招待されています。参加すると、このスマホでレジに記録できるようになります。メールアドレスやパスワードの登録はいりません。</p>
      {!token && <p className="error">招待のリンクが正しくありません。サークル主にQRコードをもう一度見せてもらってください。</p>}
      {error && <p className="error">{error}</p>}
      <button className="btn primary" disabled={busy || !token} onClick={() => void join()}>
        {busy ? '参加しています…' : '参加する'}
      </button>
      <p className="note">参加には通信が必要です。参加したあとは、電波がなくても記録できます。</p>
      <Link className="link-btn" to="/">参加せずに戻る</Link>
    </main>
  );
}
