import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import './app/install';
import { db } from './app/db';
import { ensureIdentity } from './domain/setup';
import './styles.css';

// 画面と資源を端末に置き、オフラインでも開けるようにする。新しい版は次に開いたときに反映される
registerSW({ immediate: true });

await ensureIdentity(db);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
