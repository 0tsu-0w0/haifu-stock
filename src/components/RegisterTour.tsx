import { useEffect, useRef, useState } from 'react';

// レジの使い方の短い説明。招待から入ったスタッフの端末で、最初にレジを開いたときに1回だけ出す。
// 設定の「レジの使い方を見る」からいつでも見直せる

const SEEN_KEY = 'register-tour-seen';

export function tourSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true; // 保存できない端末で毎回出さない
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* 保存できなくても閉じられる */
  }
}

function steps(instant: boolean): { title: string; body: string[] }[] {
  return [
    instant
      ? { title: 'タップで1部記録', body: ['品目のボタンをタップすると、その場で1部の販売を記録します。', 'まとめ買いは、下の「カート」から入れて「記録する」を押します。'] }
      : { title: 'タップでカートに入れる', body: ['品目のボタンをタップすると、カートに1部入ります。', 'もう一度タップすると1部増えます。カートの「−」で減らせます。'] },
    instant
      ? { title: 'お釣りの計算', body: ['カートで「ちょうど」や「¥1,000」などの預かり金額を押すと、お釣りと渡す硬貨・お札が出ます。'] }
      : { title: '「決済」で記録', body: ['お客さんに合計を伝えたら、下の「決済」を押すと記録されます。', '預かり金額(「ちょうど」「¥1,000」など)を押すと、お釣りと渡す硬貨・お札が出ます。'] },
    { title: '長押しでメニュー', body: ['品目を長押しすると、部数の指定・値引きして記録・見本誌や献本の記録ができます。', '完売した品目も、長押しから記録できます。'] },
    { title: 'まちがえたとき', body: ['記録した直後に出る「元に戻す」を押すか、下の「取り消し」を2回押すと、最後の記録を取り消せます。', '席を離れるときは、右上のカギで画面をロックします(長押しで解除)。'] },
  ];
}

export function RegisterTour({ instant, onClose }: { instant: boolean; onClose: () => void }) {
  const list = steps(instant);
  const [i, setI] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [i]);
  const close = () => {
    markSeen();
    onClose();
  };
  const last = i === list.length - 1;
  const s = list[i];
  return (
    <div className="scrim tour-scrim">
      <div className="sheet tour" role="dialog" aria-modal="true" aria-label="レジの使い方">
        <div className="tour-head">
          <span className="k">レジの使い方 {i + 1}/{list.length}</span>
          <button className="link-btn" onClick={close}>{last ? '閉じる' : 'あとで見る'}</button>
        </div>
        <h2 ref={heading} tabIndex={-1}>{s.title}</h2>
        {s.body.map((b) => <p key={b} className="tour-body">{b}</p>)}
        <div className="tour-dots" aria-hidden="true">
          {list.map((_, j) => <span key={j} className={j === i ? 'on' : ''} />)}
        </div>
        <div className="tour-nav">
          <button className="btn" disabled={i === 0} onClick={() => setI(i - 1)}>戻る</button>
          <button className="btn primary" onClick={() => (last ? close() : setI(i + 1))}>{last ? 'はじめる' : '次へ'}</button>
        </div>
        <p className="note">設定の「レジの使い方を見る」から、いつでも見直せます。</p>
      </div>
    </div>
  );
}
