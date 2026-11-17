import { getMeta, type HaifuDB } from '../db/local';
import type { DeviceSync } from '../db/types';
import type { Remote } from './engine';

// 端末ごとの最後の同期(F-500)。同期を終えたら、この端末の行をサーバーに直接書く。
// 送信待ち(outbox)に積むと、それを送るためにまた同期が走り、止まらなくなるので、積まない。
// 書けなくても(古いサーバー・通信の切れ目)同期そのものは成功のままにする

/** 続けて書かない間隔。未送信の件数が変わったときは、間隔を待たずに書く */
export const REPORT_EVERY_MS = 60_000;

const last = new WeakMap<HaifuDB, { at: number; pending: number }>();

/** 同期を終えたあとに呼ぶ。書いたら true */
export async function reportDeviceSync(db: HaifuDB, remote: Remote, now = new Date()): Promise<boolean> {
  const [deviceId, circleId, userId] = await Promise.all([
    getMeta<string>(db, 'device_id'), getMeta<string>(db, 'circle_id'), getMeta<string>(db, 'user_id'),
  ]);
  if (!deviceId || !circleId || !userId) return false;
  const pending = await db.outbox.count();
  const prev = last.get(db);
  if (prev && prev.pending === pending && now.getTime() - prev.at < REPORT_EVERY_MS) return false;
  const row: DeviceSync = {
    id: deviceId, circle_id: circleId, user_id: userId, synced_at: now.toISOString(), pending, client_updated_at: now.toISOString(),
  };
  try {
    await remote.push('device_syncs', [{ ...row }]);
  } catch {
    return false;
  }
  await db.device_syncs.put(row);
  last.set(db, { at: now.getTime(), pending });
  return true;
}
