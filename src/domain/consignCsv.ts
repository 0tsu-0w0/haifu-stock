import type { Item } from '../db/types';

// 書店などの販売実績のCSVを読み、売れた報告の下書きにする(F-604)。
// 書式は店ごとに違うので、見出しの言葉から「品名・数量・単価(または金額)」の列を探す。
// 品目は名前で突き合わせ、合わなかった行は画面で選んでもらう

/** CSV(カンマ・タブ区切り、"" で囲んだ値)を行と列に分ける */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const sep = (src.split(/\r?\n/, 1)[0].match(/\t/g)?.length ?? 0) > 0 ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((v) => v.trim())).filter((r) => r.some((v) => v !== ''));
}

/** ファイルの中身を文字にする。UTF-8 で読めなければ Shift_JIS として読む(書店のCSVに多い) */
export function decodeCsv(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

const NAME = /品名|商品名|作品名|タイトル|書名|品目|アイテム|title|name|item/i;
const QTY = /数量|販売数|売上数|売数|部数|冊数|個数|点数|qty|quantity|count/i;
const PRICE = /単価|売価|価格|定価|price/i;
const AMOUNT = /金額|売上|小計|合計|amount|total|sales/i;

const num = (s: string | undefined) => {
  const v = (s ?? '').normalize('NFKC').replace(/[¥\\,円部冊個点\s]/g, '');
  const n = v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : NaN;
};
/** 名前を比べやすくする(全角半角・空白・大文字小文字をそろえる) */
export const normName = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s　「」『』【】()[\]・:：\-―—~〜]/g, '');

export interface CsvSale {
  /** CSV に書いてあった品名 */
  name: string;
  qty: number;
  /** 1部の売値。CSV になければ null(品目の価格を使う) */
  unitPrice: number | null;
}

export interface CsvDraft {
  /** 品目と結びついた行(同じ品目はまとめる) */
  matched: { itemId: string; qty: number; unitPrice: number | null; names: string[] }[];
  /** どの品目か分からなかった行 */
  unmatched: CsvSale[];
}

/** CSV から、品名ごとの売れた部数と売値を取り出す */
export function readSalesCsv(text: string): CsvSale[] {
  const rows = parseCsv(text);
  const head = rows.findIndex((r) => r.some((v) => NAME.test(v)) && r.some((v) => QTY.test(v)));
  if (head < 0) throw new Error('品名と数量の列が見つかりません。1行目に「品名」「数量」のような見出しがあるCSVを使ってください');
  const h = rows[head];
  const nameCol = h.findIndex((v) => NAME.test(v));
  const qtyCol = h.findIndex((v) => QTY.test(v));
  // 「販売単価」のような見出しは単価、「売上金額」は金額。数量の列とは別の列から探す
  const priceCol = h.findIndex((v, i) => i !== qtyCol && i !== nameCol && PRICE.test(v) && !/金額/.test(v));
  const amountCol = h.findIndex((v, i) => i !== qtyCol && i !== nameCol && i !== priceCol && AMOUNT.test(v) && !QTY.test(v));
  const out = new Map<string, { name: string; qty: number; amount: number; priced: number }>();
  for (const r of rows.slice(head + 1)) {
    const name = r[nameCol] ?? '';
    const qty = num(r[qtyCol]);
    if (!name || /^(合計|小計|総計|計)$/.test(name) || !Number.isInteger(qty) || qty <= 0) continue;
    const price = priceCol >= 0 ? num(r[priceCol]) : NaN;
    const amount = amountCol >= 0 ? num(r[amountCol]) : NaN;
    const lineAmount = Number.isFinite(price) && price >= 0 ? price * qty : Number.isFinite(amount) && amount >= 0 ? amount : NaN;
    const key = normName(name);
    const x = out.get(key) ?? { name, qty: 0, amount: 0, priced: 0 };
    x.qty += qty;
    if (Number.isFinite(lineAmount)) { x.amount += lineAmount; x.priced += qty; }
    out.set(key, x);
  }
  if (out.size === 0) throw new Error('売れた部数のある行がありませんでした');
  // 同じ品名が何行かあるときは、売値をならす(金額の合計 ÷ 部数)
  return [...out.values()].map((x) => ({ name: x.name, qty: x.qty, unitPrice: x.priced === x.qty ? Math.round(x.amount / x.qty) : null }));
}

/** CSV の品名を品目に結びつける。同じ名前、なければ片方がもう片方を含む品目が1つだけのとき */
export function matchSales(sales: CsvSale[], items: Pick<Item, 'id' | 'name'>[]): CsvDraft {
  const names = items.map((i) => ({ id: i.id, key: normName(i.name) }));
  const matched = new Map<string, { itemId: string; qty: number; amount: number; priced: number; names: string[] }>();
  const unmatched: CsvSale[] = [];
  for (const s of sales) {
    const key = normName(s.name);
    const exact = names.filter((n) => n.key === key);
    const near = exact.length ? exact : names.filter((n) => n.key.length >= 2 && (key.includes(n.key) || n.key.includes(key)));
    if (near.length !== 1) { unmatched.push(s); continue; }
    const m = matched.get(near[0].id) ?? { itemId: near[0].id, qty: 0, amount: 0, priced: 0, names: [] };
    m.qty += s.qty;
    if (s.unitPrice !== null) { m.amount += s.unitPrice * s.qty; m.priced += s.qty; }
    m.names.push(s.name);
    matched.set(near[0].id, m);
  }
  return {
    matched: [...matched.values()].map((m) => ({ itemId: m.itemId, qty: m.qty, unitPrice: m.priced === m.qty ? Math.round(m.amount / m.qty) : null, names: m.names })),
    unmatched,
  };
}
