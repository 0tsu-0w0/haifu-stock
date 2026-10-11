import { useState } from 'react';
import { APP_VERSION, BUILD_TIME, applyUpdate, useUpdateState } from '../app/update';

/** 新しい版の知らせ(#16)。「あとで」で閉じると、この画面を開いている間は出さない */
export function UpdateBanner() {
  const state = useUpdateState();
  const [later, setLater] = useState(false);
  if (state !== 'ready' || later) return null;
  return (
    <div className="update-banner" role="status">
      <span>新しい版があります</span>
      <button className="update-go" onClick={applyUpdate}>更新する</button>
      <button className="update-later" onClick={() => setLater(true)}>あとで</button>
    </div>
  );
}

/** 設定の下に出す、いま動いている版 */
export function AppVersion() {
  const state = useUpdateState();
  const built = new Date(BUILD_TIME);
  return (
    <p className="note app-version">
      いまの版: <span className="num">{APP_VERSION}</span>(
      {Number.isNaN(built.getTime()) ? '' : built.toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} に作成)
      {state !== 'none' && (
        <> ・新しい版があります <button className="link-btn" onClick={applyUpdate}>更新する</button></>
      )}
    </p>
  );
}
