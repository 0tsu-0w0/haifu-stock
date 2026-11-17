import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// サーバーを差し替えられるように(Issue #45)、Supabase に触るのは src/server/supabase の中だけにする

const SRC = join(__dirname, '..');
const ALLOWED = join(SRC, 'server', 'supabase');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe('サーバーの境目', () => {
  it('Supabase のライブラリと実装を読み込むのは src/server だけ', () => {
    const bad = files(SRC)
      .filter((p) => !p.startsWith(ALLOWED + sep) && p !== join(SRC, 'server', 'index.ts'))
      .filter((p) => /from '(@supabase\/|[./]+\/server\/supabase|\.\/supabase)/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(SRC, p));
    expect(bad).toEqual([]);
  });
});
