import { useLiveQuery } from 'dexie-react-hooks';
import { loadDeviceNames } from '../domain/devices';
import { db } from './db';

const EMPTY = new Map<string, string>();

/** サークルの端末の名前(id → 名前)。名前を付け直すと自動で更新される */
export function useDeviceNames(circleId: string | undefined): Map<string, string> {
  return useLiveQuery(() => (circleId ? loadDeviceNames(db, circleId) : EMPTY), [circleId]) ?? EMPTY;
}
