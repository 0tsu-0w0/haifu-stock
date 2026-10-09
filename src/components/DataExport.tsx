import { useRef, useState } from 'react';
import { db } from '../app/db';
import type { Ctx } from '../domain/record';
import { eventsCsv, exportBackup, importBackup, movementsCsv, salesCsv, type BackupFile } from '../domain/backup';
import { downloadText, fileStamp } from '../lib/download';
import { useToast } from './Toast';

/** 設定画面の「データ」: バックアップの書き出し・読み込みと、CSVの書き出し(F-1002、F-707) */
export function DataExport({ ctx }: { ctx: Ctx }) {
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    try {
      const msg = await fn();
      if (msg) toast(msg);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const csv = (name: string, make: () => Promise<string>) => run(async () => {
    downloadText(`haifu-${name}-${fileStamp()}.csv`, await make(), 'text/csv');
  });

  return (
    <>
      <div className="card">
        <b>バックアップ</b>
        <p className="note">
          この端末にあるサークルのデータを、1つのファイルに書き出します。機種変更や故障に備えて、イベントのあとに保存しておくと安心です。
          読み込みは、まだサークルを作っていない端末(新しいスマホなど)で行います。同じファイルを何度読み込んでも重複しません。
        </p>
        <div className="btns">
          <button
            className="sbtn acc" disabled={busy}
            onClick={() => void run(async () => {
              const b = await exportBackup(db, ctx.circleId);
              downloadText(`haifu-backup-${fileStamp()}.json`, JSON.stringify(b), 'application/json');
              return 'バックアップを書き出しました';
            })}
          >
            書き出す
          </button>
          <button className="sbtn" disabled={busy} onClick={() => file.current?.click()}>読み込む</button>
          <input
            ref={file} type="file" accept="application/json,.json" hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              void run(async () => {
                let parsed: BackupFile;
                try {
                  parsed = JSON.parse(await f.text());
                } catch {
                  throw new Error('ファイルを読めませんでした。頒布レジのバックアップか確かめてください');
                }
                const r = await importBackup(db, parsed);
                return r.added || r.updated ? `読み込みました(追加 ${r.added}件・更新 ${r.updated}件)` : 'すべて読み込み済みでした';
              });
            }}
          />
        </div>
      </div>

      <div className="card">
        <b>CSV(表計算ソフト用)</b>
        <p className="note">Excel や Googleスプレッドシートで開けます。どの表にも持ち主の列があります。</p>
        <div className="csv-list">
          <button className="sbtn" disabled={busy} onClick={() => void csv('sales', () => salesCsv(db, ctx.circleId))}>取引明細</button>
          <button className="sbtn" disabled={busy} onClick={() => void csv('stock', () => movementsCsv(db, ctx.circleId))}>在庫の履歴</button>
          <button className="sbtn" disabled={busy} onClick={() => void csv('events', () => eventsCsv(db, ctx.circleId))}>イベント別の集計</button>
        </div>
      </div>
    </>
  );
}
