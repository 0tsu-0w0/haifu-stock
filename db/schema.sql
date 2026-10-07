-- =====================================================================
-- 頒布物・在庫管理アプリ スキーマ
-- 対象: Supabase (PostgreSQL 15+)
-- 対応する要件定義書: v1.1
--
-- 方針
--   * 主キーはすべてクライアントが発行する UUID(v7 推奨)。オフラインで作っても衝突しない
--   * 販売・無償出庫・取り消し・在庫移動は「追記だけ」の台帳。UPDATE/DELETE は禁止
--   * マスタは後勝ち(client_updated_at が新しい方を採用)
--   * 全テーブルに circle_id を持たせ、RLS はサークル単位で掛ける(将来の配布に備える)
--   * 集計値は保存せず、ビューで台帳から計算する
--   * 金額はすべて整数(円)
-- =====================================================================

create schema if not exists app;

-- ---------------------------------------------------------------------
-- 列挙型
-- ---------------------------------------------------------------------
create type member_role      as enum ('owner', 'staff');
create type item_kind        as enum ('book', 'goods', 'set');
create type location_kind    as enum ('storage', 'event', 'consignee');
create type txn_type         as enum ('sale', 'giveaway', 'void');
create type txn_source       as enum ('register', 'closing');
create type giveaway_kind    as enum ('sample', 'gift', 'damage', 'lost');
create type movement_reason  as enum (
  'print',            -- 刷り上がり(外 → 保管場所 / 直接搬入ならイベント)
  'transfer',         -- 保管場所どうし・保管場所 ↔ イベント
  'sale',             -- 販売(イベント → 外)
  'giveaway',         -- 見本誌・献本・汚損・紛失(イベント → 外)
  'consign_in',       -- 受託品を預かる(外 → イベント)
  'return_to_owner',  -- 受託品を返す(イベント → 外)
  'adjust'            -- 棚卸し・持ち込み数の修正
);
create type count_handling   as enum ('add_sale', 'lost', 'fix_bring', 'keep');
create type cash_phase       as enum ('float', 'close');
create type expense_category as enum ('booth_fee', 'transport', 'lodging', 'shipping', 'supplies', 'other');

-- 差分同期のための通し番号。行が作られる・更新されるたびに採番し直す
create sequence sync_seq;

-- ---------------------------------------------------------------------
-- 共通トリガー関数
-- ---------------------------------------------------------------------

-- 差分同期の番号と更新時刻を振る
create function app.touch_sync() returns trigger language plpgsql set search_path = public as $$
begin
  new.server_seq := nextval('sync_seq');
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end $$;

-- マスタの後勝ち: 端末で編集した時刻が古い更新は捨てる
create function app.last_write_wins() returns trigger language plpgsql set search_path = public as $$
begin
  if new.client_updated_at < old.client_updated_at then
    return null;
  end if;
  return new;
end $$;

-- 台帳は追記だけ
create function app.forbid_change() returns trigger language plpgsql set search_path = public as $$
begin
  raise exception '% は追記専用です。取り消しは void の取引を追加してください', tg_table_name
    using errcode = 'P0001';
end $$;

-- ---------------------------------------------------------------------
-- サークルとメンバー
-- ---------------------------------------------------------------------
create table circles (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (length(name) between 1 and 100),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  client_updated_at timestamptz not null default now(),
  server_seq        bigint not null default 0
);

create table circle_members (
  circle_id    uuid not null references circles(id) on delete cascade,
  user_id      uuid not null,               -- auth.users.id
  role         member_role not null,
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  server_seq   bigint not null default 0,
  primary key (circle_id, user_id)
);

-- ---------------------------------------------------------------------
-- マスタ
-- ---------------------------------------------------------------------
create table event_types (
  id                uuid primary key default gen_random_uuid(),
  circle_id         uuid not null references circles(id) on delete cascade,
  name              text not null,            -- 大規模総合 / 中規模 / オンリー など
  sort_order        int  not null default 0,
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  client_updated_at timestamptz not null default now(),
  server_seq        bigint not null default 0
);

