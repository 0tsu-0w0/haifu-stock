import { putAndQueue, type HaifuDB } from '../db/local';
import type { GiveawayKind, Movement, MovementReason, Txn, TxnLine } from '../db/types';
import { uuidv7 } from '../lib/uuid';

// 販売・無償出庫・取り消し・在庫移動を台帳に追記する。
// 取引・明細・在庫移動は1つの Dexie トランザクションで書き、途中で落ちても半端に残らないようにする

export interface Ctx {
  circleId: string;
  deviceId: string;
  userId: string;
  now?: () => Date;
}

const nowIso = (ctx: Ctx) => (ctx.now ? ctx.now() : new Date()).toISOString();

/** 終了処理を確定したイベントには、終了処理そのもの以外から記録させない(F-506) */
async function assertOpenForRegister(db: HaifuDB, eventId: string, source: 'register' | 'closing') {
  if (source === 'closing') return;
  const closed = await db.event_closings.where('event_id').equals(eventId).filter((c) => !c.reopened_at).count();
  if (closed > 0) throw new Error('このイベントは終了処理を確定済みです');
}

const LEDGER_TABLES = ['transactions', 'transaction_lines', 'stock_movements', 'outbox', 'event_closings'] as const;
const READ_TABLES = ['locations', 'items', 'set_components', 'event_items'] as const;

export async function eventLocationId(db: HaifuDB, eventId: string): Promise<string> {
  const loc = await db.locations.where('event_id').equals(eventId).first();
  if (!loc) throw new Error('イベントの置き場所が見つかりません');
  return loc.id;
}

function movement(ctx: Ctx, at: string, m: Pick<Movement, 'item_id' | 'qty' | 'reason'> & Partial<Movement>): Movement {
  return {
    id: uuidv7(),
    circle_id: ctx.circleId,
    from_location_id: null,
    to_location_id: null,
    event_id: null,
    transaction_id: null,
    print_run_id: null,
    note: null,
    device_id: ctx.deviceId,
    recorded_by: ctx.userId,
    recorded_at: at,
    ...m,
  };
}

function txn(ctx: Ctx, at: string, t: Pick<Txn, 'event_id' | 'type'> & Partial<Txn>): Txn {
  return {
    id: uuidv7(),
    circle_id: ctx.circleId,
    source: 'register',
    giveaway_kind: null,
    voids_txn_id: null,
    paid_amount: null,
    zero_stock_override: false,
    is_correction: false,
    device_id: ctx.deviceId,
    recorded_by: ctx.userId,
    recorded_at: at,
    ...t,
  };
}

export interface SaleInput {
  eventId: string;
  lines: { itemId: string; qty: number }[];
  paidAmount?: number | null;
  zeroStockOverride?: boolean;
  source?: 'register' | 'closing';
}

/** 販売を記録する。セットは構成品ごとに在庫移動を書く */
export async function recordSale(db: HaifuDB, ctx: Ctx, input: SaleInput): Promise<Txn> {
  if (input.lines.length === 0) throw new Error('品目がありません');
  if (input.lines.some((l) => !Number.isInteger(l.qty) || l.qty <= 0)) throw new Error('部数が正しくありません');

  return db.transaction('rw', [...LEDGER_TABLES, ...READ_TABLES], async () => {
    await assertOpenForRegister(db, input.eventId, input.source ?? 'register');
    const at = nowIso(ctx);
    const loc = await eventLocationId(db, input.eventId);
    const t = txn(ctx, at, {
      event_id: input.eventId,
      type: 'sale',
      source: input.source ?? 'register',
      paid_amount: input.paidAmount ?? null,
      zero_stock_override: input.zeroStockOverride ?? false,
    });
    await putAndQueue(db, 'transactions', t);

    for (const l of input.lines) {
      const item = await db.items.get(l.itemId);
      if (!item) throw new Error('品目が見つかりません');
      const ei = await db.event_items.get([input.eventId, l.itemId]);
      const line: TxnLine = {
        id: uuidv7(),
        circle_id: ctx.circleId,
        transaction_id: t.id,
        item_id: l.itemId,
        qty: l.qty,
        unit_price: ei?.price_override ?? item.price,
      };
      await putAndQueue(db, 'transaction_lines', line);

      const parts = item.kind === 'set'
        ? (await db.set_components.where('set_item_id').equals(item.id).toArray())
            .map((c) => ({ itemId: c.component_item_id, qty: c.qty * l.qty }))
        : [{ itemId: l.itemId, qty: l.qty }];
      for (const p of parts) {
        await putAndQueue(db, 'stock_movements', movement(ctx, at, {
          item_id: p.itemId, qty: p.qty, reason: 'sale',
          from_location_id: loc, event_id: input.eventId, transaction_id: t.id,
        }));
      }
    }
    return t;
  });
}

