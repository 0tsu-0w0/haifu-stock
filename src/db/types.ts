// db/schema.sql と同じ列名(snake_case)で持つ。同期のときに変換しないで済むようにするため。
// server_seq などサーバーが振る列は、同期で受け取ったときだけ入る

export type Uuid = string;
export type Iso = string;

interface FromServer {
  server_seq?: number;
}

export interface Circle extends FromServer {
  id: Uuid;
  name: string;
  client_updated_at: Iso;
}

export interface Owner extends FromServer {
  id: Uuid;
  circle_id: Uuid;
  name: string;
  is_self: boolean;
  default_fee_rate: number;
  archived_at: Iso | null;
  client_updated_at: Iso;
}

export type ItemKind = 'book' | 'goods' | 'set';

export interface Item extends FromServer {
  id: Uuid;
  circle_id: Uuid;
  owner_id: Uuid;
  kind: ItemKind;
  name: string;
  price: number;
  print_lot: number | null;
  low_threshold: number;
  /** レジで見分けるための色(ITEM_COLORS の名前)。なしは null */
  color?: string | null;
  archived_at: Iso | null;
  /** 削除した時刻(表示から消す。記録は残す) */
  deleted_at?: Iso | null;
  client_updated_at: Iso;
}

/** 印刷所の価格表の1行(F-108)。部数ごとの総額 */
/** 印刷費以外の制作費(F-107)。画面では品目ごとに1行だけ持ち、金額を書き換える */
export interface ProductionCost extends FromServer {
  id: Uuid;
  circle_id: Uuid;
  item_id: Uuid;
  label: string;
  amount: number;
  paid_on?: string | null;
  client_updated_at: Iso;
}

export interface PriceTier extends FromServer {
  id: Uuid;
  circle_id: Uuid;
  item_id: Uuid;
  qty: number;
  total_cost: number;
  deleted_at?: Iso | null;
  client_updated_at: Iso;
}

export interface SetComponent extends FromServer {
  set_item_id: Uuid;
  component_item_id: Uuid;
  circle_id: Uuid;
  qty: number;
}

export interface PrintRun extends FromServer {
  id: Uuid;
  circle_id: Uuid;
  item_id: Uuid;
  edition: number;
  printed_on: string | null;
  qty: number;
  total_cost: number;
  printer: string | null;
  client_updated_at: Iso;
}

/** イベントの種別(大規模・オンリーなど。サークルごとに足せる。F-301) */
export interface EventType extends FromServer {
  id: Uuid;
  circle_id: Uuid;
  name: string;
  sort_order: number;
  archived_at: Iso | null;
  client_updated_at: Iso;
}

export interface EventRow extends FromServer {
  id: Uuid;
  circle_id: Uuid;
  event_type_id: Uuid | null;
  name: string;
  held_on: string;
  venue: string | null;
  space_no: string | null;
  starts_at: Iso | null;
  ends_at: Iso | null;
  /** 開催日数(2日・3日開催。開催日から続けて開く。古いデータにはなく、1日とみなす。Issue #19) */
  days?: number;
  /** 削除した時刻(表示から消す。記録は残す) */
  deleted_at?: Iso | null;
  client_updated_at: Iso;
}

export type LocationKind = 'storage' | 'event' | 'consignee';

export interface Location extends FromServer {
  id: Uuid;
  circle_id: Uuid;
  kind: LocationKind;
  name: string;
  event_id: Uuid | null;
  archived_at: Iso | null;
  client_updated_at: Iso;
}

export interface EventItem extends FromServer {
  event_id: Uuid;
  item_id: Uuid;
  circle_id: Uuid;
  price_override: number | null;
  planned_qty: number | null;
  sort_order: number;
  /** イベントから外した時刻(行は消さずに残す。同期では行を消せないため) */
  removed_at?: Iso | null;
  client_updated_at: Iso;
}

export type TxnType = 'sale' | 'giveaway' | 'void';
export type GiveawayKind = 'sample' | 'gift' | 'damage' | 'lost';

export interface Txn extends FromServer {
  id: Uuid;
  circle_id: Uuid;
  event_id: Uuid;
  type: TxnType;
  source: 'register' | 'closing';
  giveaway_kind: GiveawayKind | null;
  voids_txn_id: Uuid | null;
  paid_amount: number | null;
  zero_stock_override: boolean;
  is_correction: boolean;
  /** 値引きや手入力の金額にした理由(F-409) */
  note?: string | null;
  /** 支払い方法(#15)。ない記録は現金 */
  payment_method?: PaymentMethod;
  device_id: Uuid;
  recorded_by: Uuid;
  recorded_at: Iso;
}

