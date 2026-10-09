import { useEffect, useState } from 'react';

interface Sentinel {
  release: () => Promise<void>;
  addEventListener: (type: 'release', fn: () => void) => void;
}

/**
 * 画面を消さない(Screen Wake Lock)。レジを開いている間だけ使う。
 * アプリを裏に回すとブラウザが自動で解除するので、戻ってきたらもう一度かける。
 * 使えないブラウザでは何もしない(戻り値 false)
 */
export function useWakeLock(enabled: boolean): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const api = (navigator as { wakeLock?: { request: (t: 'screen') => Promise<Sentinel> } }).wakeLock;
    if (!enabled || !api) return;
    let sentinel: Sentinel | null = null;
    let disposed = false;
    const acquire = async () => {
      if (document.visibilityState !== 'visible' || sentinel) return;
      try {
        const s = await api.request('screen');
        if (disposed) {
          void s.release();
          return;
        }
        sentinel = s;
        setActive(true);
        s.addEventListener('release', () => {
          sentinel = null;
          setActive(false);
        });
      } catch {
        setActive(false); // 省電力モードなどで断られたときは、そのまま
      }
    };
    void acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', acquire);
      void sentinel?.release();
    };
  }, [enabled]);
  return active;
}