-- 持ち主(自分 / 受託元のサークル)
create table owners (
  id                uuid primary key default gen_random_uuid(),
  circle_id         uuid not null references circles(id) on delete cascade,
  name              text not null,
  is_self           boolean not null default false,
  default_fee_rate  numeric(5,4) not null default 0 check (default_fee_rate between 0 and 1),
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  client_updated_at timestamptz not null default now(),
  server_seq        bigint not null default 0
);
create unique index owners_one_self on owners (circle_id) where is_self;

create table items (
  id                uuid primary key default gen_random_uuid(),
  circle_id         uuid not null references circles(id) on delete cascade,
  owner_id          uuid not null references owners(id),   -- 付け替え可能(F-709)
  kind              item_kind not null,
  name              text not null check (length(name) between 1 and 100),
  price             int  not null check (price >= 0),
  cover_path        text,                                   -- Supabase Storage のパス
  issued_on         date,
  spec              jsonb not null default '{}',            -- 判型・ページ数など
  memo              text,
  print_lot         int check (print_lot > 0),              -- 印刷所の部数の刻み(F-106)
  low_threshold     int not null default 3 check (low_threshold >= 0),
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  client_updated_at timestamptz not null default now(),
  server_seq        bigint not null default 0
);
create index items_circle on items (circle_id);

-- セットの構成(F-104)
create table set_components (
  set_item_id       uuid not null references items(id) on delete cascade,
  component_item_id uuid not null references items(id),
  circle_id         uuid not null references circles(id) on delete cascade,
  qty               int  not null check (qty > 0),
  updated_at        timestamptz not null default now(),
  server_seq        bigint not null default 0,
  primary key (set_item_id, component_item_id),
  check (set_item_id <> component_item_id)
);

-- 刷り記録(F-102)。印刷費は固定費として損益分岐に使う
create table print_runs (
  id                uuid primary key default gen_random_uuid(),
  circle_id         uuid not null references circles(id) on delete cascade,
  item_id           uuid not null references items(id),
  edition           int  not null default 1 check (edition >= 1),  -- 1 = 初版
  printed_on        date,
  qty               int  not null check (qty > 0),
  total_cost        int  not null check (total_cost >= 0),
  printer           text,
  memo              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  client_updated_at timestamptz not null default now(),
  server_seq        bigint not null default 0,
  unique (item_id, edition)
);

-- 印刷費以外の制作費(F-107)。初版の固定費に含める。作業時間は含めない
create table production_costs (
  id                uuid primary key default gen_random_uuid(),
  circle_id         uuid not null references circles(id) on delete cascade,
  item_id           uuid not null references items(id),
  label             text not null,
  amount            int  not null check (amount >= 0),
  paid_on           date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  client_updated_at timestamptz not null default now(),
  server_seq        bigint not null default 0
);

-- 印刷所の価格表(F-108)
create table print_price_tiers (
  id                uuid primary key default gen_random_uuid(),
  circle_id         uuid not null references circles(id) on delete cascade,
  item_id           uuid not null references items(id) on delete cascade,
  qty               int  not null check (qty > 0),
  total_cost        int  not null check (total_cost >= 0),
  updated_at        timestamptz not null default now(),
  client_updated_at timestamptz not null default now(),
  server_seq        bigint not null default 0,
  unique (item_id, qty)
);

