import { useState } from 'react';

/** 押し間違えないよう、2回押して実行するボタン(削除など) */
export function ConfirmButton(props: { label: string; confirmLabel: string; onConfirm: () => Promise<void> }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="confirm-btn">
      <button
        className={`btn${armed ? ' danger' : ' quiet-danger'}`}
        disabled={busy}
        onClick={async () => {
          if (!armed) return setArmed(true);
          setBusy(true);
          try {
            await props.onConfirm();
          } finally {
            setBusy(false);
            setArmed(false);
          }
        }}
      >
        {armed ? props.confirmLabel : props.label}
      </button>
      {armed && <button className="link-btn" onClick={() => setArmed(false)}>やめる</button>}
    </div>
  );
}
