import { putAndQueue, type HaifuDB } from '../db/local';
import type {
  CashCount, ClosingCount, ClosingSummary, ConsignmentSettlement, CountHandling, EventClosing, Item,
} from '../db/types';
import { uuidv7 } from '../lib/uuid';
import { activeTxnIds } from './ledger';
import { moveStock, recordGiveaway, recordSale, type Ctx } from './record';
import { deriveEvent, loadEventSnapshot, type EventSnapshot } from './snapshot';

// 終了処理(F-500〜506)。数えた残数・現金は closing_counts / cash_counts に保存しながら進め、
// 確定するときに差異の扱いを台帳へ反映して、受託の精算書と確定の記録を作る

export const DENOMINATIONS = [10000, 5000, 1000, 500, 100, 50, 10, 5, 1] as const;

export interface CountRow {
  item: Item;
  /** 台帳上の残数 */
  theo: number;
  counted: number;
  /** counted − theo */
  diff: number;
  handling: CountHandling | null;
}

/** 品目ごとの理論残数・実数・差異の扱い。実数が未入力なら理論残数(0未満なら0)とみなす */
export function planCounts(s: EventSnapshot): CountRow[] {
  const { summary, itemById } = deriveEvent(s);
  const saved = new Map(s.closingCounts.map((c) => [c.item_id, c]));
  // イベントから外した品目も、在庫や数えた記録が残っていれば対象にする
  return s.allEventItems
    .filter((ei) => !ei.removed_at || (summary.get(ei.item_id)?.remaining ?? 0) !== 0 || saved.has(ei.item_id))
    .map((ei) => itemById.get(ei.item_id))
    .filter((i): i is Item => !!i && i.kind !== 'set')
    .map((item) => {
      const theo = summary.get(item.id)?.remaining ?? 0;
      const row = saved.get(item.id);
      const counted = row?.counted_qty ?? Math.max(theo, 0);
      const diff = counted - theo;
      let handling = row?.handling ?? null;
      if (diff < 0 && !['add_sale', 'lost', 'keep'].includes(handling ?? '')) handling = 'add_sale';
      if (diff > 0 && !['fix_bring', 'keep'].includes(handling ?? '')) handling = 'fix_bring';
      if (diff === 0) handling = null;
      return { item, theo, counted, diff, handling };
    });
}

/** 残数確認で「販売を追加」にした分の売上 */
export function plannedExtraSales(s: EventSnapshot, rows: CountRow[]): number {
  const { priceOf } = deriveEvent(s);
  return rows.filter((r) => r.handling === 'add_sale').reduce((a, r) => a - r.diff * priceOf(r.item), 0);
}

export interface Settlement {
  ownerId: string;
  name: string;
  feeRate: number;
  lines: { item: Item; soldQty: number; amount: number; returnedQty: number }[];
  soldQty: number;
  amount: number;
  fee: number;
  payout: number;
  returnedQty: number;
}

export interface Money {
  total: number;
  own: number;
  consigned: number;
  fee: number;
  expenses: number;
  cost: number;
  profit: number;
  settlements: Settlement[];
}

/** 持ち主別の売上・受託の精算・自分の分の収支。rows の「販売を追加」も含めて計算する */
export function computeMoney(s: EventSnapshot, rows: CountRow[]): Money {
  const { itemById, ownerById, priceOf } = deriveEvent(s);
  const active = activeTxnIds(s.txns);
  const saleIds = new Set(s.txns.filter((t) => t.type === 'sale' && active.has(t.id)).map((t) => t.id));
  const sold = new Map<string, { qty: number; amount: number }>();
  const add = (id: string, qty: number, amount: number) => {
    const x = sold.get(id) ?? { qty: 0, amount: 0 };
    sold.set(id, { qty: x.qty + qty, amount: x.amount + amount });
  };
  for (const l of s.lines) if (saleIds.has(l.transaction_id)) add(l.item_id, l.qty, l.qty * l.unit_price);
  for (const r of rows) if (r.handling === 'add_sale') add(r.item.id, -r.diff, -r.diff * priceOf(r.item));

  const counted = new Map(rows.map((r) => [r.item.id, r.counted]));
  const settlements: Settlement[] = [];
  for (const owner of s.owners.filter((o) => !o.is_self)) {
    const items = s.items.filter((i) => i.owner_id === owner.id && s.allEventItems.some((e) => e.item_id === i.id));
    if (items.length === 0) continue;
    const lines = items.map((item) => ({
      item, soldQty: sold.get(item.id)?.qty ?? 0, amount: sold.get(item.id)?.amount ?? 0, returnedQty: counted.get(item.id) ?? 0,
    }));
    const amount = lines.reduce((a, l) => a + l.amount, 0);
    const fee = Math.round(amount * owner.default_fee_rate);
    settlements.push({
      ownerId: owner.id, name: owner.name, feeRate: owner.default_fee_rate, lines, amount, fee, payout: amount - fee,
      soldQty: lines.reduce((a, l) => a + l.soldQty, 0), returnedQty: lines.reduce((a, l) => a + l.returnedQty, 0),
    });
  }

  // 1部あたりの原価 = 刷り記録の印刷費合計 ÷ 部数合計(F-103)
  const unitCost = (id: string) => {
    const runs = s.printRuns.filter((p) => p.item_id === id);
    const qty = runs.reduce((a, p) => a + p.qty, 0);
    return qty ? runs.reduce((a, p) => a + p.total_cost, 0) / qty : 0;
  };
  let total = 0;
  let consigned = 0;
  let cost = 0;
  for (const [id, x] of sold) {
    total += x.amount;
    const item = itemById.get(id);
    if (!item) continue;
    if (!ownerById.get(item.owner_id)?.is_self) {
      consigned += x.amount;
      continue;
    }
    const parts = item.kind === 'set'
      ? s.setComponents.filter((c) => c.set_item_id === id).map((c) => [c.component_item_id, c.qty * x.qty] as const)
      : [[id, x.qty] as const];
    for (const [c, q] of parts) cost += q * unitCost(c);
  }
  cost = Math.round(cost);
  const fee = settlements.reduce((a, x) => a + x.fee, 0);
  const expenses = s.expenses.reduce((a, e) => a + (e.actual_amount ?? e.planned_amount ?? 0), 0);
  const own = total - consigned;
  return { total, own, consigned, fee, expenses, cost, profit: own + fee - expenses - cost, settlements };
}

