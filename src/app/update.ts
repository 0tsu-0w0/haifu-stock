import { useSyncExternalStore } from 'react';
import { registerSW } from 'virtual:pwa-register';

// 新しい版の知らせと更新(#16)。新しい版を受け取ったら知らせ、押したときだけ更新する。
// 押さなくても、アプリをすべて閉じてから開き直せば新しい版になる。レジで会計の途中は知らせない

/** いま動いている版(コミットの短い番号)と、作った日時 */
export const APP_VERSION: string = __APP_VERSION__;
export const BUILD_TIME: string = __BUILD_TIME__;

/** 新しい版があるかを調べる間隔 */
const CHECK_MS = 30 * 60_000;

let available = false;
let blocked = false;
let apply: ((reload?: boolean) => Promise<void>) | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

/** 画面と資源を端末に置き(オフラインでも開ける)、新しい版を見張る。起動時に1回だけ呼ぶ */
export function startUpdates() {
  apply = registerSW({
    immediate: true,
    onNeedRefresh() {
      available = true;
      emit();
    },
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      const check = () => {
        if (navigator.onLine) void reg.update().catch(() => { /* 次に調べたときにまた試す */ });
      };
      setInterval(check, CHECK_MS);
      // スマホでアプリに戻ってきたときにも調べる
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    },
  });
}

/** 新しい版に切り替えて読み込み直す */
export function applyUpdate() {
  void apply?.(true);
}

/** レジで会計の途中など、読み込み直すと困る間は知らせない */
export function setUpdateBlocked(v: boolean) {
  if (blocked === v) return;
  blocked = v;
  emit();
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};
const snapshot = () => (available ? (blocked ? 'blocked' : 'ready') : 'none');

/** 'none': 新しい版はない / 'ready': 更新できる / 'blocked': あるが、いまは知らせない */
export function useUpdateState(): 'none' | 'ready' | 'blocked' {
  return useSyncExternalStore(subscribe, snapshot, () => 'none');
}
