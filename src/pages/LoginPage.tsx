import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { afterOwnerLogin, selectCircle, type CircleChoice } from '../auth/account';
import { useAuth } from '../app/AuthProvider';
import { db } from '../app/db';
import { isIos, isStandalone } from '../app/install';
import { useSync } from '../app/SyncProvider';
import { useToast } from '../components/Toast';
import { getMeta, setMeta } from '../db/local';
import { authCodeInUrl } from '../sync/supabaseRemote';

// Google やメールのリンクから戻ってきたら、ログイン後の処理を続けるための印(1時間で無効)
const PENDING_KEY = 'pending_login';
const PENDING_MS = 60 * 60 * 1000;
// Supabase は同じアドレスに60秒以内に続けて送れない
const RESEND_SEC = 60;
const EMAIL_KEY = 'login-email';

const savedEmail = () => {
  try {
    return localStorage.getItem(EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
};

/** Google から戻ってきたときの URL に付くエラー(取り消したときなど) */
function oauthError(): string | null {
  const q = new URLSearchParams(window.location.search);
  const h = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const m = q.get('error_description') ?? h.get('error_description');
  if (!m) return null;
  if (/provider is not enabled/i.test(m)) return 'Google でのログインが有効になっていません';
  if (/expired|invalid/i.test(m)) {
    return 'メールのリンクが、期限切れか使用済みでした。メールのリンクを安全確認する機能(セキュリティソフトやブラウザの拡張機能、メールアプリのリンクの確認)が、先にリンクを開いてしまうことがあります。その場合は、その機能を Gmail で切るか、メールに書かれたコードでログインしてください';
  }
  if (/access_denied|cancel/i.test(m + (q.get('error') ?? ''))) return 'ログインを取りやめました';
  return `ログインできませんでした(${m})`;
}

// サークル主のログイン。Google のアカウントか、メールに書かれたコード(Supabase の設定で6〜10桁)で入る。リンクのメールにも対応する。
// リンクが別のブラウザで開いても、そのブラウザでログインを済ませ、サーバーのサークルを使う
export function LoginPage() {
  const { configured, backend, session } = useAuth();
  const { syncNow } = useSync();
  const navigate = useNavigate();
  const toast = useToast();
  const [email, setEmail] = useState(savedEmail);
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [choices, setChoices] = useState<CircleChoice[] | null>(null);
  const [googleOn, setGoogleOn] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const resumed = useRef(false);
  const loggedIn = !!session && !session.user.is_anonymous;

  // もう一度送れるまでの残り秒数を出すため、送ったあとは1秒ごとに描き直す
  useEffect(() => {
    if (!sentAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [sentAt]);
  const waitSec = sentAt ? Math.max(0, RESEND_SEC - Math.floor((now - sentAt) / 1000)) : 0;

  // メールを送って待っている間に、別のタブでリンクが開かれてログインが済んだら、ホームへ進む
  useEffect(() => {
    if (!sent || !loggedIn || resumed.current) return;
    void (async () => {
      if ((await getMeta<string>(db, 'user_id')) !== session!.user.id || resumed.current) return;
      toast('ログインしました');
      navigate('/');
    })();
  }, [sent, loggedIn]);

  useEffect(() => {
    let alive = true;
    void backend?.googleEnabled().then((on) => alive && setGoogleOn(on));
    return () => { alive = false; };
  }, [backend]);

  // Google やメールのリンクから戻ってきたら、コードで入ったときと同じ後処理をする。
  // 印がなくても、この端末がまだそのユーザーになっていなければ(別のブラウザでリンクを開いたとき)続ける
  useEffect(() => {
    const err = oauthError();
    if (err) {
      setError(err);
      void setMeta(db, PENDING_KEY, null);
      window.history.replaceState(null, '', '/login');
      return;
    }
    if (authCodeInUrl && session === null && !resumed.current) {
      setError('このリンクは、ログインのメールを送ったのと同じブラウザで開いてください(ホーム画面に追加したアプリから送った場合は、そのアプリで)。もう一度メールを送ってください');
      window.history.replaceState(null, '', '/login');
      return;
    }
    if (!backend || !session || session.user.is_anonymous || resumed.current) return;
    void (async () => {
      const at = await getMeta<number>(db, PENDING_KEY);
      const pending = !!at && Date.now() - at <= PENDING_MS;
      const adopted = (await getMeta<string>(db, 'user_id')) === session.user.id;
      if ((!pending && adopted) || resumed.current) return;
      resumed.current = true;
      await setMeta(db, PENDING_KEY, null);
      await run(() => completeLogin(session.user.id));
    })();
  }, [backend, session]);

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
    await setMeta(db, PENDING_KEY, Date.now());
    await backend.sendCode(v, `${window.location.origin}/login`);
    try {
      localStorage.setItem(EMAIL_KEY, v);
    } catch {
      /* 次に開いたときに入れ直すだけ */
    }
    setSent(true);
    setSentAt(Date.now());
    setNow(Date.now());
  });

  async function completeLogin(userId: string) {
    const r = await afterOwnerLogin(db, backend!, userId);
    if (r.kind === 'choose') setChoices(r.circles);
    else if (r.kind === 'none') navigate('/'); // サークルを作る画面に進む
    else await finish();
  }

  const verify = () => run(async () => {
    const c = code.replace(/\s/g, '');
    if (!/^\d{6,10}$/.test(c)) throw new Error('メールに届いたコード(数字)を、全部入れてください');
    const { userId } = await backend.verifyCode(email.trim(), c);
    await completeLogin(userId);
  });

  const google = () => run(async () => {
    await setMeta(db, PENDING_KEY, Date.now());
    await backend.signInWithGoogle(`${window.location.origin}/login`);
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

  // ログイン済み: メールを送る欄は出さず、ホームへ戻る道を大きく出す
  if (loggedIn && !switching && !sent) {
    return (
      <main className="page">
        <h1>ログイン</h1>
        <div className="card form">
          <p><b>{session!.user.email}</b> でログインしています。</p>
          {error && <p className="error">{error}</p>}
          <Link className="btn primary center" to="/">ホームに戻る</Link>
          <button className="link-btn" onClick={() => { setSwitching(true); setEmail(''); }}>別のアカウントでログインする</button>
        </div>
        <p className="note">ログアウトは、設定画面のいちばん下からできます。ログアウトしても、この端末の記録は消えません。</p>
      </main>
    );
  }

  return (
    <main className="page">
      <h1>{switching ? '別のアカウントでログイン' : 'ログイン'}</h1>
      <p className="lead">
        ログインすると、売り子の端末と記録を共有できます。この端末で記録したデータは、ログインしても消えません。
      </p>
      {googleOn && !sent && (
        <div className="card form">
          <button className="btn google" disabled={busy} onClick={() => void google()}>
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" />
              <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z" />
              <path fill="#FBBC05" d="M10.6 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.8l7.9-6.1z" />
              <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.1 1.4-4.9 2.3-8.2 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
            </svg>
            Google でログイン
          </button>
          {isIos() && isStandalone() && (
            <p className="note">ホーム画面のアプリからだと、ログインのあと Safari に戻ってしまうことがあります。そのときは下のメールのコードでログインしてください。</p>
          )}
        </div>
      )}
      {googleOn && !sent && <p className="or">または、メールでログイン</p>}
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
          <button className="btn primary" disabled={busy}>{busy ? '送信中…' : 'ログインのメールを送る'}</button>
        </form>
      ) : (
        <form className="card form" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
          <p><b>{email}</b> にログインのメールを送りました。</p>
          <p className="note">メールに書かれたコード(数字)を、全部入れてください。コードは1回だけ、しばらくの間だけ使えます。もう一度メールを送ったときは、いちばん新しいメールのコードを使います。</p>
          <label htmlFor="code">コード</label>
          <input
            id="code"
            className="code-input num"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={10}
            value={code}
            onChange={(e) => { setCode(e.target.value.replace(/\D/g, '')); setError(''); }}
            placeholder="12345678"
          />
          {error && <p className="error">{error}</p>}
          <button className="btn primary" disabled={busy}>{busy ? '確認中…' : 'ログイン'}</button>
          <button type="button" className="btn" disabled={busy || waitSec > 0} onClick={() => void sendCode()}>
            {waitSec > 0 ? `メールをもう一度送る(あと${waitSec}秒)` : 'メールをもう一度送る'}
          </button>
          <button type="button" className="link-btn" onClick={() => { setSent(false); setCode(''); setError(''); }}>メールアドレスを入れ直す</button>
          <p className="note">
            届かないときは、迷惑メールのフォルダも見てください。メールにリンクが書かれている場合は、<b>この端末のこのブラウザ</b>でリンクを開いてもログインできます。
          </p>
        </form>
      )}
      <Link className="link-btn" to="/">{switching ? 'やめてホームに戻る' : 'ログインせずに戻る'}</Link>
    </main>
  );
}