/** 現金の差異から考えられる原因(F-503) */
export function cashDiffHints(diff: number, items: Item[], rows: CountRow[]): string[] {
  if (diff === 0) return [];
  const ad = Math.abs(diff);
  const hit = items.filter((i) => i.price === ad).map((i) => i.name).join('・');
  const out: string[] = [];
  if (diff > 0) {
    out.push(`記録していない販売がある${hit ? `(${hit} 1部分の金額です)` : ''}`, 'お釣りの渡し忘れ');
  } else {
    out.push('お釣りの渡しすぎ', `記録のしすぎ・取り消し忘れ${hit ? `(${hit} 1部分の金額です)` : ''}`);
  }
  if (ad % 1000 === 0) out.push('お札の数え間違い(1000円単位の差)');
  if (rows.some((r) => r.handling === 'keep' && r.diff < 0)) out.push('残数確認で「そのまま」にした品目の打ち漏れ');
  return out;
}

const stamp = () => new Date().toISOString();

export async function saveCount(
  db: HaifuDB, ctx: Ctx, eventId: string, itemId: string, patch: { counted?: number; handling?: CountHandling },
): Promise<void> {
  await db.transaction('rw', ['closing_counts', 'outbox', 'event_closings'], async () => {
    await assertOpen(db, eventId);
    const cur = await db.closing_counts.get([eventId, itemId]);
    const row: ClosingCount = {
      event_id: eventId, item_id: itemId, circle_id: ctx.circleId,
      counted_qty: Math.max(0, Math.floor(patch.counted ?? cur?.counted_qty ?? 0)),
      handling: patch.handling ?? cur?.handling ?? 'keep',
      client_updated_at: stamp(),
    };
    await putAndQueue(db, 'closing_counts', row);
  });
}

/** 実数を入れる。差異の向きが変わったら、扱いをその向きの既定(足りない→販売を追加、多い→持ち込み数を直す)にする */
export async function saveCountFrom(db: HaifuDB, ctx: Ctx, eventId: string, row: CountRow, counted: number) {
  const d = counted - row.theo;
  const h = row.handling;
  const handling: CountHandling =
    d < 0 ? (h === 'add_sale' || h === 'lost' || h === 'keep' ? h : 'add_sale')
    : d > 0 ? (h === 'fix_bring' || h === 'keep' ? h : 'fix_bring')
    : 'keep';
  await saveCount(db, ctx, eventId, row.item.id, { counted, handling });
}

export async function saveCash(db: HaifuDB, ctx: Ctx, eventId: string, denomination: number, count: number): Promise<void> {
  await db.transaction('rw', ['cash_counts', 'outbox', 'event_closings'], async () => {
    await assertOpen(db, eventId);
    await putAndQueue(db, 'cash_counts', {
      event_id: eventId, phase: 'close', denomination, circle_id: ctx.circleId,
      count: Math.max(0, Math.floor(count)), client_updated_at: stamp(),
    } satisfies CashCount);
  });
}

export async function isEventClosed(db: HaifuDB, eventId: string): Promise<boolean> {
  return (await db.event_closings.where('event_id').equals(eventId).filter((c) => !c.reopened_at).count()) > 0;
}

export async function assertOpen(db: HaifuDB, eventId: string): Promise<void> {
  if (await isEventClosed(db, eventId)) throw new Error('このイベントは終了処理を確定済みです');
}

