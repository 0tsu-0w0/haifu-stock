import { getMeta, setMeta, type HaifuDB } from '../db/local';
import { TABLES, outboxKey } from '../db/tables';
import type { GiveawayKind, Item, Movement, MovementReason, Owner } from '../db/types';
import { GIVE_LABEL } from './history';
import { activeTxnIds, lineAmount } from './ledger';
import { eventReport } from './report';
import { loadEventSnapshot } from './snapshot';

// バックアップの書き出しと読み込み(F-1002)、CSVの書き出し(F-707)

type Row = Record<string, unknown>;

export interface BackupFile {
  format: 'haifu-stock/backup';
  version: 1;
  circle_id: string;
  circle_name: string;
  exported_at: string;
  tables: Record<string, Row[]>;
}

/** このサークルのデータをすべて書き出す(端末の設定や送信待ちは含めない) */
export async function exportBackup(db: HaifuDB, circleId: string): Promise<BackupFile> {
  const tables: Record<string, Row[]> = {};
  for (const t of TABLES) {
    const rows = (await db.table(t.name).toArray()) as Row[];
    tables[t.name] = rows.filter((r) => (t.name === 'circles' ? r.id === circleId : r.circle_id === circleId));
  }
  const circle = tables.circles[0] as { name?: string } | undefined;
  return {
    format: 'haifu-stock/backup', version: 1, circle_id: circleId, circle_name: circle?.name ?? '',
    exported_at: new Date().toISOString(), tables,
  };
}

/**
 * バックアップを読み込む。端末にない行を足し、マスタは新しいほうを残す(台帳は追記だけなので、ない行を足すだけ)。
 * 足した行は送信待ちに積み、ログインしていればサーバーにも届くようにする。
 * この端末に別のサークルがあるときは、混ざらないよう読み込まない
 */
export async function importBackup(db: HaifuDB, file: BackupFile): Promise<{ added: number; updated: number }> {
  if (file?.format !== 'haifu-stock/backup' || file.version !== 1) throw new Error('このファイルは頒布レジのバックアップではありません');
  const current = await getMeta<string>(db, 'circle_id');
  if (current && current !== file.circle_id) {
    throw new Error(`この端末には別のサークルがあります。「${file.circle_name}」のバックアップは、まだサークルを作っていない端末で読み込んでください`);
  }
  let added = 0;
  let updated = 0;
  await db.transaction('rw', [...TABLES.map((t) => t.name), 'outbox', 'meta'], async () => {
    for (const t of TABLES) {
      const rows = file.tables[t.name] ?? [];
      if (rows.length === 0) continue;
      const keys = rows.map((r) => (t.pk.length === 1 ? r[t.pk[0]] : t.pk.map((k) => r[k])));
      const existing = (await db.table(t.name).bulkGet(keys as never[])) as (Row | undefined)[];
      const write: Row[] = [];
      rows.forEach((r, i) => {
        const cur = existing[i];
        if (!cur) {
          write.push(r);
          added++;
        } else if (!t.ledger && String(r.client_updated_at ?? '') > String(cur.client_updated_at ?? '')) {
          write.push(r);
          updated++;
        }
      });
      if (write.length === 0) continue;
      await db.table(t.name).bulkPut(write);
      await db.outbox.bulkAdd(write.map((r) => ({ table: t.name, key: outboxKey(t.name, r), queued_at: new Date().toISOString() })));
    }
    if (!current) {
      await setMeta(db, 'circle_id', file.circle_id);
      await setMeta(db, 'role', 'owner');
    }
  });
  return { added, updated };
}

// ---------------------------------------------------------------------------
// CSV(表計算ソフトで開ける形。Excel で文字化けしないよう、ダウンロード時に BOM を付ける)

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

const localTime = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

