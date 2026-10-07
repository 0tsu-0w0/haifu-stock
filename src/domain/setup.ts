import { getMeta, putAndQueue, setMeta, type HaifuDB } from '../db/local';
import type { CashCount, EventItem, EventRow, Expense, Item, Location, Owner, PrintRun, SetComponent } from '../db/types';
import { uuidv7 } from '../lib/uuid';
import { moveStock, type Ctx } from './record';

// 端末の識別と、サークルの初期作成(F-1009)、見本データ

export async function deviceId(db: HaifuDB): Promise<string> {
  let id = await getMeta<string>(db, 'device_id');
  if (!id) {
    id = uuidv7();
    await setMeta(db, 'device_id', id);
  }
  return id;
}

/**
 * ログイン前でも記録できるよう、端末で仮のユーザーIDを持つ。
 * サークル主がログインしたら setUserId で本当のIDに置き換える
 */
export async function userId(db: HaifuDB): Promise<string> {
  let id = await getMeta<string>(db, 'user_id');
  if (!id) {
    id = uuidv7();
    await setMeta(db, 'user_id', id);
  }
  return id;
}

/** 起動時に一度呼び、端末IDと仮のユーザーIDを用意しておく */
export async function ensureIdentity(db: HaifuDB): Promise<void> {
  await deviceId(db);
  await userId(db);
}

/** 読み取りだけで済ませる(画面の liveQuery の中から呼ぶため書き込まない) */
export async function loadCtx(db: HaifuDB): Promise<Ctx | null> {
  const [circleId, device, user] = await Promise.all([
    getMeta<string>(db, 'circle_id'), getMeta<string>(db, 'device_id'), getMeta<string>(db, 'user_id'),
  ]);
  if (!circleId || !device || !user) return null;
  return { circleId, deviceId: device, userId: user };
}

const masterStamp = () => ({ client_updated_at: new Date().toISOString() });

/** サークルを作り、「自分」の持ち主と「自宅」の置き場所を用意する */
export async function createCircle(db: HaifuDB, name: string): Promise<Ctx> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('サークル名を入れてください');
  const circleId = uuidv7();
  await db.transaction('rw', ['circles', 'owners', 'locations', 'outbox', 'meta'], async () => {
    await putAndQueue(db, 'circles', { id: circleId, name: trimmed, ...masterStamp() });
    await putAndQueue(db, 'owners', {
      id: uuidv7(), circle_id: circleId, name: '自分', is_self: true, default_fee_rate: 0, archived_at: null, ...masterStamp(),
    } satisfies Owner);
    await putAndQueue(db, 'locations', {
      id: uuidv7(), circle_id: circleId, kind: 'storage', name: '自宅', event_id: null, archived_at: null, ...masterStamp(),
    } satisfies Location);
    await setMeta(db, 'circle_id', circleId);
    await setMeta(db, 'role', 'owner');
  });
  return { circleId, deviceId: await deviceId(db), userId: await userId(db) };
}

export async function createEvent(
  db: HaifuDB, ctx: Ctx, input: { name: string; heldOn: string; spaceNo?: string; startsAt?: string },
): Promise<EventRow> {
  const ev: EventRow = {
    id: uuidv7(), circle_id: ctx.circleId, event_type_id: null, name: input.name, held_on: input.heldOn,
    venue: null, space_no: input.spaceNo ?? null, starts_at: input.startsAt ?? null, ends_at: null, ...masterStamp(),
  };
  await db.transaction('rw', ['events', 'locations', 'outbox'], async () => {
    await putAndQueue(db, 'events', ev);
    await putAndQueue(db, 'locations', {
      id: uuidv7(), circle_id: ctx.circleId, kind: 'event', name: input.name, event_id: ev.id, archived_at: null, ...masterStamp(),
    } satisfies Location);
  });
  return ev;
}

interface SampleItem { key: string; name: string; price: number; stock?: number; printCost?: number; owner?: 'B' | 'C'; set?: [string, number][] }

const SAMPLE: SampleItem[] = [
  { key: 'A', name: '新刊A', price: 800, stock: 30, printCost: 30000 },
  { key: 'B', name: '既刊B', price: 500, stock: 12, printCost: 18000 },
  { key: 'C', name: '既刊C', price: 700, stock: 10, printCost: 21000 },
  { key: 'AB', name: 'A+Bセット', price: 1200, set: [['A', 1], ['B', 1]] },
  { key: 'D', name: '既刊D', price: 600, stock: 15, printCost: 16000 },
  { key: 'ac', name: 'アクスタ', price: 1000, stock: 20, printCost: 9000 },
  { key: 'pc', name: 'ポストカード', price: 150, stock: 40, printCost: 1600 },
  { key: 'fb', name: '友人の本', price: 600, stock: 12, owner: 'B' },
  { key: 'cp', name: 'コピー本', price: 200, stock: 15, owner: 'C' },
];