/** 現金 / コード決済(PayPay など)/ カード / その他 */
export type PaymentMethod = 'cash' | 'qr' | 'card' | 'other';

export interface TxnLine extends FromServer {
  id: Uuid;
  circle_id: Uuid;
  transaction_id: Uuid;
  item_id: Uuid;
  qty: number;
  unit_price: number;
  /** この行の値引き額(取引の値引きを金額の比で割り振ったもの。F-409) */
  discount?: number;
}

export type MovementReason =
  | 'print' | 'transfer' | 'sale' | 'giveaway' | 'consign_in' | 'return_to_owner' | 'adjust';

export interface Movement extends FromServer {
  id: Uuid;
  circle_id: Uuid;
  item_id: Uuid;
  qty: number;
  from_location_id: Uuid | null;
  to_location_id: Uuid | null;
  reason: MovementReason;
  event_id: Uuid | null;
  transaction_id: Uuid | null;
  print_run_id: Uuid | null;
  note: string | null;
  device_id: Uuid;
  recorded_by: Uuid;
  recorded_at: Iso;
}

export interface CashCount extends FromServer {
  event_id: Uuid;
  phase: 'float' | 'close';
  denomination: number;
  circle_id: Uuid;
  count: number;
  client_updated_at: Iso;
}

/** 端末の名前(誰が売ったかを見分けるため)。id は取引の device_id と同じ */
export interface Device extends FromServer {
  id: Uuid;
  circle_id: Uuid;
  user_id: Uuid;
  name: string;
  client_updated_at: Iso;
}

/** 休憩・離席の時間帯(F-411)。ends_at が null の間は休憩中 */
export interface EventBreak extends FromServer {
  id: Uuid;
  circle_id: Uuid;
  event_id: Uuid;
  starts_at: Iso;
  ends_at: Iso | null;
  client_updated_at: Iso;
}

export type ReservationStatus = 'held' | 'handed' | 'cancelled';

/** 取り置き。held の間は、レジで売れる部数から除く(在庫は動かさない) */
export interface Reservation extends FromServer {
  id: Uuid;
  circle_id: Uuid;
  event_id: Uuid;
  item_id: Uuid;
  qty: number;
  /** 頼んだ人(呼び名やメモ) */
  name: string;
  status: ReservationStatus;
  /** 渡したときの販売 */
  transaction_id: Uuid | null;
  client_updated_at: Iso;
}

export type ExpenseCategory = 'booth_fee' | 'transport' | 'lodging' | 'shipping' | 'supplies' | 'other';

export interface Expense extends FromServer {
  id: Uuid;
  circle_id: Uuid;
  event_id: Uuid;
  category: ExpenseCategory;
  label: string | null;
  planned_amount: number | null;
  actual_amount: number | null;
  client_updated_at: Iso;
}

export type CountHandling = 'add_sale' | 'lost' | 'fix_bring' | 'keep';

/** 撤収時に数えた残数と、差異の扱い(F-501) */
export interface ClosingCount extends FromServer {
  event_id: Uuid;
  item_id: Uuid;
  circle_id: Uuid;
  counted_qty: number;
  handling: CountHandling;
  client_updated_at: Iso;
}

export interface EventClosing extends FromServer {
  id: Uuid;
  circle_id: Uuid;
  event_id: Uuid;
  closed_at: Iso;
  closed_by: Uuid;
  cash_diff: number | null;
  return_location_id: Uuid | null;
  summary: ClosingSummary;
  reopened_at: Iso | null;
  reopened_by: Uuid | null;
}

/** 確定時点の集計のスナップショット */
export interface ClosingSummary {
  sales: number;
  count: number;
  profit: number;
  fixes: { item_id: Uuid; name: string; handling: CountHandling; qty: number }[];
  payouts: { owner_id: Uuid; name: string; amount: number }[];
  /** 確定で書いた取引と在庫移動(やり直しで打ち消すため) */
  txn_ids?: Uuid[];
  movement_ids?: Uuid[];
}

export interface ConsignmentSettlement extends FromServer {
  id: Uuid;
  circle_id: Uuid;
  event_closing_id: Uuid;
  owner_id: Uuid;
  sold_qty: number;
  sales_amount: number;
  fee_rate: number;
  fee_amount: number;
  payout_amount: number;
  returned_qty: number;
  lines: { item_id: Uuid; name: string; sold_qty: number; amount: number; returned_qty: number }[];
}

// まだ画面で使っていないテーブル
export type LooseRow = Record<string, unknown> & FromServer;

export interface OutboxEntry {
  seq?: number;
  table: string;
  key: string; // 主キーの値の配列を JSON にしたもの
  queued_at: Iso;
}

export interface MetaEntry {
  key: string;
  value: unknown;
}
