// Sibling collision watch — the merge-tree / status parsers, the sibling
// grouping and the round scheduler (fake git, fake timers).
import { describe, it, expect } from 'vitest';
import {
  parseMergeTreeOutput,
  parsePorcelainPaths,
  supportsMergeTreeWriteTree,
  siblingGroups,
  pairsOf,
  buildSnapshot,
  SiblingCollisionWatcher,
  POKE_DELAY_MS,
  type GitRun,
  type GitRunner,
} from '../siblingCollision';
import type { SiblingCollisionSnapshot } from '../../../shared/siblingCollision';

const TREE = '1b7219c36b3332393476fa1d26c0fc3369817555';

describe('parseMergeTreeOutput', () => {
  it('reads the conflicted files after the tree id (captured from git 2.50)', () => {
    expect(parseMergeTreeOutput(`${TREE}\0f.txt\0한글 파일.txt\0`)).toEqual({ ok: true, tree: TREE, conflicts: ['f.txt', '한글 파일.txt'] });
  });
  it('a clean merge is the tree id alone', () => {
    expect(parseMergeTreeOutput(`${TREE}\0`)).toEqual({ ok: true, tree: TREE, conflicts: [] });
  });
  it('stops at the empty field that starts the messages section', () => {
    expect(parseMergeTreeOutput(`${TREE}\0f.txt\0\x001\0f.txt\0Auto-merging\0Auto-merging f.txt\n\0`)).toEqual({ ok: true, tree: TREE, conflicts: ['f.txt'] });
  });
  it('anything without a tree id is a failure, never "no conflict"', () => {
    expect(parseMergeTreeOutput('')).toEqual({ ok: false });
    expect(parseMergeTreeOutput('merge-tree: nosuch - not something we can merge\n')).toEqual({ ok: false });
  });
});

describe('parsePorcelainPaths', () => {
  it('reads modified, untracked and both sides of a rename', () => {
    expect(parsePorcelainPaths(' M a.ts\0?? new dir/b.ts\0R  c-new.ts\0c-old.ts\0A  d.ts\0')).toEqual(['a.ts', 'new dir/b.ts', 'c-new.ts', 'c-old.ts', 'd.ts']);
  });
  it('a clean worktree has none', () => {
    expect(parsePorcelainPaths('')).toEqual([]);
  });
});

describe('supportsMergeTreeWriteTree', () => {
  it('needs git 2.38 or later', () => {
    expect(supportsMergeTreeWriteTree('git version 2.50.1 (Apple Git-155)')).toBe(true);
    expect(supportsMergeTreeWriteTree('git version 2.38.0.windows.1')).toBe(true);
    expect(supportsMergeTreeWriteTree('git version 2.37.3')).toBe(false);
    expect(supportsMergeTreeWriteTree('git version 3.0.0')).toBe(true);
    expect(supportsMergeTreeWriteTree('')).toBe(false);
  });
});

describe('siblingGroups / pairsOf', () => {
  it('groups distinct worktrees per repo, leaving out single ones and integration worktrees', () => {
    const groups = siblingGroups([
      { cwd: '/r/a/src', worktreePath: '/r/a', commonDir: '/r/.git' },
      { cwd: '/r/a', worktreePath: '/r/a', commonDir: '/r/.git' },
      { cwd: '/r/b', worktreePath: '/r/b', commonDir: '/r/.git' },
      { cwd: '/r-worktrees/.wmux-merge-feat', worktreePath: '/r-worktrees/.wmux-merge-feat', commonDir: '/r/.git' },
      { cwd: '/other', worktreePath: '/other', commonDir: '/other/.git' },
    ]);
    expect([...groups]).toEqual([['/r/.git', ['/r/a', '/r/b']]]);
  });
  it('pairs every two', () => {
    expect(pairsOf(['a', 'b', 'c'])).toEqual([['a', 'b'], ['a', 'c'], ['b', 'c']]);
    expect(pairsOf(['a'])).toEqual([]);
  });
  it('the snapshot names each colliding cwd and maps worktrees back to their cwds', () => {
    const snap = buildSnapshot(
      [
        { cwd: '/r/a', worktreePath: '/r/a', commonDir: '/g' },
        { cwd: '/r/a/sub', worktreePath: '/r/a', commonDir: '/g' },
        { cwd: '/r/b', worktreePath: '/r/b', commonDir: '/g' },
        { cwd: '/r/c', worktreePath: '/r/c', commonDir: '/g' },
      ],
      [{ a: '/r/a', b: '/r/b', conflicts: ['x.ts'], overlaps: [] }, { a: '/r/a', b: '/r/c', conflicts: [], overlaps: [] }],
    );
    expect(Object.keys(snap.byCwd).sort()).toEqual(['/r/a', '/r/a/sub', '/r/b']);
    expect(snap.byCwd['/r/b'].peers).toEqual([{ worktreePath: '/r/a', conflicts: ['x.ts'], overlaps: [] }]);
    expect(snap.cwdsByWorktree['/r/a']).toEqual(['/r/a', '/r/a/sub']);
  });
});

