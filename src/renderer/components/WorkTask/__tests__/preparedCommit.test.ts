import { describe, it, expect } from 'vitest';
import {
  buildPreparedCommitLine,
  shellQuote,
  PREPARED_COMMIT_PATH_CAP,
} from '../WorktaskCleanupView';

// C-4 — the line "Commit & close" types into the task's pane. It must name the
// changed paths explicitly: `git add -A` in a worktree an agent is still
// working in stages whatever else is lying around.

describe('shellQuote', () => {
  it('quotes a path with spaces and keeps a literal quote literal', () => {
    expect(shellQuote('src/a b.ts')).toBe("'src/a b.ts'");
    expect(shellQuote("it's.ts")).toBe("'it'\\''s.ts'");
    expect(shellQuote('a;rm -rf /')).toBe("'a;rm -rf /'");
  });
});

describe('buildPreparedCommitLine', () => {
  it('lists the changed paths explicitly — never -A', () => {
    const line = buildPreparedCommitLine(['b.ts', 'a.ts'], 'fix the thing');
    expect(line).toBe("git add -- 'a.ts' 'b.ts' && git commit -m 'wip: fix the thing'");
    expect(line).not.toContain('add -A');
  });

  it('dedupes paths and collapses whitespace in the subject', () => {
    expect(buildPreparedCommitLine(['a.ts', 'a.ts', ' '], 'two\n  words')).toBe(
      "git add -- 'a.ts' && git commit -m 'wip: two words'",
    );
  });

  it('returns null when there is nothing to commit', () => {
    expect(buildPreparedCommitLine([], 'x')).toBeNull();
    expect(buildPreparedCommitLine(['', '   '], 'x')).toBeNull();
  });

  it('refuses to build an unreadable line past the path cap', () => {
    const many = Array.from({ length: PREPARED_COMMIT_PATH_CAP + 1 }, (_, i) => `f${i}.ts`);
    expect(buildPreparedCommitLine(many, 'x')).toBeNull();
    expect(buildPreparedCommitLine(many.slice(0, PREPARED_COMMIT_PATH_CAP), 'x')).not.toBeNull();
  });

  it('falls back to a subject when the task has no title', () => {
    expect(buildPreparedCommitLine(['a.ts'], '   ')).toBe(
      "git add -- 'a.ts' && git commit -m 'wip: task'",
    );
  });
});
