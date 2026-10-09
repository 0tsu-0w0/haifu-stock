import { useState } from 'react';

// この端末だけの表示の設定(端末のブラウザに保存する。同期はしない)

const KEYS = {
  /** レジに黒字化までの残り金額を出す(F-1108) */
  showBreakEven: 'pref-show-breakeven',
} as const;

type Pref = keyof typeof KEYS;
const DEFAULTS: Record<Pref, boolean> = { showBreakEven: true };

function read(p: Pref): boolean {
  try {
    const v = localStorage.getItem(KEYS[p]);
    return v === null ? DEFAULTS[p] : v === '1';
  } catch {
    return DEFAULTS[p];
  }
}

export function usePref(p: Pref): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => read(p));
  return [v, (next) => {
    setV(next);
    try {
      localStorage.setItem(KEYS[p], next ? '1' : '0');
    } catch {
      /* 保存できなければ、この画面の間だけ効く */
    }
  }];
}
