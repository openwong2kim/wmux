// Handler tests for worktree merge-session ops (start/status/discard) — real temp repo.
// The conflict path skips verify (npm), so it's deterministic, and it verifies the
// session registry, lock keys, and the isolated integration worktree
// create/remove lifecycle through the IPC surface.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const captured = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      captured.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => captured.delete(channel)),
  },
}));

import { registerWorktreeHandlers } from '../worktree.handler';
import { IPC } from '../../../../shared/constants';
import type { MergeStartResult, MergeStatusResult, MergeActionResult } from '../worktree.handler';

// These tests drive REAL git (worktree add, merge, status). Process spawning is
// much slower on Windows CI, so the default 5s per-test timeout is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// main (main2 commit) + feat worktree (feat commit that conflicts with main2). They conflict on f.txt.
function makeConflictScenario(): { base: string; repo: string; featWt: string; cleanup: () => void } {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'wmux-wtm-')));
  const repo = join(base, 'repo');
  mkdirSync(repo);
  g(repo, ['init', '-q', '-b', 'main']);
  g(repo, ['config', 'user.email', 't@t']);
  g(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'f.txt'), 'a\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'base']);
  // feat: change f.txt to FEAT.
  g(repo, ['checkout', '-q', '-b', 'feat']);
  writeFileSync(join(repo, 'f.txt'), 'FEAT\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'feat']);
  g(repo, ['checkout', '-q', 'main']);
  // main2: change f.txt to MAIN (conflicts with feat).
  writeFileSync(join(repo, 'f.txt'), 'MAIN\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'main2']);
  // Check out feat as a linked worktree (source).
  const featWt = join(base, 'feat-wt');
  g(repo, ['worktree', 'add', '-q', featWt, 'feat']);
  return { base, repo, featWt, cleanup: () => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) };
}

// main + a feat branch pointing at the SAME commit (already in base) as a worktree.
// Merging it is a no-op: git leaves no MERGE_HEAD and 0 changed files.
function makeNoopScenario(): { base: string; repo: string; featWt: string; cleanup: () => void } {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'wmux-noop-')));
  const repo = join(base, 'repo');
  mkdirSync(repo);
  g(repo, ['init', '-q', '-b', 'main']);
  g(repo, ['config', 'user.email', 't@t']);
  g(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'f.txt'), 'a\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'base']);
  // feat = main HEAD (no new commits), checked out as a linked worktree.
  g(repo, ['branch', 'feat']);
  const featWt = join(base, 'feat-wt');
  g(repo, ['worktree', 'add', '-q', featWt, 'feat']);
  return { base, repo, featWt, cleanup: () => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) };
}