const CLOSE_TABLES = [
  'events', 'locations', 'event_items', 'items', 'owners', 'set_components', 'transactions', 'transaction_lines',
  'stock_movements', 'cash_counts', 'closing_counts', 'event_closings', 'consignment_settlements', 'expenses',
  'print_runs', 'outbox',
];

/**
 * 確定する。
 * 1. 差異の扱いを台帳に反映(販売を追加・紛失・持ち込み数の修正)
 * 2. 残りを戻す(自分の分は戻し先へ、受託分は持ち主に返却)
 * 3. 受託の精算書と、確定の記録を作る
 * すべて1つのトランザクションで行い、途中で失敗したら何も残さない
 */
export async function confirmClosing(
  db: HaifuDB, ctx: Ctx, eventId: string, opts: { returnLocationId: string },
): Promise<EventClosing> {
  return db.transaction('rw', CLOSE_TABLES, async () => {
    await assertOpen(db, eventId);
    const before = await loadEventSnapshot(db, eventId);
    if (!before?.location) throw new Error('イベントが見つかりません');
    const rows = planCounts(before);
    const evLoc = before.location.id;

    for (const r of rows) {
      if (r.handling === 'add_sale') {
        await recordSale(db, ctx, { eventId, lines: [{ itemId: r.item.id, qty: -r.diff }], source: 'closing' });
      } else if (r.handling === 'lost') {
        await recordGiveaway(db, ctx, { eventId, itemId: r.item.id, qty: -r.diff, kind: 'lost', source: 'closing' });
      } else if (r.handling === 'fix_bring') {
        await moveStock(db, ctx, {
          itemId: r.item.id, qty: r.diff, from: opts.returnLocationId, to: evLoc, reason: 'adjust', note: '終了処理: 持ち込み数の修正',
        });
      }
    }

    const ownerById = new Map(before.owners.map((o) => [o.id, o]));
    for (const r of rows) {
      if (r.counted <= 0) continue;
      const own = ownerById.get(r.item.owner_id)?.is_self ?? true;
      await moveStock(db, ctx, own
        ? { itemId: r.item.id, qty: r.counted, from: evLoc, to: opts.returnLocationId, reason: 'transfer', note: '終了処理: 持ち帰り' }
        : { itemId: r.item.id, qty: r.counted, from: evLoc, to: null, reason: 'return_to_owner', note: '終了処理: 持ち主に返却' });
    }

    const after = (await loadEventSnapshot(db, eventId))!;
    // 反映済みなので、差異なしとして計算し直す(「販売を追加」が二重に入らないように)
    const settledRows = rows.map((r) => ({ ...r, handling: null }));
    const money = computeMoney(after, settledRows);
    const derived = deriveEvent(after);
    const closingId = uuidv7();
    const closing: EventClosing = {
      id: closingId,
      circle_id: ctx.circleId,
      event_id: eventId,
      closed_at: stamp(),
      closed_by: ctx.userId,
      cash_diff: derived.counted ? derived.counted - (derived.float + derived.totals.amount) : null,
      return_location_id: opts.returnLocationId,
      summary: {
        sales: derived.totals.amount,
        count: derived.totals.count,
        profit: money.profit,
        fixes: rows.filter((r) => r.handling && r.handling !== 'keep')
          .map((r) => ({ item_id: r.item.id, name: r.item.name, handling: r.handling!, qty: Math.abs(r.diff) })),
        payouts: money.settlements.map((x) => ({ owner_id: x.ownerId, name: x.name, amount: x.payout })),
      } satisfies ClosingSummary,
      reopened_at: null,
      reopened_by: null,
    };
    await putAndQueue(db, 'event_closings', closing);
    for (const x of money.settlements) {
      await putAndQueue(db, 'consignment_settlements', {
        id: uuidv7(), circle_id: ctx.circleId, event_closing_id: closingId, owner_id: x.ownerId,
        sold_qty: x.soldQty, sales_amount: x.amount, fee_rate: x.feeRate, fee_amount: x.fee, payout_amount: x.payout,
        returned_qty: x.returnedQty,
        lines: x.lines.map((l) => ({ item_id: l.item.id, name: l.item.name, sold_qty: l.soldQty, amount: l.amount, returned_qty: l.returnedQty })),
      } satisfies ConsignmentSettlement);
    }
    return closing;
  });
}

/** 精算書を、相手にそのまま送れる文章にする */
export function settlementText(eventName: string, x: Settlement): string {
  const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`;
  return [
    `【精算書】${eventName}`,
    `${x.name} 様`,
    ...x.lines.map((l) => `${l.item.name}: 販売 ${l.soldQty}部 ${yen(l.amount)} / 返却 ${l.returnedQty}部`),
    `売上 ${yen(x.amount)}`,
    `受託手数料(${Math.round(x.feeRate * 100)}%) ${yen(x.fee)}`,
    `お支払い ${yen(x.payout)}`,
  ].join('\n');
}
