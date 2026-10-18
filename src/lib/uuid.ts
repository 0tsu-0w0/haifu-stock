// UUID v7: 先頭48ビットがミリ秒の時刻なので、作った順に並ぶ。
// 端末がオフラインで発行しても衝突しない主キーとして使う。
// 同じミリ秒に続けて作ったときは、前の値の末尾に1を足して、作った順に並ぶようにする
// (1回の販売の明細などが、カートに入れた順に並ぶように)

let lastTs = -1;
let last: Uint8Array<ArrayBuffer> | null = null;

export function uuidv7(now: number = Date.now()): string {
  let b: Uint8Array<ArrayBuffer>;
  if (now === lastTs && last) {
    b = last.slice();
    // 末尾の乱数の部分(9〜15バイト目)に1を足す。版とバリアントのビットには触れない
    let i = 15;
    while (i >= 9) {
      b[i] = (b[i] + 1) & 0xff;
      if (b[i] !== 0) break;
      i--;
    }
    if (i < 9) {
      // 桁あふれ(まず起きない)は、新しい乱数で作り直す
      b = new Uint8Array(16);
      crypto.getRandomValues(b);
    }
  } else {
    b = new Uint8Array(16);
    crypto.getRandomValues(b);
    // 同じミリ秒で何度足しても桁あふれしないよう、足す部分の先頭は0から始める
    b[9] &= 0x7f;
  }
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    b[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  lastTs = now;
  last = b;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
