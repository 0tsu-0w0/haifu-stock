import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './app/AuthProvider';
import { SyncProvider } from './app/SyncProvider';
import { useCtx } from './app/useCtx';
import { ToastProvider } from './components/Toast';
import { HomePage } from './pages/HomePage';
import { RegisterPage } from './pages/RegisterPage';
import { SetupPage } from './pages/SetupPage';

/** 画面のファイルを読む。新しい版の公開で古いファイルが消えていたら、1回だけページを読み直して新しい版にする */
function retry<T>(load: () => Promise<T>): Promise<T> {
  return load().catch((e: unknown) => {
    const key = 'chunk-reloaded';
    let reloaded = false;
    try {
      reloaded = sessionStorage.getItem(key) === '1';
      sessionStorage.setItem(key, '1');
    } catch {
      /* 保存できなくても続ける */
    }
    if (!reloaded) {
      window.location.reload();
      return new Promise<T>(() => {});
    }
    throw e;
  });
}

// ホーム・レジ・最初の設定以外の画面は、開いたときに読み込む(最初の起動を軽くする)。
// PWA は全部を端末に保存しているので、オフラインでも開ける
const AnalysisPage = lazy(() => retry(() => import('./pages/AnalysisPage').then((m) => ({ default: m.AnalysisPage }))));
const ClosingPage = lazy(() => retry(() => import('./pages/ClosingPage').then((m) => ({ default: m.ClosingPage }))));
const EventPreparePage = lazy(() => retry(() => import('./pages/EventPreparePage').then((m) => ({ default: m.EventPreparePage }))));
const HistoryPage = lazy(() => retry(() => import('./pages/HistoryPage').then((m) => ({ default: m.HistoryPage }))));
const ItemEditPage = lazy(() => retry(() => import('./pages/ItemEditPage').then((m) => ({ default: m.ItemEditPage }))));
const ItemsPage = lazy(() => retry(() => import('./pages/ItemsPage').then((m) => ({ default: m.ItemsPage }))));
const InvitePage = lazy(() => retry(() => import('./pages/InvitePage').then((m) => ({ default: m.InvitePage }))));
const JoinPage = lazy(() => retry(() => import('./pages/JoinPage').then((m) => ({ default: m.JoinPage }))));
const LoginPage = lazy(() => retry(() => import('./pages/LoginPage').then((m) => ({ default: m.LoginPage }))));
const ReportPage = lazy(() => retry(() => import('./pages/ReportPage').then((m) => ({ default: m.ReportPage }))));
const SettingsPage = lazy(() => retry(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage }))));
const StocktakePage = lazy(() => retry(() => import('./pages/StocktakePage').then((m) => ({ default: m.StocktakePage }))));

function Routed() {
  const ctx = useCtx();
  if (ctx === undefined) return null; // 端末のデータベースを読み込み中
  return (
    <Suspense fallback={<main className="page" />}>
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
          <Route path="/events/:eventId/report" element={<ReportPage />} />
          <Route path="/events/new" element={<EventPreparePage />} />
          <Route path="/events/:eventId/prepare" element={<EventPreparePage />} />
          <Route path="/items" element={<ItemsPage />} />
          <Route path="/analysis" element={<AnalysisPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/stocktake" element={<StocktakePage />} />
          <Route path="/items/new" element={<ItemEditPage />} />
          <Route path="/items/:itemId" element={<ItemEditPage />} />
          <Route path="/events/:eventId/invite" element={<InvitePage />} />
          <Route path="*" element={<HomePage />} />
        </>
      )}
    </Routes>
    </Suspense>
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
