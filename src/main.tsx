import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './app/install';
import { db } from './app/db';
import { applyTheme } from './app/prefs';
import { startUpdates } from './app/update';
import { ensureIdentity } from './domain/setup';
import './styles.css';

// 画面と資源を端末に置き、オフラインでも開けるようにする。新しい版が届いたら知らせる(#16)
startUpdates();

// 設定で選んだ画面の明るさを、最初の描画の前に反映する
applyTheme();

await ensureIdentity(db);

try {
  sessionStorage.removeItem('chunk-reloaded');
} catch {
  /* なくても動く */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
