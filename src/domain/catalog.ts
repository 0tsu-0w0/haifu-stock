import { putAndQueue, type HaifuDB } from '../db/local';
import type { CashCount, EventItem, EventRow, Expense, ExpenseCategory, Item, ItemKind, Owner, PrintRun, SetComponent } from '../db/types';
import { uuidv7 } from '../lib/uuid';
import { assertOpen } from './closing';
import { moveStock, type Ctx } from './record';
import { createEvent } from './setup';

// 品目・持ち主・刷り記録・イベントの準備(F-101〜108、F-301〜309)。
// 在庫を変えるものは必ず在庫移動として記録し、数そのものは書き換えない

const stamp = () => new Date().toISOString();

export async function saveOwner(
  db: HaifuDB, ctx: Ctx, input: { id?: string; name: string; feeRate: number },
): Promise<Owner> {
  const name = input.name.trim();
  if (!name) throw new Error('持ち主の名前を入れてください');
  if (!(input.feeRate >= 0 && input.feeRate <= 1)) throw new Error('受託手数料は0〜100%で入れてください');
  const cur = input.id ? await db.owners.get(input.id) : undefined;
  const owner: Owner = {
    id: cur?.id ?? uuidv7(), circle_id: ctx.circleId, name, is_self: cur?.is_self ?? false,
    default_fee_rate: input.feeRate, archived_at: cur?.archived_at ?? null, client_updated_at: stamp(),
  };
  await db.transaction('rw', ['owners', 'outbox'], () => putAndQueue(db, 'owners', owner));
  return owner;
}

export interface ItemInput {
  id?: string;
  name: string;
  kind: ItemKind;
  price: number;
  ownerId: string;
  lowThreshold: number;
  printLot?: number | null;
  /** セットの構成。作るときだけ指定できる(構成を変えると過去の在庫の意味が変わるため) */
  components?: { itemId: string; qty: number }[];
}

export async function saveItem(db: HaifuDB, ctx: Ctx, input: ItemInput): Promise<Item> {
  const name = input.name.trim();
  if (!name) throw new Error('品目名を入れてください');
  if (!Number.isInteger(input.price) || input.price < 0) throw new Error('価格は0円以上の整数で入れてください');
  if (!Number.isInteger(input.lowThreshold) || input.lowThreshold < 0) throw new Error('「残りわずか」の部数は0以上で入れてください');
  const cur = input.id ? await db.items.get(input.id) : undefined;
  if (cur && cur.kind !== input.kind) throw new Error('作った後で種類は変えられません');
  const isNew = !cur;
  if (input.kind === 'set' && isNew) {
    const comps = input.components ?? [];
    if (comps.length < 2) throw new Error('セットには2つ以上の品目を入れてください');
    if (comps.some((c) => !Number.isInteger(c.qty) || c.qty <= 0)) throw new Error('セットの部数が正しくありません');
  }
  const item: Item = {
    id: cur?.id ?? uuidv7(), circle_id: ctx.circleId, owner_id: input.ownerId, kind: input.kind, name,
    price: input.price, print_lot: input.printLot ?? null, low_threshold: input.lowThreshold,
    archived_at: cur?.archived_at ?? null, client_updated_at: stamp(),
  };
  await db.transaction('rw', ['items', 'set_components', 'outbox'], async () => {
    await putAndQueue(db, 'items', item);
    if (input.kind === 'set' && isNew) {
      for (const c of input.components!) {
        await putAndQueue(db, 'set_components', {
          set_item_id: item.id, component_item_id: c.itemId, circle_id: ctx.circleId, qty: c.qty,
        } satisfies SetComponent);
      }
    }
  });
  return item;
}

export async function setItemArchived(db: HaifuDB, itemId: string, archived: boolean): Promise<void> {
  await db.transaction('rw', ['items', 'outbox'], async () => {
    const cur = await db.items.get(itemId);
    if (!cur) throw new Error('品目が見つかりません');
    await putAndQueue(db, 'items', { ...cur, archived_at: archived ? stamp() : null, client_updated_at: stamp() });
  });
}

/** 刷り記録を追加し、刷った部数を置き場所(ふつうは自宅)に入れる(F-102) */
export async function addPrintRun(
  db: HaifuDB, ctx: Ctx,
  input: { itemId: string; qty: number; totalCost: number; printedOn: string | null; printer?: string; toLocationId: string },
): Promise<PrintRun> {
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new Error('刷った部数を入れてください');
  if (!Number.isInteger(input.totalCost) || input.totalCost < 0) throw new Error('印刷費は0円以上の整数で入れてください');
  const item = await db.items.get(input.itemId);
  if (!item || item.kind === 'set') throw new Error('刷り記録をつけられる品目ではありません');
  const editions = await db.print_runs.where('item_id').equals(input.itemId).count();
  const run: PrintRun = {
    id: uuidv7(), circle_id: ctx.circleId, item_id: input.itemId, edition: editions + 1,
    printed_on: input.printedOn, qty: input.qty, total_cost: input.totalCost, printer: input.printer?.trim() || null,
    client_updated_at: stamp(),
  };
  await db.transaction('rw', ['print_runs', 'stock_movements', 'locations', 'outbox'], async () => {
    await putAndQueue(db, 'print_runs', run);
    await moveStock(db, ctx, {
      itemId: input.itemId, qty: input.qty, from: null, to: input.toLocationId, reason: 'print', printRunId: run.id,
      note: `${run.edition === 1 ? '初版' : `第${run.edition}版`}の刷り上がり`,
    });
  });
  return run;
}

