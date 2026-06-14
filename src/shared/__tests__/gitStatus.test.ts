import { describe, it, expect } from 'vitest';
import { parsePorcelain, type GitFileStatus } from '../gitStatus';

describe('parsePorcelain', () => {
  it('maps modified, added, deleted, untracked', () => {
    const out = ' M src/a.ts\nA  src/b.ts\n D src/c.ts\n?? src/d.ts\n';
    expect(parsePorcelain(out)).toEqual<GitFileStatus[]>([
      { path: 'src/a.ts', code: 'M' },
      { path: 'src/b.ts', code: 'A' },
      { path: 'src/c.ts', code: 'D' },
      { path: 'src/d.ts', code: 'U' },
    ]);
  });

  it('takes the new name for renames', () => {
    const out = 'R  old.ts -> new.ts\n';
    expect(parsePorcelain(out)).toEqual([{ path: 'new.ts', code: 'R' }]);
  });

  it('ignores blank lines and returns [] for empty input', () => {
    expect(parsePorcelain('')).toEqual([]);
    expect(parsePorcelain('\n\n')).toEqual([]);
  });

  it('prefers staged code, falls back to worktree code', () => {
    expect(parsePorcelain('MM x\nAM y\n')).toEqual([
      { path: 'x', code: 'M' },
      { path: 'y', code: 'A' },
    ]);
  });

  it('strips surrounding quotes from paths with spaces', () => {
    expect(parsePorcelain(' M "src/my file.ts"\n')).toEqual([
      { path: 'src/my file.ts', code: 'M' },
    ]);
  });

  it('strips quotes and keeps the new name for quoted renames', () => {
    expect(parsePorcelain('R  "old name.ts" -> "new name.ts"\n')).toEqual([
      { path: 'new name.ts', code: 'R' },
    ]);
  });
});
