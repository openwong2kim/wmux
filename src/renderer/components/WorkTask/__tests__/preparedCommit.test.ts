import { describe, it, expect } from 'vitest';
import {
  buildPreparedCommitLine,
  preparedCommitSupported,
  resolveCommitTargetPty,
  shellQuote,
  PREPARED_COMMIT_PATH_CAP,
} from '../WorktaskCleanupView';

// C-4 — the line "Commit & close" types into the task's pane. It must name the
// changed paths explicitly: `git add -A` in a worktree an agent is still
// working in stages whatever else is lying around.

const WT = '/Users/me/wt/task-1';

describe('shellQuote', () => {
  it('quotes a path with spaces and keeps a literal quote literal', () => {
    expect(shellQuote('src/a b.ts')).toBe("'src/a b.ts'");
    expect(shellQuote("it's.ts")).toBe("'it'\\''s.ts'");
    expect(shellQuote('a;rm -rf /')).toBe("'a;rm -rf /'");
  });
});

describe('buildPreparedCommitLine', () => {
  it('lists the changed paths explicitly — never -A', () => {
    const line = buildPreparedCommitLine({ worktreePath: WT, paths: ['b.ts', 'a.ts'], title: 'fix the thing' });
    expect(line).toBe(
      "git -C '/Users/me/wt/task-1' add -- 'a.ts' 'b.ts' && git -C '/Users/me/wt/task-1' commit -m 'wip: fix the thing'",
    );
    expect(line).not.toContain('add -A');
  });

  // Review fix: a shell that had cd'd elsewhere would otherwise commit the wip
  // into the SHARED main checkout.
  it('pins every git verb to the worktree with -C', () => {
    const line = buildPreparedCommitLine({ worktreePath: WT, paths: ['a.ts'], title: 'x' })!;
    const gitCalls = line.match(/git /g) ?? [];
    const pinned = line.match(/git -C '\/Users\/me\/wt\/task-1'/g) ?? [];
    expect(gitCalls).toHaveLength(2);
    expect(pinned).toHaveLength(2);
  });

  it('quotes a worktree path with spaces', () => {
    expect(buildPreparedCommitLine({ worktreePath: '/wt/a b', paths: ['a.ts'], title: 'x' })).toBe(
      "git -C '/wt/a b' add -- 'a.ts' && git -C '/wt/a b' commit -m 'wip: x'",
    );
  });

  it('dedupes paths and collapses whitespace in the subject', () => {
    expect(buildPreparedCommitLine({ worktreePath: WT, paths: ['a.ts', 'a.ts', ' '], title: 'two\n  words' })).toBe(
      "git -C '/Users/me/wt/task-1' add -- 'a.ts' && git -C '/Users/me/wt/task-1' commit -m 'wip: two words'",
    );
  });

  it('returns null when there is nothing to commit, or no worktree to pin to', () => {
    expect(buildPreparedCommitLine({ worktreePath: WT, paths: [], title: 'x' })).toBeNull();
    expect(buildPreparedCommitLine({ worktreePath: WT, paths: ['', '   '], title: 'x' })).toBeNull();
    expect(buildPreparedCommitLine({ worktreePath: '  ', paths: ['a.ts'], title: 'x' })).toBeNull();
  });

  it('refuses to build an unreadable — or partial — line past the path cap', () => {
    const many = Array.from({ length: PREPARED_COMMIT_PATH_CAP + 1 }, (_, i) => `f${i}.ts`);
    expect(buildPreparedCommitLine({ worktreePath: WT, paths: many, title: 'x' })).toBeNull();
    expect(
      buildPreparedCommitLine({ worktreePath: WT, paths: many.slice(0, PREPARED_COMMIT_PATH_CAP), title: 'x' }),
    ).not.toBeNull();
  });

  it('falls back to a subject when the task has no title', () => {
    expect(buildPreparedCommitLine({ worktreePath: WT, paths: ['a.ts'], title: '   ' })).toBe(
      "git -C '/Users/me/wt/task-1' add -- 'a.ts' && git -C '/Users/me/wt/task-1' commit -m 'wip: task'",
    );
  });
});

// Review fix: POSIX quoting is not PowerShell/cmd quoting, so the feature is
// absent there rather than wrong.
describe('preparedCommitSupported', () => {
  it('is off on win32 and on everywhere else', () => {
    expect(preparedCommitSupported('win32')).toBe(false);
    expect(preparedCommitSupported('darwin')).toBe(true);
    expect(preparedCommitSupported('linux')).toBe(true);
  });
});

// Review fix: a task pane is usually the AGENT's TUI. Typing a git line there
// makes it a chat message — or the answer to a pending approval prompt.
describe('resolveCommitTargetPty', () => {
  it('refuses a pty with a detected agent behind it', () => {
    expect(
      resolveCommitTargetPty({ ptyId: 'pty-1', surfaceAgent: { 'pty-1': { name: 'Claude Code' } } }),
    ).toEqual({ ok: false, reason: 'agent-pane' });
  });

  it('refuses when there is no pane at all', () => {
    expect(resolveCommitTargetPty({ ptyId: null, surfaceAgent: {} })).toEqual({
      ok: false,
      reason: 'no-pane',
    });
  });

  it('accepts a plain shell pty', () => {
    expect(
      resolveCommitTargetPty({ ptyId: 'pty-1', surfaceAgent: { 'pty-2': { name: 'Claude Code' } } }),
    ).toEqual({ ok: true, ptyId: 'pty-1' });
  });
});
