import { useSyncExternalStore } from 'react';

// ホーム画面への追加(PWA)。ブラウザの「インストールできます」の合図は起動直後に一度だけ来るので、
// 画面ができる前から受け取っておく

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

/** iPhone・iPad の Safari は合図を出さないので、手順を文章で案内する */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function useInstallPrompt(): (() => Promise<boolean>) | null {
  const ev = useSyncExternalStore(
    (f) => { listeners.add(f); return () => listeners.delete(f); },
    () => deferred,
    () => null,
  );
  if (!ev) return null;
  return async () => {
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    deferred = null;
    notify();
    return outcome === 'accepted';
  };
}
