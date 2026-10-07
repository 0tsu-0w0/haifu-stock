import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getMeta } from '../db/local';
import { createCircle } from '../domain/setup';
import { freshDb } from '../test/helpers';
import {
  afterOwnerLogin, createInvite, getRole, inviteUrl, joinWithInvite, sha256Hex, type AuthBackend, type InviteRow,
} from './account';

/** サーバー側の振る舞いだけをまねる偽物 */
class FakeBackend implements AuthBackend {
  session: string | null = null;
  circles: { circleId: string; name: string }[] = [];
  invites: InviteRow[] = [];
  eventCircles = new Map<string, string>();
  async sendCode() {}
  async verifyCode() { this.session = 'owner-uid'; return { userId: 'owner-uid' }; }
  async signInAnonymously() { this.session = 'anon-uid'; return { userId: 'anon-uid' }; }
  async currentUserId() { return this.session; }
  async ownedCircles() { return this.circles; }
  async redeemInvite(token: string) {
    const hash = createHash('sha256').update(token, 'utf8').digest('hex');
    const inv = this.invites.find((i) => i.token_hash === hash && !i.revoked_at && i.expires_at > new Date().toISOString());
    if (!inv) throw new Error('招待が無効か、期限が切れています');
    return inv.event_id;
  }
  async eventCircle(eventId: string) { return this.eventCircles.get(eventId)!; }
  async insertInvite(row: InviteRow) { this.invites.push(row); this.eventCircles.set(row.event_id, row.circle_id); }
  async listInvites() { return this.invites; }
  async revokeInvite(id: string) { this.invites.find((i) => i.id === id)!.revoked_at = new Date().toISOString(); }
}

describe('ログイン', () => {
  it('この端末にサークルがあれば、そのまま続け、以後の記録はログインしたユーザーで残す', async () => {
    const db = freshDb('auth');
    await createCircle(db, 'テスト');
    expect(await afterOwnerLogin(db, new FakeBackend(), 'owner-uid')).toEqual({ kind: 'ready' });
    expect(await getMeta(db, 'user_id')).toBe('owner-uid');
    expect(await getRole(db)).toBe('owner');
  });

  it('新しい端末では、サーバーにあるサークルを使う。複数あれば選んでもらう', async () => {
    const backend = new FakeBackend();
    backend.circles = [{ circleId: 'c1', name: 'サークル1' }];
    const db = freshDb('auth');
    expect(await afterOwnerLogin(db, backend, 'owner-uid')).toEqual({ kind: 'ready' });
    expect(await getMeta(db, 'circle_id')).toBe('c1');

    backend.circles.push({ circleId: 'c2', name: 'サークル2' });
    const db2 = freshDb('auth');
    expect((await afterOwnerLogin(db2, backend, 'owner-uid')).kind).toBe('choose');
    expect(await afterOwnerLogin(freshDb('auth'), new FakeBackend(), 'x')).toEqual({ kind: 'none' });
  });
});

describe('売り子の招待', () => {
  it('サーバーにはトークンのハッシュだけを置き、URLの # 以降にトークンを入れる', async () => {
    const backend = new FakeBackend();
    const { token, url, invite } = await createInvite(backend, { circleId: 'c1', deviceId: 'd', userId: 'owner-uid' }, 'e1', {
      origin: 'https://haifu.example', hours: 12, now: new Date('2026-11-01T00:00:00Z'),
    });
    expect(url).toBe(`https://haifu.example/join#${token}`);
    expect(url).toBe(inviteUrl('https://haifu.example', token));
    expect(invite.token_hash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(invite.token_hash).not.toContain(token);
    expect(invite.expires_at).toBe('2026-11-01T12:00:00.000Z');
    expect(await sha256Hex('tok123')).toBe(createHash('sha256').update('tok123').digest('hex'));
  });

  it('招待で参加すると、匿名ログインして売り子としてそのサークルを使う', async () => {
    const backend = new FakeBackend();
    const { token } = await createInvite(backend, { circleId: 'c1', deviceId: 'd', userId: 'owner-uid' }, 'e1', { origin: 'https://x' });
    const db = freshDb('staff');
    expect(await joinWithInvite(db, backend, token)).toBe('e1');
    expect(await getMeta(db, 'circle_id')).toBe('c1');
    expect(await getMeta(db, 'user_id')).toBe('anon-uid');
    expect(await getRole(db)).toBe('staff');
  });

  it('取り消した招待や、別のサークルで使っている端末では参加できない', async () => {
    const backend = new FakeBackend();
    const ctx = { circleId: 'c1', deviceId: 'd', userId: 'owner-uid' };
    const a = await createInvite(backend, ctx, 'e1', { origin: 'https://x' });
    await backend.revokeInvite(a.invite.id);
    await expect(joinWithInvite(freshDb('staff'), backend, a.token)).rejects.toThrow('招待が無効');

    const b = await createInvite(backend, ctx, 'e1', { origin: 'https://x' });
    const other = freshDb('staff');
    await createCircle(other, '別のサークル');
    await expect(joinWithInvite(other, backend, b.token)).rejects.toThrow('別のサークル');
  });
});
