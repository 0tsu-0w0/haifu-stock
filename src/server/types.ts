import type { AuthBackend } from '../auth/account';
import type { Remote } from '../sync/engine';

// 同期先のサーバー(Issue #45)。アプリはこの形だけを使い、どのサービスかは知らない。
// 別のサービスに移すときは、この ServerBackend をもう1つ作り、src/server/index.ts で選ぶ。
// サーバー側で守る決まりは docs/サーバーの差し替え.md にまとめてある

/** ログインしている人 */
export interface AuthSession {
  userId: string;
  /** 売り子(招待で参加)は匿名なので null */
  email: string | null;
  /** 招待で参加した売り子 */
  anonymous: boolean;
}

export interface ServerBackend {
  /** 画面に出すサービスの名前 */
  readonly name: string;
  /** ログインと招待 */
  readonly auth: AuthBackend;
  /** 同期の相手 */
  remote(): Promise<Remote>;
  /** いまのログイン。していなければ null */
  getSession(): Promise<AuthSession | null>;
  /** ログイン・ログアウトしたら呼ばれる。戻り値で止める */
  onSessionChange(cb: (s: AuthSession | null) => void): () => void;
  signOut(): Promise<void>;
  /** ログインのメールのリンクや Google から戻ってきた直後か(起動時に URL から読んでおく) */
  readonly returnedFromLogin: boolean;
}
