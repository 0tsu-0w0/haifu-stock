import type { HaifuDB } from '../db/local';
import type { Txn } from '../db/types';
import { stockByLocation } from './ledger';

/**
 * 指定した置き場所の現在庫(キーは `品目ID|置き場所ID`)。
 * その置き場所に出入りした在庫移動と、それに結び付く取引だけを読む。
 * 全部の在庫移動を読む stockByLocation と同じ結果になるが、販売が増えても読む量がほとんど増えない
 */
export async function locationStock(db: HaifuDB, locationIds: string[]): Promise<Map<string, number>> {
  if (locationIds.length === 0) return new Map();
  const [ins, outs] = await Promise.all([
    db.stock_movements.where('to_location_id').anyOf(locationIds).toArray(),
    db.stock_movements.where('from_location_id').anyOf(locationIds).toArray(),
  ]);
  const moves = [...new Map([...ins, ...outs].map((m) => [m.id, m])).values()];
  const txnIds = [...new Set(moves.map((m) => m.transaction_id).filter((id): id is string => !!id))];
  let txns: Txn[] = [];
  if (txnIds.length > 0) {
    const [found, voids] = await Promise.all([
      db.transactions.bulkGet(txnIds),
      db.transactions.where('voids_txn_id').anyOf(txnIds).toArray(),
    ]);
    txns = [...found.filter((t): t is Txn => !!t), ...voids];
  }
  const wanted = new Set(locationIds);
  const all = stockByLocation(moves, txns);
  // 移動の相手側(イベントの置き場所など)は一部の移動しか数えていないので、返さない
  return new Map([...all].filter(([k]) => wanted.has(k.slice(k.indexOf('|') + 1))));
}

/** サークルの保管場所(自宅など)ごとの現在庫 */
export async function storageStock(db: HaifuDB, circleId: string): Promise<Map<string, number>> {
  const storages = await db.locations.where('circle_id').equals(circleId).filter((l) => l.kind === 'storage').toArray();
  return locationStock(db, storages.map((l) => l.id));
}
