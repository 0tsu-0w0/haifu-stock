export const yen = (n: number): string =>
  (n < 0 ? '−¥' : '¥') + Math.abs(n).toLocaleString('ja-JP');

export const hhmm = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