export async function saveEventInfo(
  db: HaifuDB, ctx: Ctx,
  input: { id?: string; name: string; heldOn: string; spaceNo?: string; venue?: string; startsAt?: string | null },
): Promise<EventRow> {
  const name = input.name.trim();
  if (!name) throw new Error('イベント名を入れてください');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.heldOn)) throw new Error('開催日を入れてください');
  if (!input.id) {
    const ev = await createEvent(db, ctx, { name, heldOn: input.heldOn, spaceNo: input.spaceNo?.trim() || undefined, startsAt: input.startsAt ?? undefined });
    if (input.venue?.trim()) return saveEventInfo(db, ctx, { ...input, id: ev.id });
    return ev;
  }
  const cur = await db.events.get(input.id);
  if (!cur) throw new Error('イベントが見つかりません');
  const ev: EventRow = {
    ...cur, name, held_on: input.heldOn, space_no: input.spaceNo?.trim() || null, venue: input.venue?.trim() || null,
    starts_at: input.startsAt ?? null, client_updated_at: stamp(),
  };
  await db.transaction('rw', ['events', 'locations', 'outbox'], async () => {
    await putAndQueue(db, 'events', ev);
    const loc = await db.locations.where('event_id').equals(ev.id).first();
    if (loc && loc.name !== name) await putAndQueue(db, 'locations', { ...loc, name, client_updated_at: stamp() });
  });
  return ev;
}

/**
 * 持ち込みの数として、いまイベントの置き場所に用意されている数。
 * 入った数から、持ち帰り・返却で出た数を引く(販売や見本誌は引かない)
 */
export async function preparedQty(db: HaifuDB, eventId: string): Promise<Map<string, number>> {
  const loc = await db.locations.where('event_id').equals(eventId).first();
  const out = new Map<string, number>();
  if (!loc) return out;
  const voided = new Set((await db.transactions.where('event_id').equals(eventId).toArray()).filter((t) => t.type === 'void').map((t) => t.voids_txn_id));
  for (const m of await db.stock_movements.where('event_id').equals(eventId).toArray()) {
    if (m.transaction_id && voided.has(m.transaction_id)) continue;
    const d = m.to_location_id === loc.id ? m.qty
      : m.from_location_id === loc.id && (m.reason === 'transfer' || m.reason === 'return_to_owner' || m.reason === 'adjust') ? -m.qty
      : 0;
    if (d) out.set(m.item_id, (out.get(m.item_id) ?? 0) + d);
  }
  return out;
}

export interface PrepareLine {
  itemId: string;
  /** イベントに出すか(出さないものはレジに並べない) */
  included: boolean;
  /** 持ち込み数(受託品は預かり数)。セットは構成品の数で決まるので無視する */
  bring: number;
  priceOverride: number | null;
  /** レジでの並び順。省略すると渡した順 */
  sortOrder?: number;
}

/**
 * 持ち込みを反映する(F-302)。いまの数との差だけ在庫を動かす:
 * 自分の品目は保管場所 ⇄ イベント、受託品は預かり(外 → イベント)⇄ 返却(イベント → 外)
 */
export async function prepareEvent(
  db: HaifuDB, ctx: Ctx, eventId: string, lines: PrepareLine[], opts: { storageId: string },
): Promise<{ moved: number }> {
  return db.transaction('rw', ['event_items', 'items', 'owners', 'stock_movements', 'transactions', 'locations', 'event_closings', 'outbox'], async () => {
    await assertOpen(db, eventId);
    const loc = await db.locations.where('event_id').equals(eventId).first();
    if (!loc) throw new Error('イベントの置き場所が見つかりません');
    const current = await preparedQty(db, eventId);
    const owners = new Map((await db.owners.toArray()).map((o) => [o.id, o]));
    let moved = 0;
    for (const [i, l] of lines.entries()) {
      const item = await db.items.get(l.itemId);
      if (!item) continue;
      if (!Number.isInteger(l.bring) || l.bring < 0) throw new Error(`${item.name}の持ち込み数が正しくありません`);
      const prev = await db.event_items.get([eventId, l.itemId]);
      if (l.included || prev) {
        await putAndQueue(db, 'event_items', {
          event_id: eventId, item_id: l.itemId, circle_id: ctx.circleId,
          price_override: l.priceOverride, planned_qty: item.kind === 'set' ? null : l.bring,
          sort_order: l.sortOrder ?? i, removed_at: l.included ? null : prev?.removed_at ?? stamp(), client_updated_at: stamp(),
        } satisfies EventItem);
      }
      if (item.kind === 'set') continue;
      const target = l.included ? l.bring : 0;
      const delta = target - (current.get(l.itemId) ?? 0);
      if (delta === 0) continue;
      const own = owners.get(item.owner_id)?.is_self ?? true;
      const qty = Math.abs(delta);
      if (own) {
        await moveStock(db, ctx, delta > 0
          ? { itemId: l.itemId, qty, from: opts.storageId, to: loc.id, reason: 'transfer', note: '持ち込み' }
          : { itemId: l.itemId, qty, from: loc.id, to: opts.storageId, reason: 'transfer', note: '持ち込みの取りやめ' });
      } else {
        await moveStock(db, ctx, delta > 0
          ? { itemId: l.itemId, qty, from: null, to: loc.id, reason: 'consign_in', note: '受託品の預かり' }
          : { itemId: l.itemId, qty, from: loc.id, to: null, reason: 'return_to_owner', note: '預かり数の訂正' });
      }
      moved += qty;
    }
    return { moved };
  });
}

