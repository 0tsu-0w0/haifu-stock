// レジの画面で共有する決まりごと

/** 値引きの理由(カートの値引きと、長押しの「値引きして記録」で共通) */
export const DISCOUNT_REASONS = ['まとめ買い', '知り合い', 'おまけ', 'その他'] as const;
/** これ以上の部数は、記録の前に注意を出す */
export const MANY_QTY = 10;
