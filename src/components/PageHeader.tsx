import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * 画面の上に固定する見出し。左に大きな「戻る」ボタン(指で押しやすい 44px 以上)を置く。
 * スクロールしても上に残るので、いつでも1タップで戻れる
 */
export function PageHeader(props: { title: string; sub?: string; back?: string; backLabel?: string; right?: ReactNode; below?: ReactNode }) {
  const { title, sub, back = '/', backLabel = 'ホーム', right, below } = props;
  return (
    <header className="phead">
      <Link className="back-btn" to={back} aria-label={`${backLabel}に戻る`}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        <span>{backLabel}</span>
      </Link>
      <div className="phead-title">
        <b>{title}</b>
        {sub && <span>{sub}</span>}
      </div>
      {right}
      {below && <div className="phead-below">{below}</div>}
    </header>
  );
}
