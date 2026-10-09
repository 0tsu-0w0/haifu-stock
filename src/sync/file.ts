import type { HaifuDB } from '../db/local';
import { outboxKey } from '../db/tables';
import type { Movement, Txn, TxnLine } from '../db/types';

// 通信できないままの統合(F-1006)。端末の記録をファイルにして、別の端末で取り込む

export interface LedgerFile {
  format: 'haifu-stock/ledger';
  version: 1;
  event_id: string;
  device_id: string;
  exported_at: string;
  transactions: Txn[];
  transaction_lines: TxnLine[];
  stock_movements: Movement[];
}

/** そのイベントで、この端末が記録した台帳を書き出す */
export async function exportLedger(db: HaifuDB, eventId: string, deviceId: string): Promise<LedgerFile> {
  const transactions = (await db.transactions.where('event_id').equals(eventId).toArray())
    .filter((t) => t.device_id === deviceId);
  const ids = new Set(transactions.map((t) => t.id));
  const transaction_lines = (await db.transaction_lines.where('transaction_id').anyOf([...ids]).toArray());
  const stock_movements = (await db.stock_movements.where('event_id').equals(eventId).toArray())
    .filter((m) => m.device_id === deviceId);
  return {
    format: 'haifu-stock/ledger', version: 1, event_id: eventId, device_id: deviceId,
    exported_at: new Date().toISOString(), transactions, transaction_lines, stock_movements,
  };
}

/**
 * 取り込む。主キーが同じ行は無視するので、2回取り込んでも重複しない。
 * 取り込んだ行は送信待ちにも積み、どちらかの端末がつながればサーバーに届くようにする
 */
export async function importLedger(db: HaifuDB, file: LedgerFile): Promise<number> {
  if (file?.format !== 'haifu-stock/ledger' || file.version !== 1) throw new Error('このファイルは読み込めません');
  // 取り込めるのは、この端末にあるイベントの記録だけ(ほかのサークル・イベントの行は無視する)
  const ev = await db.events.get(file.event_id);
  if (!ev) throw new Error('このイベントはこの端末にありません。先に同期してください');
  const ok = (r: { circle_id?: string; event_id?: string | null }) => r?.circle_id === ev.circle_id;
  const txns = (file.transactions ?? []).filter((t) => ok(t) && t.event_id === ev.id);
  const txnIds = new Set(txns.map((t) => t.id));
  file = {
    ...file,
    transactions: txns,
    transaction_lines: (file.transaction_lines ?? []).filter((l) => ok(l) && txnIds.has(l.transaction_id)),
    stock_movements: (file.stock_movements ?? []).filter((m) => ok(m) && m.event_id === ev.id),
  };
  let added = 0;
  await db.transaction('rw', ['transactions', 'transaction_lines', 'stock_movements', 'outbox'], async () => {
    const parts: [string, { id: string }[]][] = [
      ['transactions', file.transactions], ['transaction_lines', file.transaction_lines], ['stock_movements', file.stock_movements],
    ];
    for (const [table, rows] of parts) {
      const existing = new Set(
        (await db.table(table).bulkGet(rows.map((r) => r.id))).filter(Boolean).map((r: { id: string }) => r.id),
      );
      const fresh = rows.filter((r) => !existing.has(r.id));
      await db.table(table).bulkAdd(fresh);
      await db.outbox.bulkAdd(fresh.map((r) => ({
        table, key: outboxKey(table, r as unknown as Record<string, unknown>), queued_at: new Date().toISOString(),
      })));
      if (table === 'transactions') added = fresh.length;
    }
  });
  return added;
}
