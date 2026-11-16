import type { HaifuDB } from '../db/local';
import type { ExpenseCategory } from '../db/types';
import { toCsv } from './backup';
import { EXPENSE_LABEL } from './catalog';
import { computeMoney, moneyAfterClosing, planCounts } from './closing';
import { consigneeState } from './consignOut';
import { deriveEvent, loadEventSnapshot } from './snapshot';

// 確定申告用の年間の集計(Issue #38)。1〜12月の、自分の収入・費用を足し合わせる。
// 税の判断(どの費用をどの年に入れるか)は人によって違うので、ここでは目安として2つの見方を出す

export interface YearEventRow {
  eventId: string;
  name: string;
  heldOn: string;
  /** 自分の分の売上 */
  own: number;
  /** 受託分の売上(受託元のもの。自分の収入ではない) */
  consigned: number;
  /** 受け取る受託手数料 */
  fee: number;
  /** キャッシュレスで受け取った売上(受託分を含む) */
  cashless: number;
  expenses: number;
  /** 売れた分の印刷費(原価) */
  cost: number;
  closed: boolean;
}

export interface YearPrintRow {
  itemName: string;
  edition: number;
  printedOn: string | null;
  qty: number;
  cost: number;
}

export interface YearSummary {
  year: number;
  events: YearEventRow[];
  /** 1〜12月(イベントの開催日の月) */
  months: { month: number; own: number; fee: number; expenses: number; shop: number }[];
  /** 委託に出した分(書店・ほかのサークル)。報告の日の年で数える(F-603) */
  shops: { name: string; sold: number; sales: number; fee: number; cost: number }[];
  expensesByCategory: { category: ExpenseCategory; label: string; amount: number }[];
  /** この年に刷った分の印刷費 */
  printRuns: YearPrintRow[];
  /** この年に初版を刷った品目の制作費 */
  production: { itemName: string; amount: number }[];
  /** 刷った日・制作費の年が分からないもの(年を決められないので合計に入れない) */
  undated: { printRuns: YearPrintRow[]; production: { itemName: string; amount: number }[] };
  totals: {
    own: number; consigned: number; fee: number; cashless: number; expenses: number;
    /** 売れた分の印刷費(原価) */
    cost: number;
    /** この年に刷った印刷費 */
    printing: number;
    production: number;
    /** 委託先で売れた売上と、委託先に引かれた手数料、売れた分の印刷費 */
    shopSales: number;
    shopFee: number;
    shopCost: number;
  };
  /** 差し引き: 印刷費を刷った年の費用にする見方と、売れた分だけ原価にする見方 */
  net: { byPrinting: number; byCost: number };
}

const yearOf = (date: string | null | undefined) => (date && /^\d{4}-/.test(date) ? Number(date.slice(0, 4)) : null);

/** 記録のある年(新しい順)。記録がなければ今年だけ */
export async function yearsWithData(db: HaifuDB, circleId: string): Promise<number[]> {
  const [events, items] = await Promise.all([
    db.events.where('circle_id').equals(circleId).filter((e) => !e.deleted_at).toArray(),
    db.items.where('circle_id').equals(circleId).toArray(),
  ]);
  const itemIds = new Set(items.map((i) => i.id));
  const runs = (await db.print_runs.toArray()).filter((r) => itemIds.has(r.item_id));
  const years = new Set<number>([new Date().getFullYear()]);
  for (const e of events) years.add(yearOf(e.held_on)!);
  for (const r of runs) {
    const y = yearOf(r.printed_on);
    if (y) years.add(y);
  }
  return [...years].sort((a, b) => b - a);
}

