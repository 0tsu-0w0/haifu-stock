import { putAndQueue, type HaifuDB } from '../db/local';
import type { ConsignmentReport, Item, Location, Movement } from '../db/types';
import { uuidv7 } from '../lib/uuid';
import { moveStock, type Ctx } from './record';

// 委託に出す(F-601〜603)。自分の本を書店やほかのサークルに預けて売ってもらう。
// - 委託先は置き場所(locations.kind = 'consignee')の一種。手数料率を持つ
// - 預ける・返してもらうは在庫移動(transfer)で記録する
// - 売れた分は委託先からの報告(consignment_reports)で持つ。在庫移動にはしない
//   委託先の残り = 預けた − 返ってきた − 報告で売れた
// - イベントの販売とは混ぜない(持ち込み数の目安・イベントの損益には入れない)

const stamp = () => new Date().toISOString();

const isConsignee = (l: Location | undefined): l is Location => l?.kind === 'consignee';

/** 委託先を足す・直す */
export async function saveConsignee(
  db: HaifuDB, ctx: Ctx, input: { id?: string; name: string; feeRate: number },
): Promise<Location> {
  const name = input.name.trim();
  if (!name) throw new Error('委託先の名前を入れてください');
  if (!(input.feeRate >= 0 && input.feeRate <= 1)) throw new Error('手数料は0〜100%で入れてください');
  return db.transaction('rw', ['locations', 'outbox'], async () => {
    const cur = input.id ? await db.locations.get(input.id) : undefined;
    if (input.id && !isConsignee(cur)) throw new Error('委託先が見つかりません');
    const same = await db.locations.where('circle_id').equals(ctx.circleId)
      .filter((l) => l.kind === 'consignee' && l.name === name && l.id !== cur?.id && !l.archived_at).first();
    if (same) throw new Error(`「${name}」はもうあります`);
    const loc: Location = {
      id: cur?.id ?? uuidv7(), circle_id: ctx.circleId, kind: 'consignee', name, event_id: null,
      fee_rate: input.feeRate, archived_at: cur?.archived_at ?? null, client_updated_at: stamp(),
    };
    await putAndQueue(db, 'locations', loc);
    return loc;
  });
}

/** 委託先をしまう・戻す。預けたままの本があるうちはしまえない */
export async function setConsigneeArchived(db: HaifuDB, locationId: string, archived: boolean): Promise<void> {
  const cur = await db.locations.get(locationId);
  if (!isConsignee(cur)) throw new Error('委託先が見つかりません');
  if (archived) {
    const left = (await consigneeState(db, cur.circle_id)).get(cur.id)?.left ?? 0;
    if (left > 0) throw new Error(`「${cur.name}」に${left}部預けたままです。先に売れた分の報告か、返してもらった記録を入れてください`);
  }
  await db.transaction('rw', ['locations', 'outbox'], () =>
    putAndQueue(db, 'locations', { ...cur, archived_at: archived ? stamp() : null, client_updated_at: stamp() }));
}

export interface ConsignItemState {
  itemId: string;
  sent: number;
  returned: number;
  sold: number;
  /** 委託先に残っている部数 */
  left: number;
  sales: number;
}

export interface ConsigneeState {
  location: Location;
  items: Map<string, ConsignItemState>;
  sent: number;
  returned: number;
  sold: number;
  left: number;
  sales: number;
  fee: number;
  /** 受け取る金額(売上 − 手数料) */
  net: number;
  reports: ConsignmentReport[];
  /** 最後に預けた・報告した日 */
  lastActivity: string | null;
}

/** 委託先ごとの、預けた・返ってきた・売れた・残り(F-603) */
export function summarizeConsignees(
  locations: Location[], movements: Movement[], reports: ConsignmentReport[],
): Map<string, ConsigneeState> {
  const out = new Map<string, ConsigneeState>();
  for (const l of locations.filter((x) => x.kind === 'consignee')) {
    out.set(l.id, { location: l, items: new Map(), sent: 0, returned: 0, sold: 0, left: 0, sales: 0, fee: 0, net: 0, reports: [], lastActivity: null });
  }
  const itemOf = (s: ConsigneeState, itemId: string) => {
    let x = s.items.get(itemId);
    if (!x) s.items.set(itemId, (x = { itemId, sent: 0, returned: 0, sold: 0, left: 0, sales: 0 }));
    return x;
  };
  const touch = (s: ConsigneeState, at: string) => {
    if (!s.lastActivity || at > s.lastActivity) s.lastActivity = at;
  };
  for (const m of movements) {
    const into = m.to_location_id ? out.get(m.to_location_id) : undefined;
    const from = m.from_location_id ? out.get(m.from_location_id) : undefined;
    if (into) {
      itemOf(into, m.item_id).sent += m.qty;
      touch(into, m.recorded_at.slice(0, 10));
    }
    if (from) itemOf(from, m.item_id).returned += m.qty;
  }
  for (const r of reports) {
    const s = out.get(r.location_id);
    if (!s || r.voided_at) continue;
    s.reports.push(r);
    s.fee += r.fee_amount;
    touch(s, r.reported_on);
    for (const l of r.lines) {
      const x = itemOf(s, l.item_id);
      x.sold += l.qty;
      x.sales += l.qty * l.unit_price;
    }
  }
  for (const s of out.values()) {
    for (const x of s.items.values()) {
      x.left = x.sent - x.returned - x.sold;
      s.sent += x.sent;
      s.returned += x.returned;
      s.sold += x.sold;
      s.left += x.left;
      s.sales += x.sales;
    }
    s.net = s.sales - s.fee;
    s.reports.sort((a, b) => b.reported_on.localeCompare(a.reported_on));
  }
  return out;
}