-- ---------------------------------------------------------------------
-- イベント
-- ---------------------------------------------------------------------
create table events (
  id                uuid primary key default gen_random_uuid(),
  circle_id         uuid not null references circles(id) on delete cascade,
  event_type_id     uuid references event_types(id),
  name              text not null,
  held_on           date not null,
  venue             text,
  space_no          text,
  starts_at         timestamptz,
  ends_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  client_updated_at timestamptz not null default now(),
  server_seq        bigint not null default 0,
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create index events_circle on events (circle_id, held_on desc);

-- 在庫の置き場所。イベントも1か所として扱う(event_id が入る)
create table locations (
  id                uuid primary key default gen_random_uuid(),
  circle_id         uuid not null references circles(id) on delete cascade,
  kind              location_kind not null,
  name              text not null,
  event_id          uuid unique references events(id) on delete cascade,
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  client_updated_at timestamptz not null default now(),
  server_seq        bigint not null default 0,
  check ((kind = 'event') = (event_id is not null))
);

-- イベントに出す品目と、その日だけの設定。持ち込み数そのものは在庫移動で持つ
create table event_items (
  event_id          uuid not null references events(id) on delete cascade,
  item_id           uuid not null references items(id),
  circle_id         uuid not null references circles(id) on delete cascade,
  price_override    int check (price_override >= 0),   -- F-105
  planned_qty       int check (planned_qty >= 0),      -- 準備時の予定
  sort_order        int not null default 0,            -- レジのボタンの並び(F-401)
  updated_at        timestamptz not null default now(),
  client_updated_at timestamptz not null default now(),
  server_seq        bigint not null default 0,
  primary key (event_id, item_id)
);

-- 休憩・離席(F-411)。完売補正で販売時間から除く
create table event_breaks (
  id                uuid primary key,
  circle_id         uuid not null references circles(id) on delete cascade,
  event_id          uuid not null references events(id) on delete cascade,
  starts_at         timestamptz not null,
  ends_at           timestamptz,
  updated_at        timestamptz not null default now(),
  client_updated_at timestamptz not null default now(),
  server_seq        bigint not null default 0
);

create table expenses (
  id                uuid primary key default gen_random_uuid(),
  circle_id         uuid not null references circles(id) on delete cascade,
  event_id          uuid not null references events(id) on delete cascade,
  category          expense_category not null,
  label             text,
  planned_amount    int check (planned_amount >= 0),
  actual_amount     int check (actual_amount >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  client_updated_at timestamptz not null default now(),
  server_seq        bigint not null default 0
);

-- ---------------------------------------------------------------------
-- 端末と売り子の招待(F-1003〜1007)
-- ---------------------------------------------------------------------
create table invites (
  id          uuid primary key default gen_random_uuid(),
  circle_id   uuid not null references circles(id) on delete cascade,
  event_id    uuid not null references events(id) on delete cascade,
  token_hash  text not null unique,      -- QRコードのトークンは保存せず、SHA-256 だけ持つ
  created_by  uuid not null,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  server_seq  bigint not null default 0
);

-- 売り子(匿名ログインのユーザー)をイベント単位で参加させる
create table event_staff (
  event_id    uuid not null references events(id) on delete cascade,
  user_id     uuid not null,
  circle_id   uuid not null references circles(id) on delete cascade,
  invite_id   uuid references invites(id),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  joined_at   timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  server_seq  bigint not null default 0,
  primary key (event_id, user_id)
);

create table event_devices (
  id                uuid primary key,        -- 端末で発行して保存しておく
  circle_id         uuid not null references circles(id) on delete cascade,
  event_id          uuid not null references events(id) on delete cascade,
  user_id           uuid not null,
  label             text not null,           -- 「自分」「売り子」など
  role              member_role not null,
  last_synced_at    timestamptz,
  pending_count     int not null default 0,  -- 端末が申告する未送信件数(F-500)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  server_seq        bigint not null default 0
);

-- ---------------------------------------------------------------------
-- 台帳(追記だけ)
-- ---------------------------------------------------------------------

-- 取引: 販売・無償出庫・取り消し
create table transactions (
  id                  uuid primary key,
  circle_id           uuid not null references circles(id) on delete cascade,
  event_id            uuid not null references events(id),
  type                txn_type not null,
  source              txn_source not null default 'register',
  giveaway_kind       giveaway_kind,
  voids_txn_id        uuid references transactions(id),
  paid_amount         int check (paid_amount >= 0),    -- 預かり金額(任意。F-402)
  zero_stock_override boolean not null default false,  -- 残数0で記録した(F-406a)
  is_correction       boolean not null default false,  -- 確定後にサークル主が加えた訂正
  device_id           uuid not null,
  recorded_by         uuid not null,
  recorded_at         timestamptz not null,            -- 端末の時刻。時間帯別集計と完売時刻に使う
  received_at         timestamptz not null default now(),
  server_seq          bigint not null default 0,
  check ((type = 'giveaway') = (giveaway_kind is not null)),
  check ((type = 'void')     = (voids_txn_id  is not null)),
  check (type = 'sale' or paid_amount is null)
);
create index transactions_event on transactions (event_id, recorded_at);
create index transactions_voids on transactions (voids_txn_id) where voids_txn_id is not null;
create unique index transactions_one_void on transactions (voids_txn_id) where type = 'void';

create table transaction_lines (
  id              uuid primary key,
  circle_id       uuid not null references circles(id) on delete cascade,
  transaction_id  uuid not null references transactions(id),
  item_id         uuid not null references items(id),   -- セットはセットの品目のまま持つ
  qty             int  not null check (qty > 0),
  unit_price      int  not null check (unit_price >= 0), -- その時の価格を残す(無償出庫は 0)
  received_at     timestamptz not null default now(),
  server_seq      bigint not null default 0
);
create index transaction_lines_txn  on transaction_lines (transaction_id);
create index transaction_lines_item on transaction_lines (item_id);

-- 在庫移動: 在庫を変えるものはすべてここを通る
--   from が null = 外から入る(刷り上がり・受託品の預かり)
--   to   が null = 外へ出る(販売・無償出庫・返却)
-- セットの販売は構成品ごとに1行ずつ書く(その時の構成を固定して残すため)
create table stock_movements (
  id              uuid primary key,
  circle_id       uuid not null references circles(id) on delete cascade,
  item_id         uuid not null references items(id),
  qty             int  not null check (qty > 0),
  from_location_id uuid references locations(id),
  to_location_id   uuid references locations(id),
  reason          movement_reason not null,
  event_id        uuid references events(id),
  transaction_id  uuid references transactions(id),
  print_run_id    uuid references print_runs(id),
  note            text,
  device_id       uuid not null,
  recorded_by     uuid not null,
  recorded_at     timestamptz not null,
  received_at     timestamptz not null default now(),
  server_seq      bigint not null default 0,
  check (from_location_id is not null or to_location_id is not null),
  check (from_location_id is distinct from to_location_id),
  check (reason not in ('sale', 'giveaway') or transaction_id is not null)
);
create index stock_movements_item  on stock_movements (item_id);
create index stock_movements_event on stock_movements (event_id);
create index stock_movements_txn   on stock_movements (transaction_id);

-- ---------------------------------------------------------------------
-- 終了処理(F-500〜506)
-- ---------------------------------------------------------------------

-- 金種別の枚数。開始時の釣り銭準備金(float)と終了時の数え合わせ(close)
create table cash_counts (
  event_id          uuid not null references events(id) on delete cascade,
  phase             cash_phase not null,
  denomination      int  not null check (denomination in (10000, 5000, 2000, 1000, 500, 100, 50, 10, 5, 1)),
  circle_id         uuid not null references circles(id) on delete cascade,
  count             int  not null check (count >= 0),
  updated_at        timestamptz not null default now(),
  client_updated_at timestamptz not null default now(),
  server_seq        bigint not null default 0,
  primary key (event_id, phase, denomination)
);

-- 撤収時に数えた残数と、差異の扱い
create table closing_counts (
  event_id          uuid not null references events(id) on delete cascade,
  item_id           uuid not null references items(id),
  circle_id         uuid not null references circles(id) on delete cascade,
  counted_qty       int  not null check (counted_qty >= 0),
  handling          count_handling not null default 'keep',
  updated_at        timestamptz not null default now(),
  client_updated_at timestamptz not null default now(),
  server_seq        bigint not null default 0,
  primary key (event_id, item_id)
);

-- 確定の記録。reopened_at が空の行があればロック中
create table event_closings (
  id                uuid primary key default gen_random_uuid(),
  circle_id         uuid not null references circles(id) on delete cascade,
  event_id          uuid not null references events(id) on delete cascade,
  closed_at         timestamptz not null default now(),
  closed_by         uuid not null,
  cash_diff         int,                         -- 数え合わせの差異(未入力なら null)
  return_location_id uuid references locations(id),  -- 自分の分の戻し先
  summary           jsonb not null default '{}', -- 確定時点の集計のスナップショット
  reopened_at       timestamptz,
  reopened_by       uuid,
  updated_at        timestamptz not null default now(),
  server_seq        bigint not null default 0
);
create unique index event_closings_one_active on event_closings (event_id) where reopened_at is null;

-- 受託分の精算書のスナップショット(確定時に作る。手数料率をあとで変えても過去の精算は変わらない)
create table consignment_settlements (
  id              uuid primary key default gen_random_uuid(),
  circle_id       uuid not null references circles(id) on delete cascade,
  event_closing_id uuid not null references event_closings(id) on delete cascade,
  owner_id        uuid not null references owners(id),
  sold_qty        int not null,
  sales_amount    int not null,
  fee_rate        numeric(5,4) not null,
  fee_amount      int not null,
  payout_amount   int not null,
  returned_qty    int not null,
  lines           jsonb not null default '[]',   -- 品目別の内訳
  created_at      timestamptz not null default now(),
  server_seq      bigint not null default 0,
  unique (event_closing_id, owner_id)
);

-- ---------------------------------------------------------------------
-- トリガーの取り付け
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  -- 差分同期の番号
  foreach t in array array[
    'circles','circle_members','event_types','owners','items','set_components','print_runs',
    'production_costs','print_price_tiers','events','locations','event_items','event_breaks',
    'expenses','invites','event_staff','event_devices','transactions','transaction_lines',
    'stock_movements','cash_counts','closing_counts','event_closings','consignment_settlements']
  loop
    execute format('create trigger %I before insert or update on %I for each row execute function app.touch_sync()',
                   t || '_sync', t);
  end loop;

  -- 後勝ち
  foreach t in array array[
    'circles','event_types','owners','items','print_runs','production_costs','print_price_tiers',
    'events','locations','event_items','event_breaks','expenses','cash_counts','closing_counts']
  loop
    execute format('create trigger %I before update on %I for each row execute function app.last_write_wins()',
                   t || '_lww', t);
  end loop;

  -- 追記だけ
  foreach t in array array['transactions','transaction_lines','stock_movements','consignment_settlements']
  loop
    execute format('create trigger %I before update or delete on %I for each row execute function app.forbid_change()',
                   t || '_append_only', t);
  end loop;
end $$;

-- 確定済みイベントへの追記を止める(サークル主の訂正だけは通す)
-- 売り子には event_closings が RLS で見えないため security definer で判定する
create function app.is_event_closed(e uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from event_closings where event_id = e and reopened_at is null)
$$;

create function app.guard_closed_event() returns trigger language plpgsql set search_path = public as $$
declare corr boolean := false;
begin
  if tg_table_name = 'transactions' then
    corr := new.is_correction;
  elsif tg_table_name = 'stock_movements' and new.transaction_id is not null then
    select is_correction into corr from transactions where id = new.transaction_id;
  elsif tg_table_name = 'stock_movements' then
    corr := new.reason = 'adjust';
  end if;
  if new.event_id is not null and app.is_event_closed(new.event_id) and not coalesce(corr, false) then
    raise exception 'このイベントは終了処理を確定済みです' using errcode = 'P0002';
  end if;
  return new;
end $$;

create trigger transactions_guard_closed before insert on transactions
  for each row execute function app.guard_closed_event();
create trigger stock_movements_guard_closed before insert on stock_movements
  for each row execute function app.guard_closed_event();

-- 取り消しは同じイベントの販売・無償出庫だけを対象にできる
create function app.check_void_target() returns trigger language plpgsql set search_path = public as $$
begin
  if new.type = 'void' and not exists (
    select 1 from transactions t
    where t.id = new.voids_txn_id and t.event_id = new.event_id and t.type <> 'void'
  ) then
    raise exception '取り消しの対象が見つかりません' using errcode = 'P0003';
  end if;
  return new;
end $$;
create trigger transactions_void_target before insert on transactions
  for each row execute function app.check_void_target();

-- ---------------------------------------------------------------------
-- 権限の判定
-- ---------------------------------------------------------------------
create function app.is_member(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from circle_members where circle_id = c and user_id = auth.uid())
$$;

create function app.is_owner(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from circle_members
                 where circle_id = c and user_id = auth.uid() and role = 'owner')
$$;

create function app.is_event_staff(e uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from event_staff
                 where event_id = e and user_id = auth.uid()
                   and revoked_at is null and expires_at > now())
$$;

-- 売り子が見てよい品目: 参加中のイベントに出ている品目と、そのセットの構成品
create function app.staff_can_see_item(i uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from event_items ei
    where app.is_event_staff(ei.event_id)
      and (ei.item_id = i
           or exists (select 1 from set_components sc
                      where sc.set_item_id = ei.item_id and sc.component_item_id = i))
  )
$$;

-- ---------------------------------------------------------------------
-- アプリから呼ぶ関数(PostgREST の rpc で呼べるよう public に置く)
-- ---------------------------------------------------------------------

-- サークルを作り、呼んだ人をサークル主にする(F-1009)。
-- 端末で先に作ったサークルを後から同期するため、同じ id で何度呼んでもよい
create function public.create_circle(p_id uuid, p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'ログインが必要です' using errcode = 'P0004';
  end if;
  if exists (select 1 from circles where id = p_id) then
    if not app.is_owner(p_id) then
      raise exception 'このサークルのサークル主ではありません' using errcode = 'P0006';
    end if;
    return p_id;
  end if;
  insert into circles (id, name) values (p_id, p_name);
  insert into circle_members (circle_id, user_id, role) values (p_id, auth.uid(), 'owner');
  return p_id;
end $$;

-- 招待の受け取り(F-1005)。売り子は匿名ログインしてから呼ぶ
create function public.redeem_invite(token text) returns uuid
language plpgsql security definer set search_path = public as $$
declare inv invites;
begin
  if auth.uid() is null then
    raise exception 'ログインが必要です' using errcode = 'P0004';
  end if;
  select * into inv from invites
   where token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex')
     and revoked_at is null and expires_at > now();
  if not found then
    raise exception '招待が無効か、期限が切れています' using errcode = 'P0005';
  end if;
  insert into event_staff (event_id, user_id, circle_id, invite_id, expires_at)
  values (inv.event_id, auth.uid(), inv.circle_id, inv.id, inv.expires_at)
  on conflict (event_id, user_id) do update
    set expires_at = excluded.expires_at, revoked_at = null, invite_id = excluded.invite_id;
  return inv.event_id;
end $$;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'circles','circle_members','event_types','owners','items','set_components','print_runs',
    'production_costs','print_price_tiers','events','locations','event_items','event_breaks',
    'expenses','invites','event_staff','event_devices','transactions','transaction_lines',
    'stock_movements','cash_counts','closing_counts','event_closings','consignment_settlements']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;

  -- サークル主: 自分のサークルの行をすべて読み書きできる
  foreach t in array array[
    'event_types','owners','items','set_components','print_runs','production_costs',
    'print_price_tiers','events','locations','event_items','event_breaks','expenses','invites',
    'event_staff','event_devices','cash_counts','closing_counts','event_closings','consignment_settlements']
  loop
    execute format('create policy %I on %I for all to authenticated
                      using (app.is_owner(circle_id)) with check (app.is_owner(circle_id))',
                   t || '_owner_all', t);
  end loop;

  -- 台帳: サークル主は読む・追記する(更新・削除はトリガーで禁止)
  foreach t in array array['transactions','transaction_lines','stock_movements']
  loop
    execute format('create policy %I on %I for select to authenticated using (app.is_owner(circle_id))',
                   t || '_owner_select', t);
    execute format('create policy %I on %I for insert to authenticated with check (app.is_owner(circle_id))',
                   t || '_owner_insert', t);
  end loop;
end $$;

create policy circles_member_select on circles for select to authenticated
  using (app.is_member(id));
create policy circles_owner_update on circles for update to authenticated
  using (app.is_owner(id)) with check (app.is_owner(id));
create policy circle_members_select on circle_members for select to authenticated
  using (app.is_member(circle_id));
create policy circle_members_owner_write on circle_members for all to authenticated
  using (app.is_owner(circle_id)) with check (app.is_owner(circle_id));

-- 売り子: 参加中のイベントに必要なものだけを読む
create policy events_staff_select on events for select to authenticated
  using (app.is_event_staff(id));
create policy event_items_staff_select on event_items for select to authenticated
  using (app.is_event_staff(event_id));
create policy items_staff_select on items for select to authenticated
  using (app.staff_can_see_item(id));
create policy set_components_staff_select on set_components for select to authenticated
  using (app.staff_can_see_item(set_item_id));
create policy owners_staff_select on owners for select to authenticated
  using (exists (select 1 from items i where i.owner_id = owners.id and app.staff_can_see_item(i.id)));
create policy locations_staff_select on locations for select to authenticated
  using (event_id is not null and app.is_event_staff(event_id));
create policy event_staff_self_select on event_staff for select to authenticated
  using (user_id = auth.uid());

-- 売り子: 自分の端末の行
create policy event_devices_staff_rw on event_devices for all to authenticated
  using (user_id = auth.uid() and app.is_event_staff(event_id))
  with check (user_id = auth.uid() and role = 'staff' and app.is_event_staff(event_id));

-- 売り子: 販売・無償出庫・取り消しの追記と、そのイベントの台帳の読み取り(F-1004、F-1008)
create policy transactions_staff_select on transactions for select to authenticated
  using (app.is_event_staff(event_id));
create policy transactions_staff_insert on transactions for insert to authenticated
  with check (app.is_event_staff(event_id)
              and recorded_by = auth.uid()
              and source = 'register'
              and not is_correction);

create policy transaction_lines_staff_select on transaction_lines for select to authenticated
  using (exists (select 1 from transactions t
                 where t.id = transaction_id and app.is_event_staff(t.event_id)));
create policy transaction_lines_staff_insert on transaction_lines for insert to authenticated
  with check (exists (select 1 from transactions t
                      where t.id = transaction_id and t.recorded_by = auth.uid()
                        and app.is_event_staff(t.event_id)));

create policy stock_movements_staff_select on stock_movements for select to authenticated
  using (event_id is not null and app.is_event_staff(event_id));
create policy stock_movements_staff_insert on stock_movements for insert to authenticated
  with check (event_id is not null and app.is_event_staff(event_id)
              and recorded_by = auth.uid()
              and reason in ('sale', 'giveaway')
              and exists (select 1 from transactions t
                          where t.id = transaction_id and t.recorded_by = auth.uid()));

-- ---------------------------------------------------------------------
-- 関数の実行権限
--   RLS のポリシーとトリガーから app スキーマの関数を呼ぶので、ログインしたユーザーに使わせる。
--   アプリから呼ぶ関数は、ログインしたユーザーだけが呼べるようにする
-- ---------------------------------------------------------------------
grant usage on schema app to authenticated;
grant execute on all functions in schema app to authenticated;
revoke execute on function public.create_circle(uuid, text) from public, anon;
revoke execute on function public.redeem_invite(text) from public, anon;
grant execute on function public.create_circle(uuid, text) to authenticated;
grant execute on function public.redeem_invite(text) to authenticated;

-- ---------------------------------------------------------------------
-- 集計ビュー(すべて呼び出したユーザーの権限で動く)
-- ---------------------------------------------------------------------

-- 取り消されていない取引
create view v_active_transactions with (security_invoker = true) as
select t.*
from transactions t
where t.type <> 'void'
  and not exists (select 1 from transactions v where v.voids_txn_id = t.id);

-- 有効な在庫移動(取り消された取引に結び付く移動を除く)
create view v_valid_movements with (security_invoker = true) as
select m.*
from stock_movements m
where m.transaction_id is null
   or exists (select 1 from v_active_transactions a where a.id = m.transaction_id);

-- 品目 × 場所の現在庫(F-203)
create view v_stock with (security_invoker = true) as
select circle_id, item_id, location_id, sum(delta)::int as qty
from (
  select circle_id, item_id, to_location_id   as location_id,  qty as delta
    from v_valid_movements where to_location_id is not null
  union all
  select circle_id, item_id, from_location_id as location_id, -qty as delta
    from v_valid_movements where from_location_id is not null
) s
group by circle_id, item_id, location_id;

-- イベント × 品目の持ち込み・販売・残数・完売時刻(F-405、F-501、F-702)
create view v_event_item_summary with (security_invoker = true) as
with ev as (
  select l.event_id, l.id as location_id from locations l where l.kind = 'event'
), mv as (
  select ev.event_id, m.item_id, m.reason, m.recorded_at,
         case when m.to_location_id   = ev.location_id then m.qty else 0 end as qty_in,
         case when m.from_location_id = ev.location_id then m.qty else 0 end as qty_out
  from v_valid_movements m
  join ev on ev.location_id in (m.to_location_id, m.from_location_id)
)
select event_id, item_id,
  sum(qty_in)::int                                                       as brought,
  sum(case when reason = 'sale'     then qty_out else 0 end)::int        as sold,
  sum(case when reason = 'giveaway' then qty_out else 0 end)::int        as given,
  sum(case when reason in ('transfer', 'return_to_owner', 'adjust') then qty_out else 0 end)::int as taken_back,
  (sum(qty_in) - sum(qty_out))::int                                      as remaining,
  case when sum(qty_in) - sum(case when reason in ('sale', 'giveaway') then qty_out else 0 end) <= 0
       then max(case when reason in ('sale', 'giveaway') then recorded_at end)
  end                                                                    as sold_out_at
from mv
group by event_id, item_id;

-- 販売明細(取り消し分を除く)。持ち主は「今の」持ち主で見る(F-709 の付け替えが過去に効く)
create view v_sale_lines with (security_invoker = true) as
select t.circle_id, t.event_id, t.id as transaction_id, t.recorded_at, t.device_id,
       l.item_id, i.owner_id, o.is_self, l.qty, l.unit_price, l.qty * l.unit_price as amount
from v_active_transactions t
join transaction_lines l on l.transaction_id = t.id
join items  i on i.id = l.item_id
join owners o on o.id = i.owner_id
where t.type = 'sale';

-- イベント × 持ち主の売上(F-708 の切り替え、F-504 の精算書のもと)
create view v_event_owner_sales with (security_invoker = true) as
select s.circle_id, s.event_id, s.owner_id, s.is_self,
       sum(s.qty)::int    as sold_qty,
       sum(s.amount)::int as sales_amount,
       case when s.is_self then 0
            else round(sum(s.amount) * max(o.default_fee_rate))::int end as fee_amount
from v_sale_lines s
join owners o on o.id = s.owner_id
group by s.circle_id, s.event_id, s.owner_id, s.is_self;

-- 30分ごとの販売推移(F-703、完売補正の累積販売曲線のもと)
create view v_event_sales_by_slot with (security_invoker = true) as
select s.event_id, s.item_id,
       date_bin('30 minutes', s.recorded_at, coalesce(e.starts_at, date_trunc('day', s.recorded_at))) as slot,
       sum(s.qty)::int as qty, sum(s.amount)::int as amount
from v_sale_lines s
join events e on e.id = s.event_id
group by 1, 2, 3;

-- 現金の理論残高(F-408、F-502)
create view v_event_cash with (security_invoker = true) as
select e.id as event_id, e.circle_id,
  coalesce((select sum(denomination * count) from cash_counts c
            where c.event_id = e.id and c.phase = 'float'), 0)::int as float_amount,
  coalesce((select sum(amount) from v_sale_lines s where s.event_id = e.id), 0)::int as sales_amount,
  coalesce((select sum(denomination * count) from cash_counts c
            where c.event_id = e.id and c.phase = 'close'), 0)::int as counted_amount
from events e;

-- 頒布物別の損益分岐(F-1101、F-1102)。MVPは変動費0なので 固定費 ÷ 価格
create view v_item_break_even with (security_invoker = true) as
with fixed as (
  select i.id as item_id,
         coalesce((select sum(total_cost) from print_runs p where p.item_id = i.id), 0)
       + coalesce((select sum(amount) from production_costs c where c.item_id = i.id), 0) as fixed_cost,
         coalesce((select sum(qty) from print_runs p where p.item_id = i.id), 0)          as printed_qty
  from items i
  where i.kind <> 'set'
), sold as (
  -- 単品の販売 + セットで売れた分(セット価格を構成品の通常価格の比で按分)
  select l.item_id, sum(l.qty) as qty, sum(l.amount) as amount
  from v_sale_lines l join items i on i.id = l.item_id where i.kind <> 'set'
  group by l.item_id
  union all
  select sc.component_item_id, sum(l.qty * sc.qty),
         sum(l.amount * (ci.price * sc.qty)::numeric
             / nullif((select sum(c2.price * s2.qty) from set_components s2
                       join items c2 on c2.id = s2.component_item_id
                       where s2.set_item_id = l.item_id), 0))
  from v_sale_lines l
  join set_components sc on sc.set_item_id = l.item_id
  join items ci on ci.id = sc.component_item_id
  group by sc.component_item_id
)
select i.circle_id, i.id as item_id, i.name, i.price, f.fixed_cost, f.printed_qty,
       case when i.price > 0 then ceil(f.fixed_cost::numeric / i.price)::int end as break_even_qty,
       coalesce(sum(s.qty), 0)::int           as sold_qty,
       coalesce(round(sum(s.amount)), 0)::int as sold_amount
from items i
join fixed f on f.item_id = i.id
left join sold s on s.item_id = i.id
group by i.circle_id, i.id, i.name, i.price, f.fixed_cost, f.printed_qty;