// ── Scheduler ────────────────────────────────────────────────────────────────

const ok = (stdout: string, code = 0): GitRun => ({ code, stdout, stderr: '', failed: false });

/** A fake repo: worktrees /r/a and /r/b (and /r/c when listed), conflicting on f.txt. */
function fakeGit(opts: { conflict?: boolean; dirty?: Record<string, string>; fail?: () => boolean } = {}) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const run: GitRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    inFlight--;
    if (opts.fail?.()) return { code: 1, stdout: '', stderr: 'timeout', failed: true };
    const cmd = args[0];
    if (cmd === 'rev-parse' && args.includes('--show-toplevel')) {
      return cwd.startsWith('/r/') ? ok(`${cwd}\n/r/.git\n`) : ok('', 128);
    }
    if (cmd === 'version') return ok('git version 2.50.1\n');
    if (cmd === 'rev-parse') return ok(`${cwd.endsWith('a') ? 'a'.repeat(40) : 'b'.repeat(40)}\n`);
    if (cmd === 'status') return ok(opts.dirty?.[cwd] ?? '');
    if (cmd === 'merge-tree') return opts.conflict ? ok(`${TREE}\0f.txt\0`, 1) : ok(`${TREE}\0`);
    if (cmd === 'merge-base') return ok(`${'c'.repeat(40)}\n`);
    if (cmd === 'diff') return ok(args.at(-1)!.startsWith('a') ? 'f.txt\0a-only.txt\0' : 'f.txt\0');
    return ok('');
  };
  return { run, calls, maxInFlight: () => maxInFlight };
}

function harness(git: ReturnType<typeof fakeGit>) {
  const emitted: SiblingCollisionSnapshot[] = [];
  const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
  let nextId = 1;
  const watcher = new SiblingCollisionWatcher({
    run: git.run,
    emit: (s) => emitted.push(s),
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ fn, ms, id });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    makeScratch: async () => '/tmp/scratch',
    dropScratch: async () => undefined,
  });
  /** Fire the pending timer and wait for its round. */
  const tick = async () => {
    const t = timers.shift();
    if (!t) throw new Error('no timer pending');
    t.fn();
    await watcher.idle();
    return t.ms;
  };
  return { watcher, emitted, timers, tick };
}

