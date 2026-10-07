import { useLiveQuery } from 'dexie-react-hooks';
import { loadCtx } from '../domain/setup';
import type { Ctx } from '../domain/record';
import { db } from './db';

/** 端末のサークル・端末ID・ユーザーID。読み込み中は undefined、サークル未作成なら null */
export function useCtx(): Ctx | null | undefined {
  return useLiveQuery(() => loadCtx(db), []);
}
