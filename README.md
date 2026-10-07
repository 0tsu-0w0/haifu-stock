# haifu-stock

同人誌即売会などのイベントで、頒布物の持ち込み数・売上・釣り銭・受託分をスマホで記録し、終了後に自動で集計して、次回の刷り部数の目安や損益分岐点を出すアプリです。

サークル主と売り子が別々のスマホで同じデータに記録でき、会場で電波がなくても動くことを前提にしています。

## 今あるもの

| パス | 内容 |
|---|---|
| [docs/要件定義書.md](docs/要件定義書.md) | 要件定義書(v1.1) |
| [db/データベース設計.md](db/データベース設計.md) | データベース設計書 |
| [db/schema.sql](db/schema.sql) | Supabase(PostgreSQL)用のスキーマ。テーブル、RLS、集計ビュー |
| [db/test-schema.mjs](db/test-schema.mjs) | スキーマの検証スクリプト |
| [prototype/register.html](prototype/register.html) | レジ画面と終了処理の試作品(1ファイルで動く) |

## 試作品を動かす

`prototype/register.html` をスマホかPCのブラウザで開きます。見本データ入りで、記録はそのブラウザにだけ保存されます。

## スキーマを検証する

Node.js 20 以上が必要です。ブラウザ用の PostgreSQL(PGlite)にスキーマを流し、権限・集計・追記専用の台帳などを確かめます。

```bash
npm install
```

```bash
npm run test:db
```

## 技術構成(予定)

- PWA(React + Vite + TypeScript)
- 端末内の保存: IndexedDB(Dexie.js)
- 同期: Supabase(Postgres + Auth + Realtime)
