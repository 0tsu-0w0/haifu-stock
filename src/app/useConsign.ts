import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';

/** サークルに受託元がいるか(Issue #22)。読み込み中は false */
export function useHasConsignors(circleId: string | undefined): boolean {
  return useLiveQuery(
    async () => (circleId ? (await db.owners.where('circle_id').equals(circleId).filter((o) => !o.is_self).count()) > 0 : false),
    [circleId],
  ) ?? false;
}
