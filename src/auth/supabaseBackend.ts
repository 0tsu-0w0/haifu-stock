import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthBackend, CircleChoice, InviteRow } from './account';

// Supabase Auth を使った実装。エラーは画面にそのまま出せる日本語に置き換える

function explain(e: { message?: string; code?: string; status?: number } | null): Error {
  const m = e?.message ?? '';
  if (/token has expired|invalid/i.test(m) && /otp|token/i.test(m)) return new Error('コードが正しくないか、期限が切れています。もう一度送ってください');
  if (/rate limit|too many/i.test(m)) return new Error('送信の回数が多すぎます。しばらく待ってから試してください');
  if (/anonymous sign-ins are disabled/i.test(m)) return new Error('売り子の参加が有効になっていません。サークル主に連絡してください(Supabase の匿名ログインを有効にする必要があります)');
  if (/招待|ログイン|サークル/.test(m)) return new Error(m);
  if (/fetch|network/i.test(m)) return new Error('通信できません。電波のよい場所で試してください');
  return new Error(m || 'うまくいきませんでした');
}

export class SupabaseAuthBackend implements AuthBackend {
  private google: Promise<boolean> | null = null;

  constructor(private client: SupabaseClient, private url?: string, private anonKey?: string) {}

  /** 認証の公開設定(/auth/v1/settings)を見て、Google が有効なときだけボタンを出す */
  googleEnabled(): Promise<boolean> {
    if (!this.url || !this.anonKey) return Promise.resolve(false);
    this.google ??= fetch(`${this.url}/auth/v1/settings`, { headers: { apikey: this.anonKey } })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { external?: Record<string, boolean> } | null) => !!s?.external?.google)
      .catch(() => {
        this.google = null; // 通信できなかっただけなら、次に開いたときにもう一度確かめる
        return false;
      });
    return this.google;
  }

  async signInWithGoogle(returnTo: string): Promise<void> {
    const { error } = await this.client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: returnTo, queryParams: { prompt: 'select_account' } },
    });
    if (error) throw explain(error);
  }

  async sendCode(email: string, returnTo: string): Promise<void> {
    const { error } = await this.client.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: returnTo } });
    if (error) throw explain(error);
  }

  async verifyCode(email: string, code: string): Promise<{ userId: string }> {
    const { data, error } = await this.client.auth.verifyOtp({ email, token: code, type: 'email' });
    if (error || !data.user) throw explain(error);
    return { userId: data.user.id };
  }

  async signInAnonymously(): Promise<{ userId: string }> {
    const { data, error } = await this.client.auth.signInAnonymously();
    if (error || !data.user) throw explain(error);
    return { userId: data.user.id };
  }

  async currentUserId(): Promise<string | null> {
    const { data } = await this.client.auth.getSession();
    return data.session?.user.id ?? null;
  }

  async ownedCircles(userId: string): Promise<CircleChoice[]> {
    const { data, error } = await this.client
      .from('circle_members')
      .select('circle_id, circles(name)')
      .eq('user_id', userId)
      .eq('role', 'owner');
    if (error) throw explain(error);
    return (data ?? []).map((r) => {
      const c = r.circles as { name?: string } | { name?: string }[] | null;
      const name = (Array.isArray(c) ? c[0]?.name : c?.name) ?? '名前のないサークル';
      return { circleId: r.circle_id as string, name };
    });
  }

  async redeemInvite(token: string): Promise<string> {
    const { data, error } = await this.client.rpc('redeem_invite', { token });
    if (error) throw explain(error);
    return data as string;
  }

  async eventCircle(eventId: string): Promise<string> {
    const { data, error } = await this.client.from('events').select('circle_id').eq('id', eventId).single();
    if (error || !data) throw explain(error);
    return data.circle_id as string;
  }

  async insertInvite(row: InviteRow): Promise<void> {
    const { error } = await this.client.from('invites').insert(row);
    if (error) throw explain(error);
  }

  async listInvites(eventId: string): Promise<InviteRow[]> {
    const { data, error } = await this.client
      .from('invites')
      .select('id, circle_id, event_id, token_hash, created_by, expires_at, revoked_at')
      .eq('event_id', eventId)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('expires_at', { ascending: false });
    if (error) throw explain(error);
    return (data ?? []) as InviteRow[];
  }

  async revokeInvite(id: string): Promise<void> {
    const { error } = await this.client.from('invites').update({ revoked_at: new Date().toISOString() }).eq('id', id);
    if (error) throw explain(error);
  }
}