async function lookups(db: HaifuDB, circleId: string) {
  const [items, owners, events, locations] = await Promise.all([
    db.items.where('circle_id').equals(circleId).toArray(),
    db.owners.where('circle_id').equals(circleId).toArray(),
    db.events.where('circle_id').equals(circleId).toArray(),
    db.locations.where('circle_id').equals(circleId).toArray(),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const ownerById = new Map(owners.map((o) => [o.id, o]));
  const ownerName = (item?: Item) => {
    const o: Owner | undefined = item && ownerById.get(item.owner_id);
    return o ? (o.is_self ? '自分' : o.name) : '';
  };
  return { itemById, ownerName, eventById: new Map(events.map((e) => [e.id, e])), locById: new Map(locations.map((l) => [l.id, l])) };
}

/** 取引明細: 1行が取引の1品目。取り消した取引も「取り消し済み」として残す */
export async function salesCsv(db: HaifuDB, circleId: string): Promise<string> {
  const { itemById, ownerName, eventById } = await lookups(db, circleId);
  const txns = (await db.transactions.toArray()).filter((t) => t.circle_id === circleId);
  const active = activeTxnIds(txns);
  const lines = await db.transaction_lines.where('transaction_id').anyOf(txns.map((t) => t.id)).toArray();
  const txnById = new Map(txns.map((t) => [t.id, t]));
  const out: (string | number | null)[][] = [
    ['日時', 'イベント', '開催日', '種類', '取り消し', '品目', '持ち主', '部数', '単価', '値引き', '金額', '値引きの理由', '取引ID', '端末'],
  ];
  const sorted = lines
    .map((l) => ({ l, t: txnById.get(l.transaction_id)! }))
    .filter((x) => x.t && x.t.type !== 'void')
    .sort((a, b) => a.t.recorded_at.localeCompare(b.t.recorded_at));
  for (const { l, t } of sorted) {
    const ev = eventById.get(t.event_id);
    const item = itemById.get(l.item_id);
    out.push([
      localTime(t.recorded_at), ev?.name ?? '', ev?.held_on ?? '',
      t.type === 'sale' ? '販売' : GIVE_LABEL[t.giveaway_kind as GiveawayKind] ?? '無償出庫',
      active.has(t.id) ? '' : '取り消し済み',
      item?.name ?? '', ownerName(item), l.qty, l.unit_price, l.discount ?? 0, t.type === 'sale' ? lineAmount(l) : 0,
      t.note ?? '', t.id, t.device_id,
    ]);
  }
  return toCsv(out);
}

const REASON_LABEL: Record<MovementReason, string> = {
  print: '刷り上がり', transfer: '移動', sale: '販売', giveaway: '無償出庫', consign_in: '受託品の預かり',
  return_to_owner: '持ち主へ返却', adjust: '調整',
};

/** 在庫の履歴: 1行が在庫移動1件(F-205) */
export async function movementsCsv(db: HaifuDB, circleId: string): Promise<string> {
  const { itemById, ownerName, eventById, locById } = await lookups(db, circleId);
  const txns = (await db.transactions.toArray()).filter((t) => t.circle_id === circleId);
  const active = activeTxnIds(txns);
  const moves = (await db.stock_movements.toArray())
    .filter((m: Movement) => m.circle_id === circleId)
    .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  const out: (string | number | null)[][] = [['日時', '品目', '持ち主', '部数', '内容', '移動元', '移動先', 'イベント', 'メモ', '取り消し']];
  for (const m of moves) {
    const item = itemById.get(m.item_id);
    out.push([
      localTime(m.recorded_at), item?.name ?? '', ownerName(item), m.qty, REASON_LABEL[m.reason] ?? m.reason,
      m.from_location_id ? locById.get(m.from_location_id)?.name ?? '' : '(外から)',
      m.to_location_id ? locById.get(m.to_location_id)?.name ?? '' : '(外へ)',
      m.event_id ? eventById.get(m.event_id)?.name ?? '' : '', m.note ?? '',
      m.transaction_id && !active.has(m.transaction_id) ? '取り消し済み' : '',
    ]);
  }
  return toCsv(out);
}

/** イベント別の集計: 1行が1イベント(削除したイベントは除く) */
export async function eventsCsv(db: HaifuDB, circleId: string): Promise<string> {
  const events = (await db.events.where('circle_id').equals(circleId).toArray())
    .filter((e) => !e.deleted_at)
    .sort((a, b) => a.held_on.localeCompare(b.held_on));
  const out: (string | number | null)[][] = [['開催日', 'イベント', '売上', '販売部数', '取引件数', '客単価', '値引き', '自分の売上', '受託の売上', '経費']];
  for (const e of events) {
    const snap = await loadEventSnapshot(db, e.id);
    if (!snap) continue;
    const r = eventReport(snap);
    const own = r.rows.filter((x) => !x.ownerName).reduce((a, x) => a + x.amount, 0);
    const expenses = snap.expenses.reduce((a, x) => a + (x.actual_amount ?? x.planned_amount ?? 0), 0);
    out.push([e.held_on, e.name, r.amount, r.qty, r.txnCount, r.perCustomer, r.discount, own, r.amount - own, expenses]);
  }
  return toCsv(out);
}
