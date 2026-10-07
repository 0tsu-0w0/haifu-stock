import { HaifuDB } from '../db/local';

export const db = new HaifuDB();

// ブラウザに保存領域を消されにくくする(会場で記録を失わないため。F-1001)
if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
  void navigator.storage.persist();
}
