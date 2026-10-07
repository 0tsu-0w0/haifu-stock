import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { db } from '../app/db';
import { deriveEvent, loadEventSnapshot } from '../domain/snapshot';

/** イベントのデータを端末のデータベースから読み、記録のたびに自動で更新する */
export function useEventData(eventId: string) {
  const raw = useLiveQuery(() => loadEventSnapshot(db, eventId), [eventId]);
  return useMemo(() => (raw ? { ...raw, ...deriveEvent(raw) } : raw), [raw]);
}
