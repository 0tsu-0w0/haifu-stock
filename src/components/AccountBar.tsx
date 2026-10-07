import { Link } from 'react-router-dom';
import { useAuth } from '../app/AuthProvider';
import { useToast } from './Toast';

// ホームの上部に出す、ログインの状態
export function AccountBar() {
  const { configured, session, role, signOut } = useAuth();
  const toast = useToast();
  if (!configured || session === undefined) return null;

  if (!session) {
    return (
      <div className="account">
        <span className="k">ログインしていません。記録はこの端末に保存されます</span>
        <Link className="sbtn acc" to="/login">ログイン</Link>
      </div>
    );
  }
  const who = session.user.is_anonymous ? '売り子として参加中' : session.user.email;
  return (
    <div className="account">
      <span className="k">{who}{role === 'owner' && !session.user.is_anonymous ? '(サークル主)' : ''}</span>
      <button
        className="sbtn"
        onClick={async () => {
          await signOut();
          toast('ログアウトしました。この端末の記録は残っています');
        }}
      >
        ログアウト
      </button>
    </div>
  );
}
