// 表紙画像を端末の中で小さくする(Issue #36)。
// 同期とバックアップに載せるので、長い辺を数百ピクセルにして、数十KBの data URL にする

/** 長い辺の大きさ(px)。レジのボタンや一覧に出すだけなので小さくてよい */
export const COVER_SIZE = 320;

/** 画像を読み込み、長い辺を COVER_SIZE 以下にして data URL にする(WebP。使えない端末は JPEG) */
export async function shrinkImage(file: Blob, size = COVER_SIZE, quality = 0.75): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('画像のファイルを選んでください');
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('この画像は読み込めませんでした(HEIC などは、JPEG か PNG にしてから選んでください)');
  });
  const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('画像を小さくできませんでした');
  g.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const webp = canvas.toDataURL('image/webp', quality);
  // WebP に対応していないブラウザは PNG を返すので、そのときは JPEG にする
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', quality);
}
