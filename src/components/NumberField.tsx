import { useEffect, useState } from 'react';

// −/+ と直接入力ができる数値欄。入力のたびに onCommit を呼ぶ(保存は呼び出し側)
export function NumberField(props: { id: string; label: string; value: number; onCommit: (v: number) => void; big?: boolean }) {
  const { id, label, value, onCommit } = props;
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);

  const commit = (v: number) => {
    const n = Math.max(0, Math.floor(Number.isFinite(v) ? v : 0));
    setText(String(n));
    onCommit(n);
  };

  return (
    <span className={`qty${props.big ? '' : ' small'}`}>
      <button type="button" aria-label={`${label}を1減らす`} onClick={() => commit(value - 1)}>−</button>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        aria-label={label}
        value={text}
        onFocus={(e) => {
          setFocused(true);
          e.target.select();
        }}
        onBlur={() => {
          setFocused(false);
          setText(String(value));
        }}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value !== '') commit(parseInt(e.target.value, 10));
        }}
      />
      <button type="button" aria-label={`${label}を1増やす`} onClick={() => commit(value + 1)}>+</button>
    </span>
  );
}
