import Dexie, { type Table } from 'dexie';
import type {
  CashCount, Circle, EventDevice, EventItem, EventRow, Item, Location, LooseRow, MetaEntry,
  Movement, OutboxEntry, Owner, PrintRun, SetComponent, Txn, TxnLine,
} from './types';
import { dexieStores, outboxKey } from './tables';

// 端末の中のデータベース。アプリは常にここを正として動き、サーバーは端末どうしの中継に使う
export class HaifuDB extends Dexie {
  circles!: Table<Circle, string>;
  event_types!: Table<LooseRow, string>;
  owners!: Table<Owner, string>;
  items!: Table<Item, string>;
  set_components!: Table<SetComponent, [string, string]>;
  print_runs!: Table<PrintRun, string>;
  production_costs!: Table<LooseRow, string>;
  print_price_tiers!: Table<LooseRow, string>;
  events!: Table<EventRow, string>;
  locations!: Table<Location, string>;
  event_items!: Table<EventItem, [string, string]>;
  event_breaks!: Table<LooseRow, string>;
  expenses!: Table<LooseRow, string>;
  event_devices!: Table<EventDevice, string>;
  cash_counts!: Table<CashCount, [string, string, number]>;
  transactions!: Table<Txn, string>;
  transaction_lines!: Table<TxnLine, string>;
  stock_movements!: Table<Movement, string>;
  closing_counts!: Table<LooseRow, [string, string]>;
  event_closings!: Table<LooseRow, string>;
  consignment_settlements!: Table<LooseRow, string>;
  outbox!: Table<OutboxEntry, number>;
  meta!: Table<MetaEntry, string>;

  constructor(name = 'haifu-stock') {
    super(name);
    this.version(1).stores(dexieStores());
  }
}

/**
 * 行を保存し、送信待ちに積む。呼び出し側の Dexie トランザクションに outbox を含めること。
 * 同じ行を何度保存しても、送るときは最新の内容が1回送られる
 */
export async function putAndQueue<T extends object>(db: HaifuDB, table: string, row: T): Promise<void> {
  await db.table(table).put(row);
  await db.outbox.add({
    table,
    key: outboxKey(table, row as Record<string, unknown>),
    queued_at: new Date().toISOString(),
  });
}

export async function getMeta<T>(db: HaifuDB, key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}

export async function setMeta(db: HaifuDB, key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}
