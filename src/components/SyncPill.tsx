import { useSync } from '../app/SyncProvider';
import { useToast } from './Toast';

// 画面上部の同期の状態(F-1007)
export function SyncPill() {
  const { state, pending, syncNow } = useSync();
  const toast = useToast();

  let label: string;
  let tone: 'ok' | 'wait' | 'muted';
  if (pending > 0) {
    label = `未送信 ${pending}件`;
    tone = 'wait';
  } else if (state.kind === 'local') {
    label = '端末に保存';
    tone = 'muted';
  } else if (state.kind === 'syncing') {
    label = '同期中';
    tone = 'muted';
  } else if (state.kind === 'offline' || state.kind === 'signed-out' || state.kind === 'error') {
    label = state.kind === 'offline' ? 'オフライン' : state.kind === 'signed-out' ? '未ログイン' : '同期エラー';
    tone = 'wait';
  } else {
    label = '同期済み';
    tone = 'ok';
  }

  return (
    <button className={`pill ${tone}`} onClick={async () => toast(await syncNow())} aria-label={`同期の状態: ${label}。押すと同期します`}>
      <span className="dot" />
      {label}
    </button>
  );
}
