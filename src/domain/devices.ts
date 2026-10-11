import { putAndQueue, type HaifuDB } from '../db/local';
import type { Device } from '../db/types';
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
