import { putAndQueue, type HaifuDB } from '../db/local';
import type { Device, DeviceSync, Txn } from '../db/types';
import type { Ctx } from './record';

// 端末の名前(誰が売ったかを見分けるため、F-710)。名前は同期して、レポートと履歴で使う。
// 売り子は自分の端末の名前だけ、サークル主はサークルの全端末の名前を付けられる

export const DEVICE_NAME_MAX = 30;

/** 端末に名前を付ける(付け直しもできる) */
export async function saveDeviceName(db: HaifuDB, ctx: Ctx, deviceId: string, name: string): Promise<void> {
  const n = name.trim();
  if (!n) throw new Error('名前を入れてください');
  if (n.length > DEVICE_NAME_MAX) throw new Error(`名前は${DEVICE_NAME_MAX}文字までにしてください`);
  await db.transaction('rw', ['devices', 'outbox'], async () => {
    const cur = await db.devices.get(deviceId);
    await putAndQueue(db, 'devices', {
      id: deviceId, circle_id: ctx.circleId, user_id: cur?.user_id ?? ctx.userId, name: n,
      client_updated_at: new Date().toISOString(),
    } satisfies Device);
  });
}

/** 端末の表示名。名前があれば名前、なければ「この端末」か末尾の文字 */
export function deviceLabel(names: Map<string, string>, deviceId: string, myDeviceId: string | undefined): string {
  const n = names.get(deviceId);
  if (deviceId === myDeviceId) return n ? `${n}(この端末)` : 'この端末';
  return n ?? `端末 …${deviceId.slice(-4)}`;
}

export async function loadDeviceNames(db: HaifuDB, circleId: string): Promise<Map<string, string>> {
  const rows = await db.devices.where('circle_id').equals(circleId).toArray();
  return new Map(rows.map((d) => [d.id, d.name]));
}

export interface DeviceStatus {
  id: string;
  label: string;
  /** このイベントで、この端末に届いている記録の件数と最後の時刻 */
  count: number;
  lastRecord: string | null;
  /** その端末が最後に同期を終えた時刻と、そのときの未送信の件数。分からなければ null */
  syncedAt: string | null;
  pending: number;
  /** 気をつけること(なければ空) */
  warn: string;
}

/** しばらく同期していないとみなす時間 */
export const STALE_SYNC_MS = 15 * 60_000;

/**
 * 終了処理の前に、ほかの端末の記録がそろっているかを見る(F-500)。
 * このイベントで記録した端末と、同期の記録がある端末を並べる(この端末は除く)
 */
export function deviceStatuses(input: {
  txns: Pick<Txn, 'device_id' | 'recorded_at'>[]; syncs: DeviceSync[]; names: Map<string, string>; myDeviceId: string; now: Date;
}): DeviceStatus[] {
  const rec = new Map<string, { count: number; last: string }>();
  for (const t of input.txns) {
    if (t.device_id === input.myDeviceId) continue;
    const x = rec.get(t.device_id) ?? { count: 0, last: '' };
    rec.set(t.device_id, { count: x.count + 1, last: t.recorded_at > x.last ? t.recorded_at : x.last });
  }
  const syncById = new Map(input.syncs.map((s) => [s.id, s]));
  // 同期の記録だけがある端末は、このイベントに関係ありそうなものだけ出す(最近同期したもの)
  const recent = input.syncs.filter((s) => input.now.getTime() - Date.parse(s.synced_at) < 24 * 3600_000).map((s) => s.id);
  const ids = [...new Set([...rec.keys(), ...recent])].filter((id) => id !== input.myDeviceId);
  return ids.map((id) => {
    const r = rec.get(id);
    const s = syncById.get(id);
    let warn = '';
    if (s && s.pending > 0) warn = 'まだ送れていない記録があります。その端末で「同期する」を押すか、ファイルで送ってもらってください';
    else if (s && r && input.now.getTime() - Date.parse(s.synced_at) > STALE_SYNC_MS) warn = 'しばらく同期していません。その端末で「同期する」を押してもらってください';
    return {
      id, label: deviceLabel(input.names, id, input.myDeviceId), count: r?.count ?? 0, lastRecord: r?.last ?? null,
      syncedAt: s?.synced_at ?? null, pending: s?.pending ?? 0, warn,
    };
  }).sort((a, b) => Number(!!b.warn) - Number(!!a.warn) || b.count - a.count || a.label.localeCompare(b.label, 'ja'));
}
