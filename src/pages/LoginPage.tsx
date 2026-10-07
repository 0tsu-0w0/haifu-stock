import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { afterOwnerLogin, selectCircle, type CircleChoice } from '../auth/account';
import { useAuth } from '../app/AuthProvider';
import { db } from '../app/db';
import { useSync } from '../app/SyncProvider';
import { useToast } from '../components/Toast';

// サークル主のログイン。メールに届く6桁のコードを入れる方式
// (ホーム画面に追加したアプリでも、メールのリンクを開かずにログインできる)
export function LoginPage() {
  const { configured, backend, session } = useAuth();
  const { syncNow } = useSync();
  const navigate = useNavigate();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [choices, setChoices] = useState<CircleChoice[] | null>(null);

  if (!configured || !backend) {
    return (
      <main className="page">
        <h1>ログイン</h1>
        <p className="lead">同期先が設定されていないため、ログインは使えません。記録はこの端末に保存されます。</p>
        <Link className="btn center" to="/">戻る</Link>
      </main>
    );
  }

  async function run(fn: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    toast(await syncNow());
    navigate('/');
  }

  const sendCode = () => run(async () => {
    const v = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error('メールアドレスを正しく入れてください');
    await backend.sendCode(v);
    setSent(true);
  });

  const verify = () => run(async () => {
    const c = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(c)) throw new Error('メールに届いた6桁の数字を入れてください');
    const { userId } = await backend.verifyCode(email.trim(), c);
    const r = await afterOwnerLogin(db, backend, userId);
    if (r.kind === 'choose') setChoices(r.circles);
    else if (r.kind === 'none') navigate('/'); // サークルを作る画面に進む
    else await finish();
  });

  if (choices) {
    return (
      <main className="page">
        <h1>サークルを選ぶ</h1>
        <p className="lead">このアカウントには複数のサークルがあります。この端末で使うサークルを選んでください。</p>
        <ul className="list">
          {choices.map((c) => (
            <li key={c.circleId}>
              <button className="card row-link wide" onClick={() => run(async () => { await selectCircle(db, c.circleId); await finish(); })}>
                <b>{c.name}</b><span className="go-label">使う</span>
              </button>
            </li>
          ))}
        </ul>
      </main>
    );
  }

  return (
    <main className="page">
      <h1>ログイン</h1>
      {session && !session.user.is_anonymous && (
        <p className="note">{session.user.email} でログインしています。別のアカウントに切り替えるときは、もう一度ログインしてください。</p>
      )}
      <p className="lead">
        ログインすると、売り子の端末と記録を共有できます。この端末で記録したデータは、ログインしても消えません。
      </p>
      {!sent ? (
        <form className="card form" onSubmit={(e) => { e.preventDefault(); void sendCode(); }}>
          <label htmlFor="email">メールアドレス</label>
          <input
            id="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(''); }}
            placeholder="name@example.com"
          />
          {error && <p className="error">{error}</p>}
          <button className="btn primary" disabled={busy}>{busy ? '送信中…' : 'コードを送る'}</button>
        </form>
      ) : (
        <form className="card form" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
          <p className="note">{email} に6桁のコードを送りました。メールを開いて、コードを入れてください。</p>
          <label htmlFor="code">コード</label>
          <input
            id="code"
            className="code-input num"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => { setCode(e.target.value.replace(/\D/g, '')); setError(''); }}
            placeholder="123456"
          />
          {error && <p className="error">{error}</p>}
          <button className="btn primary" disabled={busy}>{busy ? '確認中…' : 'ログイン'}</button>
          <button type="button" className="link-btn" onClick={() => { setSent(false); setCode(''); }}>メールアドレスを入れ直す</button>
        </form>
      )}
      <Link className="link-btn" to="/">ログインせずに戻る</Link>
    </main>
  );
}