/** 見本誌・献本・汚損・紛失を記録する(F-406) */
export async function recordGiveaway(
  db: HaifuDB, ctx: Ctx,
  input: { eventId: string; itemId: string; qty: number; kind: GiveawayKind; source?: 'register' | 'closing' },
): Promise<Txn> {
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new Error('部数が正しくありません');
  return db.transaction('rw', [...LEDGER_TABLES, ...READ_TABLES], async () => {
    await assertOpenForRegister(db, input.eventId, input.source ?? 'register');
    const at = nowIso(ctx);
    const item = await db.items.get(input.itemId);
    if (!item) throw new Error('品目が見つかりません');
    if (item.kind === 'set') throw new Error('セットは無償出庫できません。構成品ごとに記録してください');
    const loc = await eventLocationId(db, input.eventId);
    const t = txn(ctx, at, {
      event_id: input.eventId, type: 'giveaway', giveaway_kind: input.kind, source: input.source ?? 'register',
    });
    await putAndQueue(db, 'transactions', t);
    await putAndQueue(db, 'transaction_lines', {
      id: uuidv7(), circle_id: ctx.circleId, transaction_id: t.id, item_id: input.itemId, qty: input.qty, unit_price: 0,
    } satisfies TxnLine);
    await putAndQueue(db, 'stock_movements', movement(ctx, at, {
      item_id: input.itemId, qty: input.qty, reason: 'giveaway',
      from_location_id: loc, event_id: input.eventId, transaction_id: t.id,
    }));
    return t;
  });
}

/** 取引を取り消す。元の取引は消さず、取り消しの取引を追記する(F-404) */
export async function voidTransaction(db: HaifuDB, ctx: Ctx, txnId: string): Promise<Txn> {
  return db.transaction('rw', LEDGER_TABLES, async () => {
    const target = await db.transactions.get(txnId);
    if (!target || target.type === 'void') throw new Error('取り消せる取引が見つかりません');
    await assertOpenForRegister(db, target.event_id, 'register');
    const already = await db.transactions.where('voids_txn_id').equals(txnId).count();
    if (already > 0) throw new Error('この取引はすでに取り消されています');
    const t = txn(ctx, nowIso(ctx), { event_id: target.event_id, type: 'void', voids_txn_id: txnId });
    await putAndQueue(db, 'transactions', t);
    return t;
  });
}

/**
 * 在庫を動かす(刷り上がり・持ち込み・持ち帰り・調整)。
 * イベントの置き場所が絡む移動には、必ずそのイベントIDを入れる(イベント単位の同期と権限のため)
 */
export async function moveStock(
  db: HaifuDB, ctx: Ctx,
  input: { itemId: string; qty: number; from: string | null; to: string | null; reason: MovementReason; printRunId?: string; note?: string },
): Promise<Movement> {
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new Error('部数が正しくありません');
  if (input.from === input.to) throw new Error('移動元と移動先が同じです');
  return db.transaction('rw', ['stock_movements', 'outbox', 'locations'], async () => {
    let eventId: string | null = null;
    for (const id of [input.from, input.to]) {
      if (!id) continue;
      const loc = await db.locations.get(id);
      if (!loc) throw new Error('置き場所が見つかりません');
      if (loc.event_id) eventId = loc.event_id;
    }
    const m = movement(ctx, nowIso(ctx), {
      item_id: input.itemId, qty: input.qty, reason: input.reason,
      from_location_id: input.from, to_location_id: input.to, event_id: eventId,
      print_run_id: input.printRunId ?? null, note: input.note ?? null,
    });
    await putAndQueue(db, 'stock_movements', m);
    return m;
  });
}
