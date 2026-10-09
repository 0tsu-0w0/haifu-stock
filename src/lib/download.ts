/** 端末にファイルとして保存する(ダウンロード)。CSV は Excel で文字化けしないよう BOM を付ける */
export function downloadText(filename: string, text: string, type: 'text/csv' | 'application/json') {
  const body = type === 'text/csv' ? `\uFEFF${text}` : text;
  const url = URL.createObjectURL(new Blob([body], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const fileStamp = (d = new Date()) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
