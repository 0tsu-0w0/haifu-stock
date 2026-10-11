// 同期するテーブルの一覧。並びは外部キーの依存順(親が先)で、送るときもこの順に送る。
// 販売の記録(台帳)とその親を先に並べ、それ以外の表は後ろに置く(#17)
export interface TableSpec {
  name: string;
  /** 画面に出す名前(同期で送れなかった表を知らせるため) */
  label: string;
  pk: string[];
  /** 追記だけの台帳。同じ主キーの行が既にあれば何もしない */
  ledger: boolean;
  /** Dexie の索引(主キー以外) */
  indexes: string[];
  /** 外部キーで参照する表。親が送れなかったら、この表も送らない */
  parents: string[];
}

export const TABLES: TableSpec[] = [
  { name: 'circles', label: 'サークル', pk: ['id'], ledger: false, indexes: [], parents: [] },
  { name: 'event_types', label: 'イベントの種類', pk: ['id'], ledger: false, indexes: ['circle_id'], parents: ['circles'] },
  { name: 'owners', label: '持ち主', pk: ['id'], ledger: false, indexes: ['circle_id'], parents: ['circles'] },
  { name: 'items', label: '品目', pk: ['id'], ledger: false, indexes: ['circle_id'], parents: ['circles', 'owners'] },
  { name: 'set_components', label: 'セットの中身', pk: ['set_item_id', 'component_item_id'], ledger: false, indexes: ['set_item_id'], parents: ['items'] },
  { name: 'print_runs', label: '刷り記録', pk: ['id'], ledger: false, indexes: ['item_id'], parents: ['items'] },
  { name: 'events', label: 'イベント', pk: ['id'], ledger: false, indexes: ['circle_id', 'held_on'], parents: ['circles', 'event_types'] },
  { name: 'locations', label: '置き場所', pk: ['id'], ledger: false, indexes: ['circle_id', 'event_id'], parents: ['circles', 'events'] },
  { name: 'event_items', label: 'イベントの品目', pk: ['event_id', 'item_id'], ledger: false, indexes: ['event_id'], parents: ['events', 'items'] },
  { name: 'transactions', label: '販売の記録', pk: ['id'], ledger: true, indexes: ['event_id', 'voids_txn_id', 'recorded_at'], parents: ['events'] },
  { name: 'transaction_lines', label: '販売の明細', pk: ['id'], ledger: true, indexes: ['transaction_id', 'item_id'], parents: ['transactions', 'items'] },
  { name: 'stock_movements', label: '在庫の動き', pk: ['id'], ledger: true, indexes: ['event_id', 'item_id', 'transaction_id'], parents: ['items', 'locations', 'events', 'transactions', 'print_runs'] },
  { name: 'devices', label: '端末の名前', pk: ['id'], ledger: false, indexes: ['circle_id'], parents: ['circles'] },
  { name: 'production_costs', label: '制作費', pk: ['id'], ledger: false, indexes: ['item_id'], parents: ['items'] },
  { name: 'print_price_tiers', label: '印刷所の価格表', pk: ['id'], ledger: false, indexes: ['item_id'], parents: ['items'] },
  { name: 'reservations', label: '取り置き', pk: ['id'], ledger: false, indexes: ['event_id'], parents: ['events', 'items', 'transactions'] },
  { name: 'event_breaks', label: '休憩・離席', pk: ['id'], ledger: false, indexes: ['event_id'], parents: ['events'] },
  { name: 'expenses', label: '経費', pk: ['id'], ledger: false, indexes: ['event_id'], parents: ['events'] },
  { name: 'cash_counts', label: '釣り銭・現金の数え合わせ', pk: ['event_id', 'phase', 'denomination'], ledger: false, indexes: ['event_id'], parents: ['events'] },
  { name: 'closing_counts', label: '残数の確認', pk: ['event_id', 'item_id'], ledger: false, indexes: ['event_id'], parents: ['events', 'items'] },
  { name: 'event_closings', label: '終了処理の確定', pk: ['id'], ledger: false, indexes: ['event_id'], parents: ['events', 'locations'] },
  { name: 'consignment_settlements', label: '受託の精算書', pk: ['id'], ledger: true, indexes: [], parents: ['event_closings', 'owners'] },
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