/** サークルの委託先の状態を、端末のデータベースから読む */
export async function consigneeState(db: HaifuDB, circleId: string): Promise<Map<string, ConsigneeState>> {
  const locations = await db.locations.where('circle_id').equals(circleId).filter((l) => l.kind === 'consignee').toArray();
  const ids = locations.map((l) => l.id);
  if (ids.length === 0) return new Map();
  const [ins, outs, reports] = await Promise.all([
    db.stock_movements.where('to_location_id').anyOf(ids).toArray(),
    db.stock_movements.where('from_location_id').anyOf(ids).toArray(),
    db.consignment_reports.where('location_id').anyOf(ids).toArray(),
  ]);
  const moves = [...new Map([...ins, ...outs].map((m) => [m.id, m])).values()];
  return summarizeConsignees(locations, moves, reports);
}

/** 委託先に預ける(F-601)。保管場所から委託先へ在庫を動かす */
export async function sendToConsignee(
  db: HaifuDB, ctx: Ctx, input: { to: string; from: string; lines: { itemId: string; qty: number }[] },
): Promise<{ moved: number }> {
  const [to, from] = await Promise.all([db.locations.get(input.to), db.locations.get(input.from)]);
  if (!isConsignee(to)) throw new Error('委託先が見つかりません');
  if (from?.kind !== 'storage') throw new Error('保管場所が見つかりません');
  const lines = input.lines.filter((l) => l.qty > 0);
  if (lines.length === 0) throw new Error('預ける部数を入れてください');
  for (const l of lines) if (!Number.isInteger(l.qty)) throw new Error('部数は整数で入れてください');
  for (const l of lines) {
    await moveStock(db, ctx, { itemId: l.itemId, qty: l.qty, from: from.id, to: to.id, reason: 'transfer', note: `委託: ${to.name}に預ける` });
  }
  return { moved: lines.length };
}

/** 委託先から返してもらう。残っている部数より多くは返せない */
export async function returnFromConsignee(
  db: HaifuDB, ctx: Ctx, input: { from: string; to: string; lines: { itemId: string; qty: number }[] },
): Promise<{ moved: number }> {
  const [from, to] = await Promise.all([db.locations.get(input.from), db.locations.get(input.to)]);
  if (!isConsignee(from)) throw new Error('委託先が見つかりません');
  if (to?.kind !== 'storage') throw new Error('保管場所が見つかりません');
  const state = (await consigneeState(db, from.circle_id)).get(from.id);
  const lines = input.lines.filter((l) => l.qty > 0);
  if (lines.length === 0) throw new Error('返ってきた部数を入れてください');
  for (const l of lines) {
    if (!Number.isInteger(l.qty)) throw new Error('部数は整数で入れてください');
    const left = state?.items.get(l.itemId)?.left ?? 0;
    if (l.qty > left) throw new Error(`${(await db.items.get(l.itemId))?.name ?? '品目'}は「${from.name}」に${left}部しか残っていません`);
  }
  for (const l of lines) {
    await moveStock(db, ctx, { itemId: l.itemId, qty: l.qty, from: from.id, to: to.id, reason: 'transfer', note: `委託: ${from.name}から返ってきた` });
  }
  return { moved: lines.length };
}

/** 手数料の既定値(売上 × 委託先の手数料率。1円未満は四捨五入) */
export const defaultFee = (sales: number, rate: number | null | undefined) => Math.round(sales * (rate ?? 0));

/**
 * 委託先からの報告を入れる(F-602)。売れた部数と単価、引かれた手数料。
 * 手数料を渡さなければ、委託先の手数料率で計算する。残っている部数より多くは売れない
 */
