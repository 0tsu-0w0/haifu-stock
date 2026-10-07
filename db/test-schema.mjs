import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const schemaPath = process.argv[2];
const db = new PGlite();
const U1 = '00000000-0000-0000-0000-0000000000a1'; // サークル主
const U2 = '00000000-0000-0000-0000-0000000000b2'; // 売り子
const id = () => crypto.randomUUID();
const DEV1 = id(), DEV2 = id();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m); } };
async function as(uid, fn) {
  await db.exec(`reset role; select set_config('test.uid', '${uid}', false); set role authenticated;`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
async function expectError(p, m) { try { await p; ok(false, m + '(エラーにならなかった)'); } catch (e) { ok(true, m + ' → ' + e.message); } }

await db.exec(`
  create role authenticated nologin; create role anon nologin;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
`);
await db.exec(readFileSync(schemaPath, 'utf8'));
await db.exec(`
  grant usage on schema public, app, auth to authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  grant usage on all sequences in schema public to authenticated;
  grant execute on all functions in schema app, auth to authenticated;
`);
console.log('スキーマ適用: OK');

const C = id();
await db.query(`insert into circles (id, name) values ($1, 'テストサークル')`, [C]);
await db.query(`insert into circle_members (circle_id, user_id, role) values ($1, $2, 'owner')`, [C, U1]);

const SELF = id(), OB = id(), A = id(), B = id(), AB = id(), FB = id(), HOME = id(), EV = id(), EVL = id();
const now = new Date().toISOString();

await as(U1, async () => {
  await db.query(`insert into owners (id, circle_id, name, is_self) values ($1,$2,'自分',true)`, [SELF, C]);
  await db.query(`insert into owners (id, circle_id, name, default_fee_rate) values ($1,$2,'サークルB',0.1)`, [OB, C]);
  await db.query(`insert into items (id, circle_id, owner_id, kind, name, price) values
     ($1,$5,$6,'book','新刊A',800), ($2,$5,$6,'book','既刊B',500), ($3,$5,$6,'set','A+Bセット',1200), ($4,$5,$7,'book','友人の本',600)`,
     [A, B, AB, FB, C, SELF, OB]);
  await db.query(`insert into set_components (set_item_id, component_item_id, circle_id, qty) values ($1,$2,$4,1),($1,$3,$4,1)`, [AB, A, B, C]);
  const pr = id();
  await db.query(`insert into print_runs (id, circle_id, item_id, qty, total_cost) values ($1,$2,$3,30,30000)`, [pr, C, A]);
  await db.query(`insert into locations (id, circle_id, kind, name) values ($1,$2,'storage','自宅')`, [HOME, C]);
  await db.query(`insert into events (id, circle_id, name, held_on, starts_at) values ($1,$2,'コミティア','2026-11-01','2026-11-01T11:00:00+09')`, [EV, C]);
  await db.query(`insert into locations (id, circle_id, kind, name, event_id) values ($1,$2,'event','コミティア',$3)`, [EVL, C, EV]);
  await db.query(`insert into event_items (event_id, item_id, circle_id, sort_order) values ($1,$2,$5,1),($1,$3,$5,2),($1,$4,$5,3),($1,$6,$5,4)`, [EV, A, B, AB, C, FB]);
  const mv = (item, qty, from, to, reason, extra = {}) => db.query(
    `insert into stock_movements (id, circle_id, item_id, qty, from_location_id, to_location_id, reason, event_id, transaction_id, print_run_id, device_id, recorded_by, recorded_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id(), C, item, qty, from, to, reason, extra.event ?? null, extra.txn ?? null, extra.pr ?? null, DEV1, U1, extra.at ?? now]);
  await mv(A, 30, null, HOME, 'print', { pr });
  await mv(A, 25, HOME, EVL, 'transfer', { event: EV });
  await mv(B, 12, null, EVL, 'print', { event: EV });
  await mv(FB, 12, null, EVL, 'consign_in', { event: EV });
  await db.query(`insert into cash_counts (event_id, phase, denomination, circle_id, count) values ($1,'float',1000,$2,10),($1,'float',100,$2,50)`, [EV, C]);
  await db.query(`insert into invites (circle_id, event_id, token_hash, created_by, expires_at) values ($1,$2, encode(sha256(convert_to('tok123','UTF8')),'hex'), $3, now() + interval '1 day')`, [C, EV, U1]);
});
ok(true, 'サークル主がマスタ・在庫・招待を登録');

// --- 売り子 ---
const T1 = id(), T2 = id(), T3 = id();
await as(U2, async () => {
  const before = await db.query(`select count(*)::int n from items`);
  ok(before.rows[0].n === 0, '招待を受ける前の売り子は品目を見られない');
  await db.query(`select app.redeem_invite('tok123')`);
  const r = await db.query(`select name from items order by name`);
  ok(r.rows.length === 4, '招待を受けた売り子はイベントの品目4件を見られる: ' + r.rows.map(x => x.name).join(','));

  // セット1 + 友人の本1 を1取引で販売
  await db.query(`insert into transactions (id, circle_id, event_id, type, paid_amount, device_id, recorded_by, recorded_at) values ($1,$2,$3,'sale',2000,$4,$5,'2026-11-01T11:20:00+09')`, [T1, C, EV, DEV2, U2]);
  await db.query(`insert into transaction_lines (id, circle_id, transaction_id, item_id, qty, unit_price) values ($1,$3,$2,$4,1,1200),($5,$3,$2,$6,1,600)`, [id(), T1, C, AB, id(), FB]);
  for (const [item] of [[A], [B], [FB]])
    await db.query(`insert into stock_movements (id, circle_id, item_id, qty, from_location_id, reason, event_id, transaction_id, device_id, recorded_by, recorded_at)
                    values ($1,$2,$3,1,$4,'sale',$5,$6,$7,$8,'2026-11-01T11:20:00+09')`, [id(), C, item, EVL, EV, T1, DEV2, U2]);
  // 新刊A を1部 → 取り消し
  await db.query(`insert into transactions (id, circle_id, event_id, type, device_id, recorded_by, recorded_at) values ($1,$2,$3,'sale',$4,$5,'2026-11-01T11:25:00+09')`, [T2, C, EV, DEV2, U2]);
  await db.query(`insert into transaction_lines (id, circle_id, transaction_id, item_id, qty, unit_price) values ($1,$2,$3,$4,1,800)`, [id(), C, T2, A]);
  await db.query(`insert into stock_movements (id, circle_id, item_id, qty, from_location_id, reason, event_id, transaction_id, device_id, recorded_by, recorded_at)
                  values ($1,$2,$3,1,$4,'sale',$5,$6,$7,$8,'2026-11-01T11:25:00+09')`, [id(), C, A, EVL, EV, T2, DEV2, U2]);
  await db.query(`insert into transactions (id, circle_id, event_id, type, voids_txn_id, device_id, recorded_by, recorded_at) values ($1,$2,$3,'void',$4,$5,$6,now())`, [T3, C, EV, T2, DEV2, U2]);

  // 同じ取引をもう一度送っても重複しない(同期の再送)
  await db.query(`insert into transactions (id, circle_id, event_id, type, device_id, recorded_by, recorded_at) values ($1,$2,$3,'sale',$4,$5,now()) on conflict (id) do nothing`, [T1, C, EV, DEV2, U2]);
  const n = await db.query(`select count(*)::int n from transactions where id=$1`, [T1]);
  ok(n.rows[0].n === 1, '再送しても取引は1件のまま(on conflict do nothing)');

  const upd = await db.query(`update items set price = 1 where id = $1`, [A]);
  ok(upd.affectedRows === 0, '売り子は価格を変更できない(RLSで0行)');
  await expectError(db.query(`insert into stock_movements (id, circle_id, item_id, qty, to_location_id, reason, event_id, device_id, recorded_by, recorded_at)
                              values ($1,$2,$3,5,$4,'adjust',$5,$6,$7,now())`, [id(), C, A, EVL, EV, DEV2, U2]), '売り子は在庫の調整を追加できない');
  await expectError(db.query(`select count(*) from cash_counts`).then(r => { if (r.rows[0].count !== 0) throw new Error('見えた'); throw new Error('0件'); }), '売り子に現金の記録は見えない');
});

// --- サークル主で集計 ---
await as(U1, async () => {
  const s = await db.query(`select i.name, brought, sold, given, remaining from v_event_item_summary v join items i on i.id = v.item_id where event_id=$1 order by i.name`, [EV]);
  console.log('  イベントの品目集計:', JSON.stringify(s.rows));
  const a = s.rows.find(r => r.name === '新刊A');
  ok(a.brought === 25 && a.sold === 1 && a.remaining === 24, '新刊A: 持込25・販売1(セット分のみ、取り消し分は除外)・残24');
  const own = await db.query(`select o.name, sold_qty, sales_amount, fee_amount from v_event_owner_sales v join owners o on o.id=v.owner_id where event_id=$1 order by o.name`, [EV]);
  console.log('  持ち主別売上:', JSON.stringify(own.rows));
  ok(own.rows.find(r => r.name === 'サークルB').fee_amount === 60, 'サークルBの受託手数料は 600 × 10% = 60円');
  const cash = await db.query(`select * from v_event_cash where event_id=$1`, [EV]);
  ok(cash.rows[0].float_amount === 15000 && cash.rows[0].sales_amount === 1800, '現金: 釣り銭15,000円・売上1,800円');
  const be = await db.query(`select name, break_even_qty, sold_qty, sold_amount from v_item_break_even where item_id=$1`, [A]);
  console.log('  損益分岐:', JSON.stringify(be.rows));
  ok(be.rows[0].break_even_qty === 38, '新刊Aの損益分岐は 30,000 ÷ 800 = 38部');
  const stock = await db.query(`select qty from v_stock where item_id=$1 and location_id=$2`, [A, HOME]);
  ok(stock.rows[0].qty === 5, '自宅在庫の新刊Aは 30 − 25 = 5部');

  const u = await db.query(`update transactions set paid_amount = 0 where id=$1`, [T1]);
  ok(u.affectedRows === 0, 'サークル主でも台帳は更新できない(RLSで0行)');
  const d = await db.query(`delete from transaction_lines where transaction_id=$1`, [T1]);
  ok(d.affectedRows === 0, 'サークル主でも台帳は削除できない(RLSで0行)');

  // 後勝ち
  await db.query(`update items set price = 900, client_updated_at = '2026-11-01T12:00:00+09' where id=$1`, [A]);
  await db.query(`update items set price = 700, client_updated_at = '2026-11-01T11:00:00+09' where id=$1`, [A]);
  const p = await db.query(`select price from items where id=$1`, [A]);
  ok(p.rows[0].price === 900, '古い時刻の更新は捨てられる(後勝ち)');

  const seq = await db.query(`select server_seq from items where id=$1`, [A]);
  ok(Number(seq.rows[0].server_seq) > 0, '更新すると差分同期の番号が振られる');

  // 二重の取り消しは不可
  await expectError(db.query(`insert into transactions (id, circle_id, event_id, type, voids_txn_id, device_id, recorded_by, recorded_at) values ($1,$2,$3,'void',$4,$5,$6,now())`, [id(), C, EV, T2, DEV1, U1]), '同じ取引は2回取り消せない');

  // 終了処理を確定
  await db.query(`insert into event_closings (circle_id, event_id, closed_by, cash_diff) values ($1,$2,$3,-100)`, [C, EV, U1]);
});

await as(U2, async () => {
  await expectError(db.query(`insert into transactions (id, circle_id, event_id, type, device_id, recorded_by, recorded_at) values ($1,$2,$3,'sale',$4,$5,now())`, [id(), C, EV, DEV2, U2]), '確定後は売り子が販売を追加できない');
});
await as(U1, async () => {
  await db.query(`insert into transactions (id, circle_id, event_id, type, is_correction, device_id, recorded_by, recorded_at) values ($1,$2,$3,'sale',true,$4,$5,now())`, [id(), C, EV, DEV1, U1]);
  ok(true, '確定後もサークル主の訂正(is_correction)は追加できる');
});

await expectError(db.query(`update transactions set paid_amount = 0 where id=$1`, [T1]), 'RLSを通らない管理者でもトリガーで更新を拒否');
await expectError(db.query(`delete from stock_movements where transaction_id=$1`, [T1]), 'RLSを通らない管理者でもトリガーで削除を拒否');

console.log(`\n${pass} 件成功 / ${fail} 件失敗`);
process.exit(fail ? 1 : 0);
