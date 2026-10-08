import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './app/AuthProvider';
import { SyncProvider } from './app/SyncProvider';
import { useCtx } from './app/useCtx';
import { ToastProvider } from './components/Toast';
import { ClosingPage } from './pages/ClosingPage';
import { EventPreparePage } from './pages/EventPreparePage';
import { HistoryPage } from './pages/HistoryPage';
import { ItemEditPage } from './pages/ItemEditPage';
import { ItemsPage } from './pages/ItemsPage';
import { HomePage } from './pages/HomePage';
import { InvitePage } from './pages/InvitePage';
import { JoinPage } from './pages/JoinPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { SetupPage } from './pages/SetupPage';

function Routed() {
  const ctx = useCtx();
  if (ctx === undefined) return null; // 端末のデータベースを読み込み中
  return (
    <Routes>
      {/* ログインと参加は、この端末にサークルがなくても開ける */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/join" element={<JoinPage />} />
      {ctx === null ? (
        <Route path="*" element={<SetupPage />} />
      ) : (
        <>
          <Route path="/" element={<HomePage />} />
          <Route path="/events/:eventId/register" element={<RegisterPage />} />
          <Route path="/events/:eventId/closing" element={<ClosingPage />} />
          <Route path="/events/:eventId/history" element={<HistoryPage />} />
          <Route path="/events/new" element={<EventPreparePage />} />
          <Route path="/events/:eventId/prepare" element={<EventPreparePage />} />
          <Route path="/items" element={<ItemsPage />} />
          <Route path="/items/new" element={<ItemEditPage />} />
          <Route path="/items/:itemId" element={<ItemEditPage />} />
          <Route path="/events/:eventId/invite" element={<InvitePage />} />
          <Route path="*" element={<HomePage />} />
        </>
      )}
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <SyncProvider>
            <div className="app">
              <Routed />
            </div>
          </SyncProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
