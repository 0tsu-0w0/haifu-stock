import { describe, expect, it } from 'vitest';
import { decodeCsv, matchSales, parseCsv, readSalesCsv } from './consignCsv';

describe('販売実績のCSVを読む(F-604)', () => {
  it('"" で囲んだ値・タブ区切り・BOM を読める', () => {
    expect(parseCsv('﻿a,"b,c","d ""e"""\r\n1,2,3\n\n')).toEqual([['a', 'b,c', 'd "e"'], ['1', '2', '3']]);
    expect(parseCsv('品名\t数量\nA\t2')).toEqual([['品名', '数量'], ['A', '2']]);
  });

  it('見出しから品名・数量・単価の列を探し、合計の行は読み飛ばす', () => {
    const csv = '○○書店 販売実績\n\n商品コード,商品名,販売数,販売単価,売上金額\n001,新刊A,3,"1,000","3,000"\n002,既刊B,0,500,0\n003,既刊C,２,700円,1400\n,合計,5,,4400\n';
    expect(readSalesCsv(csv)).toEqual([
      { name: '新刊A', qty: 3, unitPrice: 1000 },
      { name: '既刊C', qty: 2, unitPrice: 700 },
    ]);
  });

  it('単価がなければ金額から割り出し、どちらもなければ売値は空にする。同じ品名はまとめる', () => {
    expect(readSalesCsv('タイトル,数量,金額\nA,2,1600\nA,1,700\nB,1,')).toEqual([
      { name: 'A', qty: 3, unitPrice: 767 },
      { name: 'B', qty: 1, unitPrice: null },
    ]);
    expect(readSalesCsv('品名,部数\nA,4')).toEqual([{ name: 'A', qty: 4, unitPrice: null }]);
  });

  it('品名と数量の見出しがなければ、分かる言葉で断る', () => {
    expect(() => readSalesCsv('a,b\n1,2')).toThrow('品名と数量の列が見つかりません');
    expect(() => readSalesCsv('品名,数量\nA,0')).toThrow('売れた部数のある行がありません');
  });

  it('品目には名前で結びつける(全角半角・空白の違いは無視。あいまいなら結びつけない)', () => {
    const items = [{ id: 'a', name: '新刊A 上' }, { id: 'b', name: '新刊A 下' }, { id: 'c', name: 'ＡＢＣ本' }];
    const d = matchSales([
      { name: '新刊A上', qty: 2, unitPrice: 800 },
      { name: '【サークル名】ABC本', qty: 1, unitPrice: null },
      { name: '新刊A', qty: 5, unitPrice: 800 },
      { name: '知らない本', qty: 1, unitPrice: 100 },
    ], items);
    expect(d.matched).toEqual([
      { itemId: 'a', qty: 2, unitPrice: 800, names: ['新刊A上'] },
      { itemId: 'c', qty: 1, unitPrice: null, names: ['【サークル名】ABC本'] },
    ]);
    expect(d.unmatched.map((u) => u.name)).toEqual(['新刊A', '知らない本']);
  });

  it('Shift_JIS のファイルも読める', () => {
    const sjis = new Uint8Array([0x95, 0x69, 0x96, 0xbc, 0x2c, 0x90, 0x94, 0x97, 0xca]); // 品名,数量
    expect(decodeCsv(sjis.buffer)).toBe('品名,数量');
    expect(decodeCsv(new TextEncoder().encode('品名,数量').buffer as ArrayBuffer)).toBe('品名,数量');
  });
});
