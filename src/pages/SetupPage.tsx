import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../app/AuthProvider';
import { db } from '../app/db';
import { createCircle } from '../domain/setup';

// 初回起動時の設定(F-1009)
export function SetupPage() {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { configured } = useAuth();

  async function start() {
    setError('');
    const n = name;
    if (!n.trim()) {
      setError('サークル名を入れてください');
      return;
    }
    setBusy(true);
    try {
      await createCircle(db, n);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <main className="page setup">
      <h1>頒布レジ</h1>
      <p className="lead">イベントでの頒布の記録と、在庫・売上の集計をするアプリです。まずサークル名を入れてください。</p>
      <form
        className="card form"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <label htmlFor="circle-name">サークル名</label>
        <input
          id="circle-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError('');
          }}
          placeholder="サークル夜行列車"
          autoComplete="off"
        />
        {error && <p className="error">{error}</p>}
        <button className="btn primary" disabled={busy}>始める</button>
      </form>
      <p className="note">データはこの端末に保存されます。あとからログインすると、売り子の端末と同期できます。</p>
      {configured && (
        <div className="card">
          <p className="note">ほかの端末でサークルを作ってある場合は、ログインするとそのデータを使えます。売り子として参加する場合は、サークル主が出すQRコードを読んでください。</p>
          <Link className="btn center" to="/login">ログインして始める</Link>
        </div>
      )}
    </main>
  );
}
