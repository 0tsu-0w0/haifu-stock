import type { GiveawayKind, Item, Txn, TxnLine } from '../db/types';
import { lineAmount } from './ledger';

// レジの履歴(F-404、F-1008)。取り消しも記録として残っているので、それを「取り消し済み」の印として重ねる

export const GIVE_LABEL: Record<GiveawayKind, string> = { sample: '見本誌', gift: '献本', damage: '汚損・破損', lost: '紛失' };

export type HistoryKind = 'sale' | 'giveaway';

export interface HistoryRow {
  txn: Txn;
  kind: HistoryKind;
  /** 「新刊A ×2・既刊B」のような中身 */
  label: string;
  /** 販売額(無償出庫は 0) */
  amount: number;
  qty: number;
  /** 値引き額(F-409) */
  discount: number;
  voided: Txn | null;
}

export function describeTxn(t: Txn, lines: TxnLine[], itemById: Map<string, Item>): string {
  const names = lines
    .map((l) => `${itemById.get(l.item_id)?.name ?? '不明な品目'}${l.qty > 1 ? ` ×${l.qty}` : ''}`)
    .join('・');
  return t.type === 'giveaway' && t.giveaway_kind ? `${GIVE_LABEL[t.giveaway_kind]}: ${names}` : names;
}

/** 新しい順。取り消しの取引そのものは行にせず、取り消された行に印を付ける */
export function historyRows(txns: Txn[], linesByTxn: Map<string, TxnLine[]>, itemById: Map<string, Item>): HistoryRow[] {
  const voidOf = new Map(txns.filter((t) => t.type === 'void').map((t) => [t.voids_txn_id!, t]));
  return txns
    .filter((t) => t.type !== 'void')
    .sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : a.recorded_at > b.recorded_at ? -1 : a.id < b.id ? 1 : -1))
    .map((t) => {
      const lines = linesByTxn.get(t.id) ?? [];
      return {
        txn: t,
        kind: t.type as HistoryKind,
        label: describeTxn(t, lines, itemById),
        amount: t.type === 'sale' ? lines.reduce((a, l) => a + lineAmount(l), 0) : 0,
        qty: lines.reduce((a, l) => a + l.qty, 0),
        discount: lines.reduce((a, l) => a + (l.discount ?? 0), 0),
        voided: voidOf.get(t.id) ?? null,
      };
    });
}

export type HistoryFilter = 'all' | 'sale' | 'giveaway' | 'voided';

export function filterHistory(rows: HistoryRow[], f: HistoryFilter): HistoryRow[] {
  if (f === 'all') return rows;
  if (f === 'voided') return rows.filter((r) => r.voided);
  return rows.filter((r) => r.kind === f && !r.voided);
}