describe('worktree.handler — merge session (conflict path) start/status/discard', () => {
  let scn: ReturnType<typeof makeConflictScenario>;
  beforeEach(() => {
    captured.clear();
    registerWorktreeHandlers();
    scn = makeConflictScenario();
  });
  afterEach(() => scn.cleanup());

  it('start(conflict) → conflicted + integration created → cleaned up by discard', async () => {
    const start = captured.get(IPC.WORKTREE_MERGE_START)!;
    const status = captured.get(IPC.WORKTREE_MERGE_STATUS)!;
    const discard = captured.get(IPC.WORKTREE_MERGE_DISCARD)!;

    const s = (await start({}, scn.repo, scn.featWt)) as MergeStartResult;
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.status.phase).toBe('conflicted');
    expect(s.status.conflicts).toEqual(['f.txt']);
    expect(s.status.baseBranch).toBe('main');
    expect(existsSync(s.status.integrationPath)).toBe(true);

    // status also returns the same session (conflicted).
    const st = (await status({}, scn.repo)) as MergeStatusResult;
    expect(st.ok).toBe(true);
    if (st.ok) expect(st.status?.phase).toBe('conflicted');

    // A concurrent start is rejected (session-existence tracking).
    const dup = (await start({}, scn.repo, scn.featWt)) as MergeStartResult;
    expect(dup.ok).toBe(false);

    // discard → removes integration, session gone (status null).
    const integrationPath = s.status.integrationPath;
    const d = (await discard({}, scn.repo)) as MergeActionResult;
    expect(d.ok).toBe(true);
    expect(existsSync(integrationPath)).toBe(false);
    const st2 = (await status({}, scn.repo)) as MergeStatusResult;
    expect(st2.ok).toBe(true);
    if (st2.ok) expect(st2.status).toBeNull();
  });

  it('start — rejected by a precondition failure when the target (base) is dirty', async () => {
    // Make the main worktree dirty.
    writeFileSync(join(scn.repo, 'dirty.txt'), 'x\n');
    const start = captured.get(IPC.WORKTREE_MERGE_START)!;
    const s = (await start({}, scn.repo, scn.featWt)) as MergeStartResult;
    expect(s.ok).toBe(false);
  });

  it('start — rejects a dirty source worktree (uncommitted work would be dropped)', async () => {
    // Untracked file in the source (feat) worktree — the committed HEAD is what
    // gets merged, so this change would be silently lost.
    writeFileSync(join(scn.featWt, 'wip.txt'), 'uncommitted\n');
    const start = captured.get(IPC.WORKTREE_MERGE_START)!;
    const s = (await start({}, scn.repo, scn.featWt)) as MergeStartResult;
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.error).toContain('source 워크트리에 커밋되지 않은');
  });

  it('start — rejects a sourcePath that is not a worktree of this repo', async () => {
    // A separate, unrelated git repo (arbitrary path injection from the renderer).
    const other = realpathSync.native(mkdtempSync(join(tmpdir(), 'wmux-other-')));
    g(other, ['init', '-q', '-b', 'main']);
    g(other, ['config', 'user.email', 't@t']);
    g(other, ['config', 'user.name', 't']);
    writeFileSync(join(other, 'x.txt'), 'x\n');
    g(other, ['add', '-A']);
    g(other, ['commit', '-q', '-m', 'x']);
    try {
      const start = captured.get(IPC.WORKTREE_MERGE_START)!;
      const s = (await start({}, scn.repo, other)) as MergeStartResult;
      expect(s.ok).toBe(false);
      if (!s.ok) expect(s.error).toContain('이 repo의 워크트리가 아닙니다');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('status — a conflicted session advances to verify once the conflict is resolved & staged on disk', async () => {
    const start = captured.get(IPC.WORKTREE_MERGE_START)!;
    const status = captured.get(IPC.WORKTREE_MERGE_STATUS)!;
    const discard = captured.get(IPC.WORKTREE_MERGE_DISCARD)!;

    const s = (await start({}, scn.repo, scn.featWt)) as MergeStartResult;
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.status.phase).toBe('conflicted');
    const integrationPath = s.status.integrationPath;

    // Resolve + stage the conflict in the integration worktree (MERGE_HEAD stays until commit).
    writeFileSync(join(integrationPath, 'f.txt'), 'RESOLVED\n');
    g(integrationPath, ['add', 'f.txt']);

    // status re-checks disk → no unresolved conflicts → transitions to the verify gate.
    const st = (await status({}, scn.repo)) as MergeStatusResult;
    expect(st.ok).toBe(true);
    if (!st.ok) return;
    expect(st.status?.conflicts).toEqual([]);
    expect(st.status?.phase).toBe('verifying');

    // Clean up: discard aborts the in-flight verify and removes the integration worktree.
    await discard({}, scn.repo);
  });
});

describe('worktree.handler — merge session (no-op merge)', () => {
  let scn: ReturnType<typeof makeNoopScenario>;
  beforeEach(() => {
    captured.clear();
    registerWorktreeHandlers();
    scn = makeNoopScenario();
  });
  afterEach(() => scn.cleanup());

  it('start — rejects an already-up-to-date source and leaves no orphan integration worktree', async () => {
    const start = captured.get(IPC.WORKTREE_MERGE_START)!;
    const status = captured.get(IPC.WORKTREE_MERGE_STATUS)!;

    const s = (await start({}, scn.repo, scn.featWt)) as MergeStartResult;
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.error).toContain('이미 최신');

    // No session was created …
    const st = (await status({}, scn.repo)) as MergeStatusResult;
    expect(st.ok).toBe(true);
    if (st.ok) expect(st.status).toBeNull();
    // … and no integration worktree was left behind.
    expect(g(scn.repo, ['worktree', 'list'])).not.toContain('.wmux-merge');
  });
});
