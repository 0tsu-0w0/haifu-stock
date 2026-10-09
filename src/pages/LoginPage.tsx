import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { afterOwnerLogin, selectCircle, type CircleChoice } from '../auth/account';
import { useAuth } from '../app/AuthProvider';
import { db } from '../app/db';
import { isIos, isStandalone } from '../app/install';
import { useSync } from '../app/SyncProvider';
import { useToast } from '../components/Toast';
import { getMeta, setMeta } from '../db/local';

// Google やメールのリンクから戻ってきたら、ログイン後の処理を続けるための印(1時間で無効)
const PENDING_KEY = 'pending_login';
const PENDING_MS = 60 * 60 * 1000;

/** Google から戻ってきたときの URL に付くエラー(取り消したときなど) */
function oauthError(): string | null {
  const q = new URLSearchParams(window.location.search);
  const h = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const m = q.get('error_description') ?? h.get('error_description');
  if (!m) return null;
  if (/provider is not enabled/i.test(m)) return 'Google でのログインが有効になっていません';
  if (/expired|invalid/i.test(m)) return 'メールのリンクの期限が切れているか、もう使われています。もう一度メールを送ってください';
  if (/access_denied|cancel/i.test(m + (q.get('error') ?? ''))) return 'ログインを取りやめました';
  return `ログインできませんでした(${m})`;
}

// サークル主のログイン。Google のアカウントか、メールのリンク(またはメールに書かれた6桁のコード)で入る。
// リンクが別のブラウザで開いても、そのブラウザでログインを済ませ、サーバーのサークルを使う
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
  const [googleOn, setGoogleOn] = useState(false);
  const resumed = useRef(false);

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
    setSent(true);
  });

  async function completeLogin(userId: string) {
    const r = await afterOwnerLogin(db, backend!, userId);
    if (r.kind === 'choose') setChoices(r.circles);
    else if (r.kind === 'none') navigate('/'); // サークルを作る画面に進む
    else await finish();
  }

  const verify = () => run(async () => {
    const c = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(c)) throw new Error('メールに届いた6桁の数字を入れてください');
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

  return (
    <main className="page">
      <h1>ログイン</h1>
      {session && !session.user.is_anonymous && (
        <p className="note">{session.user.email} でログインしています。別のアカウントに切り替えるときは、もう一度ログインしてください。</p>
      )}
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
          <p className="note">
            メールの「Confirm」や「Log In」のリンクを、<b>この端末のこのブラウザ</b>で開くとログインできます。
            ほかのブラウザで開いてもログインはできますが、この端末でログインの前に記録した分は、このブラウザでログインするまで送られません。
          </p>
          <p className="note">届かないときは、迷惑メールのフォルダも見てください。続けて送ると、しばらく送れなくなることがあります。</p>
          <label htmlFor="code">メールに6桁のコードが書かれているときは、ここに入れてもログインできます</label>
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
