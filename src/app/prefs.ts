import { useState } from 'react';

// この端末だけの表示の設定(端末のブラウザに保存する。同期はしない)

const KEYS = {
  /** レジに黒字化までの残り金額を出す(F-1108) */
  showBreakEven: 'pref-show-breakeven',
  /** レジでタップしたらすぐ記録する(決済ボタンを使わない、以前の動き) */
  instantSale: 'pref-instant-sale',
  /** レジで完売した品目を末尾に回す */
  soldOutLast: 'pref-soldout-last',
  /** レジで残り1部の品目を赤で示す */
  lastOneRed: 'pref-last-one-red',
} as const;

type Pref = keyof typeof KEYS;
const DEFAULTS: Record<Pref, boolean> = { showBreakEven: true, instantSale: false, soldOutLast: false, lastOneRed: true };

/** 選ぶ形の設定。最初の値が既定 */
export const CHOICES = {
  /** 画面の明るさ。auto は端末の設定に合わせる */
  theme: ['auto', 'light', 'dark'],
  /** レジの文字とボタンの大きさ */
  regSize: ['normal', 'large'],
  /** レジの品目の列数 */
  regCols: ['2', '3'],
} as const;

type Choice = keyof typeof CHOICES;
type ChoiceValue<C extends Choice> = (typeof CHOICES)[C][number];

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* 保存できなければ、この画面の間だけ効く */
  }
}

function read(p: Pref): boolean {
  const v = load(KEYS[p]);
  return v === null ? DEFAULTS[p] : v === '1';
}

export function usePref(p: Pref): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => read(p));
  return [v, (next) => {
    setV(next);
    save(KEYS[p], next ? '1' : '0');
  }];
}

export function readChoice<C extends Choice>(c: C): ChoiceValue<C> {
  const v = load(`pref-${c}`);
  const list = CHOICES[c] as readonly string[];
  return (v !== null && list.includes(v) ? v : list[0]) as ChoiceValue<C>;
}

export function useChoice<C extends Choice>(c: C): [ChoiceValue<C>, (v: ChoiceValue<C>) => void] {
  const [v, setV] = useState(() => readChoice(c));
  return [v, (next) => {
    setV(next);
    save(`pref-${c}`, next);
    if (c === 'theme') applyTheme(next as ChoiceValue<'theme'>);
  }];
}

/** 画面の明るさを反映する。auto のときは印を外して、端末の設定(prefers-color-scheme)に任せる */
export function applyTheme(t: ChoiceValue<'theme'> = readChoice('theme')) {
  const root = document.documentElement;
  if (t === 'auto') delete root.dataset.theme;
  else root.dataset.theme = t;
}
