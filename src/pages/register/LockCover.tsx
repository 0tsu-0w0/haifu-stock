import { useEffect, useRef, useState } from 'react';

const UNLOCK_MS = 800;

/** 画面のロック(F-410)。カバンやポケットの中での誤タップを防ぐ。長押しで解除する */
export function LockCover(props: { title: string; sales: string; count: number; onUnlock: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [holding, setHolding] = useState(false);
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <div className="lock-cover" role="dialog" aria-modal="true" aria-label="画面はロック中です" onContextMenu={(e) => e.preventDefault()}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
      <b>ロック中</b>
      <p className="k">{props.title}</p>
      <p className="lock-sum"><span className="num">{props.sales}</span><small>{props.count}部</small></p>
      <button
        className={`unlock${holding ? ' holding' : ''}`}
        onPointerDown={() => {
          setHolding(true);
          timer.current = setTimeout(() => { stop(); props.onUnlock(); }, UNLOCK_MS);
        }}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
        onKeyDown={(e) => { if (e.key === 'Enter') props.onUnlock(); }}
      >
        <span>長押しで解除</span>
      </button>
    </div>
  );
}