export async function loadYearSummary(db: HaifuDB, circleId: string, year: number): Promise<YearSummary> {
  const [events, items, owners, prodCosts] = await Promise.all([
    db.events.where('circle_id').equals(circleId).filter((e) => !e.deleted_at && yearOf(e.held_on) === year).toArray(),
    db.items.where('circle_id').equals(circleId).toArray(),
    db.owners.where('circle_id').equals(circleId).toArray(),
    db.production_costs.toArray(),
  ]);
  const selfIds = new Set(owners.filter((o) => o.is_self).map((o) => o.id));
  const ownItems = items.filter((i) => selfIds.has(i.owner_id));
  const ownIds = new Set(ownItems.map((i) => i.id));
  const nameOf = new Map(items.map((i) => [i.id, i.name]));
  const runs = (await db.print_runs.toArray()).filter((r) => ownIds.has(r.item_id));

  const rows: YearEventRow[] = [];
  const byCategory = new Map<ExpenseCategory, number>();
  for (const ev of events.sort((a, b) => a.held_on.localeCompare(b.held_on))) {
    const s = await loadEventSnapshot(db, ev.id);
    if (!s) continue;
    // 確定済みは、いまの記録から計算し直した値を使う(イベントの比較と同じ)
    const money = s.closing ? moneyAfterClosing(s) : computeMoney(s, planCounts(s));
    const { totals } = deriveEvent(s);
    for (const e of s.expenses) {
      const amount = e.actual_amount ?? e.planned_amount ?? 0;
      if (amount > 0) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + amount);
    }
    rows.push({
      eventId: ev.id, name: ev.name, heldOn: ev.held_on, own: money.own, consigned: money.consigned, fee: money.fee,
      cashless: totals.amount - totals.cash, expenses: money.expenses, cost: money.cost, closed: !!s.closing,
    });
  }

  const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, own: 0, fee: 0, expenses: 0, shop: 0 }));
  for (const r of rows) {
    const m = months[Number(r.heldOn.slice(5, 7)) - 1];
    m.own += r.own;
    m.fee += r.fee;
    m.expenses += r.expenses;
  }

  // 委託に出した分。1部あたりの印刷費は、刷り記録の合計 ÷ 刷った部数
  const unitCost = new Map<string, number>();
  for (const id of ownIds) {
    const rs = runs.filter((r) => r.item_id === id);
    const qty = rs.reduce((a, r) => a + r.qty, 0);
    if (qty > 0) unitCost.set(id, rs.reduce((a, r) => a + r.total_cost, 0) / qty);
  }
  const shops: YearSummary['shops'] = [];
  for (const s of (await consigneeState(db, circleId)).values()) {
    const row = { name: s.location.name, sold: 0, sales: 0, fee: 0, cost: 0 };
    for (const r of s.reports.filter((x) => yearOf(x.reported_on) === year)) {
      row.fee += r.fee_amount;
      for (const l of r.lines) {
        row.sold += l.qty;
        row.sales += l.qty * l.unit_price;
        row.cost += l.qty * (unitCost.get(l.item_id) ?? 0);
        months[Number(r.reported_on.slice(5, 7)) - 1].shop += l.qty * l.unit_price;
      }
    }
    row.cost = Math.round(row.cost);
    if (row.sold > 0) shops.push(row);
  }

  const printRow = (r: (typeof runs)[number]): YearPrintRow => ({
    itemName: nameOf.get(r.item_id) ?? '品目', edition: r.edition, printedOn: r.printed_on, qty: r.qty, cost: r.total_cost,
  });
  const printRuns = runs.filter((r) => yearOf(r.printed_on) === year).map(printRow).sort((a, b) => (a.printedOn ?? '').localeCompare(b.printedOn ?? ''));
  const undatedRuns = runs.filter((r) => !yearOf(r.printed_on)).map(printRow);

  // 制作費は初版に入れる(F-107)ので、初版を刷った年の費用にする。初版の刷った日がなければ年を決めない
  const prodByItem = new Map<string, number>();
  for (const c of prodCosts) {
    const id = c.item_id as string;
    if (ownIds.has(id)) prodByItem.set(id, (prodByItem.get(id) ?? 0) + Number(c.amount ?? 0));
  }
  const production: { itemName: string; amount: number }[] = [];
  const undatedProduction: { itemName: string; amount: number }[] = [];
  for (const [id, amount] of prodByItem) {
    if (amount <= 0) continue;
    const first = runs.filter((r) => r.item_id === id).sort((a, b) => a.edition - b.edition)[0];
    const y = yearOf(first?.printed_on);
    if (y === year) production.push({ itemName: nameOf.get(id) ?? '品目', amount });
    else if (y === null) undatedProduction.push({ itemName: nameOf.get(id) ?? '品目', amount });
  }

  const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
  const totals = {
    own: sum(rows, (r) => r.own), consigned: sum(rows, (r) => r.consigned), fee: sum(rows, (r) => r.fee),
    cashless: sum(rows, (r) => r.cashless), expenses: sum(rows, (r) => r.expenses), cost: sum(rows, (r) => r.cost),
    printing: sum(printRuns, (r) => r.cost), production: sum(production, (r) => r.amount),
    shopSales: sum(shops, (r) => r.sales), shopFee: sum(shops, (r) => r.fee), shopCost: sum(shops, (r) => r.cost),
  };
  const shopNet = totals.shopSales - totals.shopFee;
  return {
    year, events: rows, months, shops,
    expensesByCategory: (Object.keys(EXPENSE_LABEL) as ExpenseCategory[])
      .filter((c) => (byCategory.get(c) ?? 0) > 0)
      .map((c) => ({ category: c, label: EXPENSE_LABEL[c], amount: byCategory.get(c)! })),
    printRuns, production,
    undated: { printRuns: undatedRuns, production: undatedProduction },
    totals,
    net: {
      byPrinting: totals.own + totals.fee + shopNet - totals.expenses - totals.printing - totals.production,
      byCost: totals.own + totals.fee + shopNet - totals.expenses - totals.cost - totals.shopCost,
    },
  };
}

