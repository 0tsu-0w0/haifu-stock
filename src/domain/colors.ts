// 品目の色(レジで見分けるため)。名前だけを保存し、実際の色は画面の明るさに合わせて CSS の --tag-* で決める。
// 色だけに頼らず、品目名はいつも出す

export const ITEM_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const;
export type ItemColor = (typeof ITEM_COLORS)[number];

export const COLOR_LABEL: Record<ItemColor, string> = {
  red: '赤', orange: 'オレンジ', yellow: '黄', green: '緑', teal: '青緑', blue: '青', purple: '紫', pink: 'ピンク',
};

export const isItemColor = (v: unknown): v is ItemColor => typeof v === 'string' && (ITEM_COLORS as readonly string[]).includes(v);

/** style に渡す CSS 変数。色がなければ undefined */
export const colorVar = (c: string | null | undefined) => (isItemColor(c) ? `var(--tag-${c})` : undefined);