export async function recordConsignReport(
  db: HaifuDB, ctx: Ctx,
  input: { locationId: string; reportedOn: string; lines: { itemId: string; qty: number; unitPrice: number }[]; fee?: number | null; note?: string },
): Promise<ConsignmentReport> {
  const loc = await db.locations.get(input.locationId);
  if (!isConsignee(loc)) throw new Error('委託先が見つかりません');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.reportedOn)) throw new Error('報告の日を入れてください');
  const lines = input.lines.filter((l) => l.qty > 0);
  if (lines.length === 0) throw new Error('売れた部数を入れてください');
  const state = (await consigneeState(db, loc.circle_id)).get(loc.id);
  for (const l of lines) {
    if (!Number.isInteger(l.qty)) throw new Error('部数は整数で入れてください');
    if (!Number.isInteger(l.unitPrice) || l.unitPrice < 0) throw new Error('単価は0円以上の整数で入れてください');
    const left = state?.items.get(l.itemId)?.left ?? 0;
    if (l.qty > left) throw new Error(`${(await db.items.get(l.itemId))?.name ?? '品目'}は「${loc.name}」に${left}部しか預けていません`);
  }
  const sales = lines.reduce((a, l) => a + l.qty * l.unitPrice, 0);
  const fee = input.fee ?? defaultFee(sales, loc.fee_rate);
  if (!Number.isInteger(fee) || fee < 0) throw new Error('手数料は0円以上の整数で入れてください');
  if (fee > sales) throw new Error('手数料が売上より多くなっています');
  const report: ConsignmentReport = {
    id: uuidv7(), circle_id: ctx.circleId, location_id: loc.id, reported_on: input.reportedOn,
    lines: lines.map((l) => ({ item_id: l.itemId, qty: l.qty, unit_price: l.unitPrice })),
    sales_amount: sales, fee_amount: fee, note: input.note?.trim() || null, voided_at: null, client_updated_at: stamp(),
  };
  await db.transaction('rw', ['consignment_reports', 'outbox'], () => putAndQueue(db, 'consignment_reports', report));
  return report;
}

/** 報告を取り消す・戻す(入れ間違い) */
export async function setConsignReportVoided(db: HaifuDB, reportId: string, voided: boolean): Promise<void> {
  await db.transaction('rw', ['consignment_reports', 'outbox'], async () => {
    const cur = await db.consignment_reports.get(reportId);
    if (!cur) throw new Error('報告が見つかりません');
    await putAndQueue(db, 'consignment_reports', { ...cur, voided_at: voided ? stamp() : null, client_updated_at: stamp() });
  });
}

export interface ConsignAnalysis {
  /** 委託先ごと(期間内の報告だけで数える) */
  shops: { id: string; name: string; feeRate: number; sold: number; sales: number; fee: number; net: number; left: number }[];
  /** 品目ごとの、イベントで売れた分と委託で売れた分 */
  items: { itemId: string; name: string; eventQty: number; eventSales: number; shopQty: number; shopSales: number }[];
  totals: { eventSales: number; shopSales: number; shopFee: number; shopNet: number; shopLeft: number };
}

/**
 * イベントの販売と委託の販売を分けて並べる(F-603)。year を渡すとその年(報告の日・開催日)だけ。
 * eventSales は品目ごとのイベントでの売上(自分の分。呼ぶ側で計算して渡す)
 */
export function consignAnalysis(
  states: Map<string, ConsigneeState>, items: Pick<Item, 'id' | 'name'>[],
  eventSales: Map<string, { qty: number; sales: number }>, year?: number,
): ConsignAnalysis {
  const inYear = (d: string) => year === undefined || d.startsWith(`${year}-`);
  const shopByItem = new Map<string, { qty: number; sales: number }>();
  const shops: ConsignAnalysis['shops'] = [];
  for (const s of states.values()) {
    let sold = 0, sales = 0, fee = 0;
    for (const r of s.reports.filter((x) => inYear(x.reported_on))) {
      fee += r.fee_amount;
      for (const l of r.lines) {
        sold += l.qty;
        sales += l.qty * l.unit_price;
        const x = shopByItem.get(l.item_id) ?? { qty: 0, sales: 0 };
        x.qty += l.qty;
        x.sales += l.qty * l.unit_price;
        shopByItem.set(l.item_id, x);
      }
    }
    if (sold === 0 && s.left === 0 && s.location.archived_at) continue;
    shops.push({ id: s.location.id, name: s.location.name, feeRate: s.location.fee_rate ?? 0, sold, sales, fee, net: sales - fee, left: s.left });
  }
  const ids = new Set([...eventSales.keys(), ...shopByItem.keys()]);
  const rows = items.filter((i) => ids.has(i.id)).map((i) => ({
    itemId: i.id, name: i.name,
    eventQty: eventSales.get(i.id)?.qty ?? 0, eventSales: eventSales.get(i.id)?.sales ?? 0,
    shopQty: shopByItem.get(i.id)?.qty ?? 0, shopSales: shopByItem.get(i.id)?.sales ?? 0,
  })).filter((r) => r.eventQty || r.shopQty)
    .sort((a, b) => b.eventSales + b.shopSales - (a.eventSales + a.shopSales));
  const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
  return {
    shops: shops.sort((a, b) => b.sales - a.sales || a.name.localeCompare(b.name, 'ja')),
    items: rows,
    totals: {
      eventSales: sum(rows, (r) => r.eventSales), shopSales: sum(shops, (s) => s.sales), shopFee: sum(shops, (s) => s.fee),
      shopNet: sum(shops, (s) => s.net), shopLeft: sum(shops, (s) => s.left),
    },
  };
}