/** 表計算ソフト・会計ソフトに取り込める CSV(Issue #38) */
export function yearCsv(y: YearSummary): string {
  const out: (string | number | null)[][] = [
    ['区分', '項目', '日付', '金額', 'メモ'],
    ['収入', '自分の分の売上', '', y.totals.own, ''],
    ['収入', '受託手数料', '', y.totals.fee, ''],
    ...y.shops.map((s) => ['収入', `委託の売上: ${s.name}(${s.sold}部)`, '', s.sales, '委託先の売値']),
    ...y.shops.map((s) => ['経費', `委託先の手数料: ${s.name}`, '', s.fee, '']),
    ['参考', '受託分の売上(受託元のもの)', '', y.totals.consigned, '自分の収入ではない'],
    ['参考', 'キャッシュレスで受け取った分', '', y.totals.cashless, '受託分を含む'],
    ...y.expensesByCategory.map((c) => ['経費', c.label, '', c.amount, ''] as (string | number)[]),
    ...y.printRuns.map((r) => ['印刷費', `${r.itemName}(${r.edition === 1 ? '初版' : `第${r.edition}版`}・${r.qty}部)`, r.printedOn, r.cost, '刷った年の費用']),
    ...y.production.map((p) => ['制作費', p.itemName, '', p.amount, '初版を刷った年の費用']),
    ['参考', '売れた分の印刷費(原価)', '', y.totals.cost + y.totals.shopCost, '売れた分だけ原価にする見方(委託で売れた分を含む)'],
    ['差し引き', '印刷費を刷った年の費用にする見方', '', y.net.byPrinting, ''],
    ['差し引き', '売れた分だけ原価にする見方', '', y.net.byCost, '制作費を含まない'],
    [],
    ['イベント', '開催日', '自分の分の売上', '受託手数料', '受託分の売上', 'キャッシュレス', '経費', '原価', '確定'],
    ...y.events.map((e) => [e.name, e.heldOn, e.own, e.fee, e.consigned, e.cashless, e.expenses, e.cost, e.closed ? '済' : 'まだ']),
  ];
  if (y.undated.printRuns.length || y.undated.production.length) {
    out.push([], ['年の分からないもの(合計に入れていない)']);
    for (const r of y.undated.printRuns) out.push(['印刷費', `${r.itemName}(${r.edition === 1 ? '初版' : `第${r.edition}版`}・${r.qty}部)`, '', r.cost, '刷った日がない']);
    for (const p of y.undated.production) out.push(['制作費', p.itemName, '', p.amount, '初版の刷った日がない']);
  }
  return toCsv(out);
}
