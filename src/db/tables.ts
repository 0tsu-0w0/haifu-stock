// 同期するテーブルの一覧。並びは外部キーの依存順(親が先)で、送るときもこの順に送る
export interface TableSpec {
  name: string;
  pk: string[];
  /** 追記だけの台帳。同じ主キーの行が既にあれば何もしない */
  ledger: boolean;
  /** Dexie の索引(主キー以外) */
  indexes: string[];
}

export const TABLES: TableSpec[] = [
  { name: 'circles', pk: ['id'], ledger: false, indexes: [] },
  { name: 'event_types', pk: ['id'], ledger: false, indexes: ['circle_id'] },
  { name: 'owners', pk: ['id'], ledger: false, indexes: ['circle_id'] },
  { name: 'items', pk: ['id'], ledger: false, indexes: ['circle_id'] },
  { name: 'set_components', pk: ['set_item_id', 'component_item_id'], ledger: false, indexes: ['set_item_id'] },
  { name: 'print_runs', pk: ['id'], ledger: false, indexes: ['item_id'] },
  { name: 'production_costs', pk: ['id'], ledger: false, indexes: ['item_id'] },
  { name: 'print_price_tiers', pk: ['id'], ledger: false, indexes: ['item_id'] },
  { name: 'events', pk: ['id'], ledger: false, indexes: ['circle_id', 'held_on'] },
  { name: 'locations', pk: ['id'], ledger: false, indexes: ['circle_id', 'event_id'] },
  { name: 'event_items', pk: ['event_id', 'item_id'], ledger: false, indexes: ['event_id'] },
  { name: 'event_breaks', pk: ['id'], ledger: false, indexes: ['event_id'] },
  { name: 'expenses', pk: ['id'], ledger: false, indexes: ['event_id'] },
  { name: 'event_devices', pk: ['id'], ledger: false, indexes: ['event_id'] },
  { name: 'cash_counts', pk: ['event_id', 'phase', 'denomination'], ledger: false, indexes: ['event_id'] },
  { name: 'transactions', pk: ['id'], ledger: true, indexes: ['event_id', 'voids_txn_id', 'recorded_at'] },
  { name: 'transaction_lines', pk: ['id'], ledger: true, indexes: ['transaction_id', 'item_id'] },
  { name: 'stock_movements', pk: ['id'], ledger: true, indexes: ['event_id', 'item_id', 'transaction_id'] },
  { name: 'closing_counts', pk: ['event_id', 'item_id'], ledger: false, indexes: ['event_id'] },
  { name: 'event_closings', pk: ['id'], ledger: false, indexes: ['event_id'] },
  { name: 'consignment_settlements', pk: ['id'], ledger: true, indexes: [] },
];

export const TABLE_BY_NAME = Object.fromEntries(TABLES.map((t) => [t.name, t])) as Record<string, TableSpec>;

/** サーバーが値を決める列。送るときは外す */
export const SERVER_COLUMNS = ['server_seq', 'received_at', 'created_at', 'updated_at'];

export function dexieStores(): Record<string, string> {
  const stores: Record<string, string> = {};
  for (const t of TABLES) {
    const pk = t.pk.length === 1 ? t.pk[0] : `[${t.pk.join('+')}]`;
    stores[t.name] = [pk, ...t.indexes].join(', ');
  }
  stores.outbox = '++seq, table, key';
  stores.meta = 'key';
  return stores;
}

/** 行から Dexie の主キーを取り出す(単一キーは値、複合キーは配列) */
export function dexieKey(table: string, row: Record<string, unknown>): unknown {
  const pk = TABLE_BY_NAME[table].pk;
  return pk.length === 1 ? row[pk[0]] : pk.map((k) => row[k]);
}

/** 送信待ちの記録に入れる、主キーを表す文字列 */
export function outboxKey(table: string, row: Record<string, unknown>): string {
  return JSON.stringify(TABLE_BY_NAME[table].pk.map((k) => row[k]));
}

export function keyFromOutbox(table: string, key: string): unknown {
  const values = JSON.parse(key) as unknown[];
  return TABLE_BY_NAME[table].pk.length === 1 ? values[0] : values;
}
