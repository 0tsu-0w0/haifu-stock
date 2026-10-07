import { getMeta, setMeta, type HaifuDB } from '../db/local';
import type { Ctx } from '../domain/record';
import { uuidv7 } from '../lib/uuid';

// ログインと売り子の招待(F-1005)。認証サービスとのやりとりは AuthBackend に閉じ込め、テストでは偽物に差し替える

export type Role = 'owner' | 'staff';

export interface CircleChoice {
  circleId: string;
  name: string;
}

export interface InviteRow {
  id: string;
  circle_id: string;
  event_id: string;
  token_hash: string;
  created_by: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface AuthBackend {
  sendCode(email: string): Promise<void>;
  verifyCode(email: string, code: string): Promise<{ userId: string }>;
  signInAnonymously(): Promise<{ userId: string }>;
  currentUserId(): Promise<string | null>;
  /** サークル主として所属しているサークル */
  ownedCircles(userId: string): Promise<CircleChoice[]>;
  /** 招待を受け取り、参加したイベントのIDを返す */
  redeemInvite(token: string): Promise<string>;
  eventCircle(eventId: string): Promise<string>;
  insertInvite(row: InviteRow): Promise<void>;
  listInvites(eventId: string): Promise<InviteRow[]>;
  revokeInvite(id: string): Promise<void>;
}

export async function getRole(db: HaifuDB): Promise<Role> {
  return (await getMeta<Role>(db, 'role')) ?? 'owner';
}

export type OwnerLoginResult =
  | { kind: 'ready' }                                   // この端末のサークルで続ける
  | { kind: 'choose'; circles: CircleChoice[] }         // サーバーに複数ある。選んでもらう
  | { kind: 'none' };                                   // まだサークルがない。作ってもらう

/**
 * サークル主がログインした直後に呼ぶ。
 * 以後の記録をログインしたユーザーの名前で残すようにし、この端末にサークルがなければサーバーから探す
 */
export async function afterOwnerLogin(db: HaifuDB, backend: AuthBackend, userId: string): Promise<OwnerLoginResult> {
  await setMeta(db, 'user_id', userId);
  await setMeta(db, 'role', 'owner');
  if (await getMeta<string>(db, 'circle_id')) return { kind: 'ready' };
  const circles = await backend.ownedCircles(userId);
  if (circles.length === 0) return { kind: 'none' };
  if (circles.length === 1) {
    await selectCircle(db, circles[0].circleId);
    return { kind: 'ready' };
  }
  return { kind: 'choose', circles };
}

/** サーバーにあるサークルをこの端末で使う。中身は次の同期で届く */
export async function selectCircle(db: HaifuDB, circleId: string): Promise<void> {
  await setMeta(db, 'circle_id', circleId);
}

/**
 * 招待のトークンで売り子として参加する。登録は不要で、裏で匿名ログインする。
 * 参加したイベントのIDを返す
 */
export async function joinWithInvite(db: HaifuDB, backend: AuthBackend, token: string): Promise<string> {
  if (!token) throw new Error('招待のリンクが正しくありません');
  const userId = (await backend.currentUserId()) ?? (await backend.signInAnonymously()).userId;
  const eventId = await backend.redeemInvite(token);
  const circleId = await backend.eventCircle(eventId);
  const local = await getMeta<string>(db, 'circle_id');
  if (local && local !== circleId) {
    throw new Error('この端末はすでに別のサークルで使われています。売り子用には、別の端末かブラウザを使ってください');
  }
  await setMeta(db, 'user_id', userId);
  await setMeta(db, 'circle_id', circleId);
  if (!local) await setMeta(db, 'role', 'staff');
  return eventId;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** トークンはURLの # 以降に置く。# 以降はサーバーに送られないので、アクセスログに残らない */
export const inviteUrl = (origin: string, token: string) => `${origin}/join#${token}`;

/**
 * 招待を作る。サーバーにはトークンのハッシュだけを保存する(db/schema.sql の invites)。
 * 招待はすぐに売り子が使うので、送信待ちを通さずに直接サーバーへ書く
 */
export async function createInvite(
  backend: AuthBackend, ctx: Ctx, eventId: string, opts: { origin: string; hours?: number; now?: Date },
): Promise<{ token: string; url: string; invite: InviteRow }> {
  const token = randomToken();
  const now = opts.now ?? new Date();
  const invite: InviteRow = {
    id: uuidv7(),
    circle_id: ctx.circleId,
    event_id: eventId,
    token_hash: await sha256Hex(token),
    created_by: ctx.userId,
    expires_at: new Date(now.getTime() + (opts.hours ?? 24) * 3600_000).toISOString(),
    revoked_at: null,
  };
  await backend.insertInvite(invite);
  return { token, url: inviteUrl(opts.origin, token), invite };
}