describe('SiblingCollisionWatcher', () => {
  it('marks both siblings on a conflict, then re-checks on the interval', async () => {
    const git = fakeGit({ conflict: true });
    const h = harness(git);
    h.watcher.configure({ enabled: true, intervalMs: 120_000, cwds: ['/r/a', '/r/b'] });
    expect(await h.tick()).toBe(0);
    const last = h.emitted.at(-1)!;
    expect(last.byCwd['/r/a'].peers).toEqual([{ worktreePath: '/r/b', conflicts: ['f.txt'], overlaps: [] }]);
    expect(last.byCwd['/r/b'].peers[0].worktreePath).toBe('/r/a');
    expect(h.timers.map((t) => t.ms)).toEqual([120_000]);
    // Never more than one git process at a time for the repo.
    expect(git.maxInFlight()).toBe(1);
    // The merge dry run goes through the throwaway object directory.
    expect(git.calls.find((c) => c.args[0] === 'merge-tree')).toBeTruthy();
  });

  it('an unchanged pair costs no second merge-tree', async () => {
    const git = fakeGit({ conflict: true });
    const h = harness(git);
    h.watcher.configure({ enabled: true, intervalMs: 60_000, cwds: ['/r/a', '/r/b'] });
    await h.tick();
    await h.tick();
    expect(git.calls.filter((c) => c.args[0] === 'merge-tree')).toHaveLength(1);
  });

  it('reports an uncommitted shared file as an overlap, not a conflict', async () => {
    const git = fakeGit({ conflict: false, dirty: { '/r/b': ' M f.txt\0' } });
    const h = harness(git);
    h.watcher.configure({ enabled: true, intervalMs: 60_000, cwds: ['/r/a', '/r/b'] });
    await h.tick();
    expect(h.emitted.at(-1)!.byCwd['/r/a'].peers).toEqual([{ worktreePath: '/r/b', conflicts: [], overlaps: ['f.txt'] }]);
  });

  it('no siblings, no polling: one worktree twice or a non-git folder schedules nothing', async () => {
    const git = fakeGit();
    const h = harness(git);
    h.watcher.configure({ enabled: true, intervalMs: 60_000, cwds: ['/r/a'] });
    expect(h.timers).toHaveLength(0);
    h.watcher.configure({ enabled: true, intervalMs: 60_000, cwds: ['/r/a', '/elsewhere'] });
    await h.tick();
    expect(h.timers).toHaveLength(0);
    h.watcher.poke(); // an idle pane asks again
    expect(h.timers.map((t) => t.ms)).toEqual([POKE_DELAY_MS]);
  });

  it('off clears the markers and stops the timer', async () => {
    const git = fakeGit({ conflict: true });
    const h = harness(git);
    h.watcher.configure({ enabled: true, intervalMs: 60_000, cwds: ['/r/a', '/r/b'] });
    await h.tick();
    h.watcher.configure({ enabled: false, intervalMs: 60_000, cwds: ['/r/a', '/r/b'] });
    expect(h.timers).toHaveLength(0);
    expect(h.emitted.at(-1)).toEqual({ byCwd: {}, cwdsByWorktree: {} });
  });

  it('backs off after a failed round and keeps what it showed', async () => {
    let failing = false;
    const git = fakeGit({ conflict: true, fail: () => failing });
    const h = harness(git);
    h.watcher.configure({ enabled: true, intervalMs: 60_000, cwds: ['/r/a', '/r/b'] });
    await h.tick();
    const shown = h.emitted.length;
    failing = true;
    await h.tick();
    expect(h.timers.map((t) => t.ms)).toEqual([120_000]);
    await h.tick();
    expect(h.timers.map((t) => t.ms)).toEqual([240_000]);
    expect(h.emitted.length).toBe(shown); // nothing new published: the marker stays
    failing = false;
    await h.tick();
    expect(h.timers.map((t) => t.ms)).toEqual([60_000]);
  });

  it('clamps the interval', async () => {
    const h = harness(fakeGit());
    h.watcher.configure({ enabled: true, intervalMs: 5, cwds: ['/r/a', '/r/b'] });
    await h.tick();
    expect(h.timers.map((t) => t.ms)).toEqual([30_000]);
  });

  it('a poke during a round runs one more round right after', async () => {
    const git = fakeGit();
    const h = harness(git);
    h.watcher.configure({ enabled: true, intervalMs: 60_000, cwds: ['/r/a', '/r/b'] });
    const t = h.timers.shift()!;
    t.fn();
    h.watcher.poke();
    await h.watcher.idle();
    expect(h.timers.map((x) => x.ms)).toEqual([0]);
  });

  it('disposed: nothing runs', () => {
    const h = harness(fakeGit());
    h.watcher.dispose();
    h.watcher.configure({ enabled: true, intervalMs: 60_000, cwds: ['/r/a', '/r/b'] });
    h.watcher.poke();
    expect(h.timers).toHaveLength(0);
  });
});
