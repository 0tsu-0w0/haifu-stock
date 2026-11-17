import { putAndQueue, type HaifuDB } from '../db/local';
import type { Equipment, Expense } from '../db/types';
import { uuidv7 } from '../lib/uuid';
import { assertOpen } from './closing';
import type { Ctx } from './record';

// 備品(F-310)。ブックスタンドやテーブルクロスのように何回も使うものを登録し、
// 買った金額を見込みの回数で割って、使ったイベントの経費(消耗品)にする。
// 按分した金額は経費の行に書き込むので、収支・損益分岐・年間の集計はふつうの経費と同じに扱える。
// 見込みの回数を使い切ったら、それ以上は経費にしない(買った金額より多くは入れない)

const stamp = () => new Date().toISOString();
const amountOf = (e: Expense) => e.actual_amount ?? e.planned_amount ?? 0;

export interface EquipmentInput {
  id?: string;
  name: string;
  cost: number;
  uses: number;
  boughtOn?: string | null;
}

export async function saveEquipment(db: HaifuDB, ctx: Ctx, input: EquipmentInput): Promise<Equipment> {
  const name = input.name.trim();
  if (!name) throw new Error('備品の名前を入れてください');
  if (!Number.isInteger(input.cost) || input.cost < 0) throw new Error('金額は0円以上の整数で入れてください');
  if (!Number.isInteger(input.uses) || input.uses < 1 || input.uses > 1000) throw new Error('使う回数は1〜1000回で入れてください');
  const before = input.id ? await db.equipment.get(input.id) : undefined;
  const row: Equipment = {
    id: input.id ?? uuidv7(), circle_id: ctx.circleId, name, cost: input.cost, uses: input.uses,
    bought_on: input.boughtOn || null, archived_at: before?.archived_at ?? null, client_updated_at: stamp(),
  };
  await db.transaction('rw', ['equipment', 'outbox'], () => putAndQueue(db, 'equipment', row));
  return row;
}

/** しまう(一覧の「使う」に出さない)。按分した経費はそのまま残す */
export async function setEquipmentArchived(db: HaifuDB, id: string, archived: boolean): Promise<void> {
  await db.transaction('rw', ['equipment', 'outbox'], async () => {
    const e = await db.equipment.get(id);
    if (!e) throw new Error('備品が見つかりません');
    await putAndQueue(db, 'equipment', { ...e, archived_at: archived ? stamp() : null, client_updated_at: stamp() });
  });
}

export interface EquipmentState {
  equipment: Equipment;
  /** 経費にしたイベントの数(金額が0の行は消したものとして数えない) */
  used: number;
  /** 経費にした金額の合計 */
  allocated: number;
  /** まだ経費にしていない金額 */
  remaining: number;
  /** 次に使ったときに経費にする金額。使い切っていれば0 */
  nextShare: number;
}

/**
 * 次に使ったときの金額。均等に割った額(1円未満は切り捨て)にし、最後の回で端数を足して買った金額にそろえる。
 * 途中で金額を直していても、合計が買った金額を超えないようにする
 */
export function nextShareOf(eq: Pick<Equipment, 'cost' | 'uses'>, used: number, allocated: number): number {
  const remaining = Math.max(0, eq.cost - allocated);
  if (remaining === 0 || used >= eq.uses) return 0;
  if (used === eq.uses - 1) return remaining;
  return Math.min(remaining, Math.floor(eq.cost / eq.uses));
}

export function equipmentStates(equipment: Equipment[], expenses: Expense[]): EquipmentState[] {
  const byEq = new Map<string, Expense[]>();
  for (const e of expenses) {
    if (!e.equipment_id || amountOf(e) <= 0) continue;
    byEq.set(e.equipment_id, [...(byEq.get(e.equipment_id) ?? []), e]);
  }
  return equipment.map((eq) => {
    const rows = byEq.get(eq.id) ?? [];
    const used = new Set(rows.map((r) => r.event_id)).size;
    const allocated = rows.reduce((s, r) => s + amountOf(r), 0);
    return { equipment: eq, used, allocated, remaining: Math.max(0, eq.cost - allocated), nextShare: nextShareOf(eq, used, allocated) };
  });
}

/**
 * このイベントで備品を使えるかを調べる。使えるなら経費にする金額、使えないならその理由を返す。
 * 呼び出し側の Dexie トランザクションの中で使う(equipment と expenses を含めること)
 */
async function shareFor(db: HaifuDB, eventId: string, equipmentId: string): Promise<{ eq: Equipment; share: number } | { error: string }> {
  const eq = await db.equipment.get(equipmentId);
  if (!eq) return { error: '備品が見つかりません' };
  const rows = (await db.expenses.where('equipment_id').equals(equipmentId).toArray()).filter((e) => amountOf(e) > 0);
  if (rows.some((e) => e.event_id === eventId)) return { error: `${eq.name}は、このイベントの経費に入っています` };
  const [state] = equipmentStates([eq], rows);
  if (state.nextShare <= 0) return { error: `${eq.name}は、買った金額をすべて経費にし終えています` };
  return { eq, share: state.nextShare };
}

async function putShare(db: HaifuDB, ctx: Ctx, eventId: string, eq: Equipment, share: number): Promise<Expense> {
  const exp: Expense = {
    id: uuidv7(), circle_id: ctx.circleId, event_id: eventId, category: 'supplies', label: eq.name,
    planned_amount: share, actual_amount: share, equipment_id: eq.id, client_updated_at: stamp(),
  };
  await putAndQueue(db, 'expenses', exp);
  return exp;
}

/** 備品をこのイベントで使う。按分した金額を経費(消耗品)として入れる */
export async function applyEquipment(db: HaifuDB, ctx: Ctx, eventId: string, equipmentId: string): Promise<Expense> {
  return db.transaction('rw', ['equipment', 'expenses', 'outbox', 'event_closings'], async () => {
    await assertOpen(db, eventId);
    const r = await shareFor(db, eventId, equipmentId);
    if ('error' in r) throw new Error(r.error);
    return putShare(db, ctx, eventId, r.eq, r.share);
  });
}

/**
 * 使えるときだけ備品を使う(前回の経費を写すとき用)。使い切った・しまった・もう入っている備品は、何もせず null を返す。
 * エラーを投げないのは、Dexie では内側のトランザクションが失敗すると、外側で受け止めても全体が取り消されるため。
 * 呼び出し側のトランザクションの中で使う(equipment・expenses・outbox を含めること)
 */
export async function applyEquipmentIfPossible(db: HaifuDB, ctx: Ctx, eventId: string, equipmentId: string): Promise<Expense | null> {
  const r = await shareFor(db, eventId, equipmentId);
  if ('error' in r || r.eq.archived_at) return null;
  return putShare(db, ctx, eventId, r.eq, r.share);
}
