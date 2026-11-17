export const yen = (n: number): string =>
  (n < 0 ? '−¥' : '¥') + Math.abs(n).toLocaleString('ja-JP');

export const hhmm = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 端末の時刻での今日(YYYY-MM-DD) */
export const todayIso = (d = new Date()): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