/** 見本データ: 受託元2つ、品目9つ、今日のイベント1つ。在庫は自宅から持ち込んだ状態 */
export async function addSampleData(db: HaifuDB, ctx: Ctx): Promise<EventRow> {
  const self = await db.owners.where('circle_id').equals(ctx.circleId).filter((o) => o.is_self).first();
  const home = await db.locations.where('circle_id').equals(ctx.circleId).filter((l) => l.kind === 'storage').first();
  if (!self || !home) throw new Error('サークルの初期設定が見つかりません');

  const owners: Record<string, Owner> = {};
  const ids: Record<string, string> = {};
  const today = new Date();
  const heldOn = today.toISOString().slice(0, 10);
  const startsAt = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 11, 0).toISOString();
  const ev = await createEvent(db, ctx, { name: 'コミティア(見本)', heldOn, spaceNo: 'A12a', startsAt });
  const evLoc = (await db.locations.where('event_id').equals(ev.id).first())!;

  await db.transaction('rw', ['owners', 'items', 'set_components', 'print_runs', 'event_items', 'cash_counts', 'expenses', 'outbox'], async () => {
    for (const [k, name, rate] of [['B', 'サークルB', 0], ['C', 'サークルC', 0.1]] as const) {
      owners[k] = { id: uuidv7(), circle_id: ctx.circleId, name, is_self: false, default_fee_rate: rate, archived_at: null, ...masterStamp() };
      await putAndQueue(db, 'owners', owners[k]);
    }
    let order = 0;
    for (const s of SAMPLE) {
      ids[s.key] = uuidv7();
      await putAndQueue(db, 'items', {
        id: ids[s.key], circle_id: ctx.circleId, owner_id: s.owner ? owners[s.owner].id : self.id,
        kind: s.set ? 'set' : s.key === 'ac' || s.key === 'pc' ? 'goods' : 'book',
        name: s.name, price: s.price, print_lot: null, low_threshold: 3, archived_at: null, ...masterStamp(),
      } satisfies Item);
      await putAndQueue(db, 'event_items', {
        event_id: ev.id, item_id: ids[s.key], circle_id: ctx.circleId, price_override: null,
        planned_qty: s.stock ?? null, sort_order: order++, ...masterStamp(),
      } satisfies EventItem);
    }
    for (const s of SAMPLE.filter((x) => x.set)) {
      for (const [k, qty] of s.set!) {
        await putAndQueue(db, 'set_components', {
          set_item_id: ids[s.key], component_item_id: ids[k], circle_id: ctx.circleId, qty,
        } satisfies SetComponent);
      }
    }
    for (const s of SAMPLE.filter((x) => x.printCost)) {
      await putAndQueue(db, 'print_runs', {
        id: uuidv7(), circle_id: ctx.circleId, item_id: ids[s.key], edition: 1,
        printed_on: heldOn, qty: s.stock! + 5, total_cost: s.printCost!, printer: null, ...masterStamp(),
      } satisfies PrintRun);
    }
    for (const [category, label, amount] of [['booth_fee', '出展費', 7000], ['transport', '交通費', 1280]] as const) {
      await putAndQueue(db, 'expenses', {
        id: uuidv7(), circle_id: ctx.circleId, event_id: ev.id, category, label,
        planned_amount: amount, actual_amount: amount, ...masterStamp(),
      } satisfies Expense);
    }
    for (const [denomination, count] of [[1000, 10], [500, 6], [100, 20]] as const) {
      await putAndQueue(db, 'cash_counts', {
        event_id: ev.id, phase: 'float', denomination, circle_id: ctx.circleId, count, ...masterStamp(),
      } satisfies CashCount);
    }
  });

  // 刷り上がり(自宅へ)→ 持ち込み(自宅 → イベント)。受託品はイベントで預かる
  const runs = await db.print_runs.toArray();
  for (const s of SAMPLE.filter((x) => x.stock)) {
    if (s.owner) {
      await moveStock(db, ctx, { itemId: ids[s.key], qty: s.stock!, from: null, to: evLoc.id, reason: 'consign_in' });
      continue;
    }
    const run = runs.find((r) => r.item_id === ids[s.key]);
    await moveStock(db, ctx, { itemId: ids[s.key], qty: s.stock! + 5, from: null, to: home.id, reason: 'print', printRunId: run?.id });
    await moveStock(db, ctx, { itemId: ids[s.key], qty: s.stock!, from: home.id, to: evLoc.id, reason: 'transfer' });
  }
  return ev;
}