export interface NewItemForEvent {
  name: string;
  kind: 'book' | 'goods';
  price: number;
  /** 既存の持ち主か、新しい受託元 */
  owner: { id: string } | { newName: string; feeRate: number };
  /** 自分の品目のとき、刷った部数と印刷費(任意) */
  print?: { qty: number; totalCost: number } | null;
  /** 持ち込み数(受託品は預かり数) */
  bring: number;
}

/**
 * 準備画面から、新しい品目を作ってそのまま持ち込みに加える。
 * 受託元の追加・品目の登録・刷り記録・持ち込みの反映を1つのトランザクションで行い、途中で失敗したら何も残さない。
 * 並び順はいまの品目の後ろにする
 */
export async function createItemForEvent(
  db: HaifuDB, ctx: Ctx, eventId: string, input: NewItemForEvent, opts: { storageId: string },
): Promise<Item> {
  if (!Number.isInteger(input.bring) || input.bring < 0) throw new Error('持ち込み数は0以上で入れてください');
  return db.transaction('rw', [
    'owners', 'items', 'set_components', 'print_runs', 'stock_movements', 'locations', 'event_items', 'transactions',
    'event_closings', 'outbox',
  ], async () => {
    await assertOpen(db, eventId);
    const ownerId = 'id' in input.owner
      ? input.owner.id
      : (await saveOwner(db, ctx, { name: input.owner.newName, feeRate: input.owner.feeRate })).id;
    const own = (await db.owners.get(ownerId))?.is_self ?? false;
    const item = await saveItem(db, ctx, { name: input.name, kind: input.kind, price: input.price, ownerId, lowThreshold: 3 });
    if (own && input.print && input.print.qty > 0) {
      await addPrintRun(db, ctx, { itemId: item.id, qty: input.print.qty, totalCost: input.print.totalCost, printedOn: null, toLocationId: opts.storageId });
    }
    const last = (await db.event_items.where('event_id').equals(eventId).toArray()).reduce((a, e) => Math.max(a, e.sort_order), -1);
    await prepareEvent(db, ctx, eventId, [{ itemId: item.id, included: true, bring: input.bring, priceOverride: null, sortOrder: last + 1 }], opts);
    return item;
  });
}

/** 釣り銭準備金(F-305) */
export async function saveFloat(db: HaifuDB, ctx: Ctx, eventId: string, denomination: number, count: number): Promise<void> {
  await db.transaction('rw', ['cash_counts', 'outbox', 'event_closings'], async () => {
    await assertOpen(db, eventId);
    await putAndQueue(db, 'cash_counts', {
      event_id: eventId, phase: 'float', denomination, circle_id: ctx.circleId,
      count: Math.max(0, Math.floor(count)), client_updated_at: stamp(),
    } satisfies CashCount);
  });
}

export const EXPENSE_LABEL: Record<ExpenseCategory, string> = {
  booth_fee: '出展費', transport: '交通費', lodging: '宿泊費', shipping: '搬入の送料', supplies: '消耗品', other: 'その他',
};

/** 経費(F-309)。金額を0にすると消したものとして扱う(同期で消せないため) */
export async function saveExpense(
  db: HaifuDB, ctx: Ctx,
  input: { id?: string; eventId: string; category: ExpenseCategory; label?: string; planned: number | null; actual: number | null },
): Promise<Expense> {
  for (const v of [input.planned, input.actual]) {
    if (v !== null && (!Number.isInteger(v) || v < 0)) throw new Error('金額は0円以上の整数で入れてください');
  }
  const exp: Expense = {
    id: input.id ?? uuidv7(), circle_id: ctx.circleId, event_id: input.eventId, category: input.category,
    label: input.label?.trim() || EXPENSE_LABEL[input.category], planned_amount: input.planned, actual_amount: input.actual,
    client_updated_at: stamp(),
  };
  await db.transaction('rw', ['expenses', 'outbox'], () => putAndQueue(db, 'expenses', exp));
  return exp;
}
