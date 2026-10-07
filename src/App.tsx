import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { SyncProvider } from './app/SyncProvider';
import { useCtx } from './app/useCtx';
import { ToastProvider } from './components/Toast';
import { ClosingPage } from './pages/ClosingPage';
import { HomePage } from './pages/HomePage';
import { RegisterPage } from './pages/RegisterPage';
import { SetupPage } from './pages/SetupPage';

function Routed() {
  const ctx = useCtx();
  if (ctx === undefined) return null; // 端末のデータベースを読み込み中
  if (ctx === null) return <SetupPage />;
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/events/:eventId/register" element={<RegisterPage />} />
      <Route path="/events/:eventId/closing" element={<ClosingPage />} />
      <Route path="*" element={<HomePage />} />
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <SyncProvider>
          <div className="app">
            <Routed />
          </div>
        </SyncProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
