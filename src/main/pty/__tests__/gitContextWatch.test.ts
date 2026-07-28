import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GitContextWatcher,
  parseHead,
  resolveRepo,
  readGitContext,
  type GitWatchFactory,
  type GitWatchListener,
} from '../gitContextWatch';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-gitwatch-'));
}

function initFakeRepo(root: string, branch = 'main'): void {
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
}

const tmpDirs: string[] = [];
const watchers: GitContextWatcher[] = [];

function tmp(): string {
  const dir = mkTmpDir();
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const w of watchers.splice(0)) w.dispose();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win32 lock */ }
  }
});

/** One armed watch recorded by the fake factory. */
interface ArmedWatch {
  target: string;
  listener: GitWatchListener;
  closed: boolean;
}

/**
 * Fake `fs.watch` so the watcher's own logic (filename filter, debounce,
 * re-resolve, teardown) is asserted without waiting on real FSEvents/inotify
 * delivery — which is what made these tests flaky on loaded CI runners.
 */
function fakeWatchFactory(): { arms: ArmedWatch[]; factory: GitWatchFactory; last(): ArmedWatch } {
  const arms: ArmedWatch[] = [];
  const factory: GitWatchFactory = (target, listener) => {
    const rec: ArmedWatch = { target, listener, closed: false };
    arms.push(rec);
    return {
      close() { rec.closed = true; },
      on() { return this; },
    };
  };
  return { arms, factory, last: () => arms[arms.length - 1] };
}

describe('parseHead', () => {
  it('parses a branch ref', () => {
    expect(parseHead('ref: refs/heads/main\n')).toBe('main');
  });

  it('parses a branch ref with slashes', () => {
    expect(parseHead('ref: refs/heads/feat/x1-sidebar\n')).toBe('feat/x1-sidebar');
  });

  it('returns the short SHA for a detached HEAD', () => {
    expect(parseHead('0123456789abcdef0123456789abcdef01234567\n')).toBe('01234567');
  });

  it('returns null for garbage', () => {
    expect(parseHead('')).toBeNull();
    expect(parseHead('not a head')).toBeNull();
  });
});

describe('resolveRepo', () => {
  it('resolves a .git directory at the cwd', () => {
    const root = tmp();
    initFakeRepo(root);
    const repo = resolveRepo(root);
    expect(repo).not.toBeNull();
    expect(repo!.isWorktree).toBe(false);
    expect(repo!.gitDir).toBe(path.join(root, '.git'));
  });

  it('walks up from a nested cwd', () => {
    const root = tmp();
    initFakeRepo(root, 'dev');
    const nested = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    const repo = resolveRepo(nested);
    expect(repo?.gitDir).toBe(path.join(root, '.git'));
    expect(readGitContext(repo!)).toEqual({ branch: 'dev', isWorktree: false });
  });

  it('resolves a linked-worktree .git file with gitdir indirection', () => {
    const main = tmp();
    initFakeRepo(main);
    const wtGitDir = path.join(main, '.git', 'worktrees', 'wt1');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/feature-x\n');

    const wt = tmp();
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGitDir}\n`);

    const repo = resolveRepo(wt);
    expect(repo).not.toBeNull();
    expect(repo!.isWorktree).toBe(true);
    expect(readGitContext(repo!)).toEqual({ branch: 'feature-x', isWorktree: true });
  });

  it('returns null outside any repository', () => {
    // os.tmpdir() itself could theoretically sit in a repo on a dev box; a
    // fresh nested dir without .git anywhere within MAX_WALK_UP of the drive
    // root is still the realistic non-repo case.
    const root = tmp();
    const repo = resolveRepo(path.join(root));
    // The tmp dir's ancestors shouldn't contain .git; tolerate either null
    // or a repo ABOVE tmp (CI sandbox edge) by asserting it's not inside root.
    if (repo) {
      expect(repo.gitDir.startsWith(root)).toBe(false);
    } else {
      expect(repo).toBeNull();
    }
  });
});

describe('GitContextWatcher', () => {
  /** The watcher's internal REREAD_DEBOUNCE_MS. */
  const DEBOUNCE_MS = 50;

  let fake: ReturnType<typeof fakeWatchFactory>;
  let events: Array<{ sessionId: string; branch: string | null; isWorktree: boolean }>;

  /** Build a watcher wired to the fake factory, with events collected. */
  function makeWatcher(): GitContextWatcher {
    const w = new GitContextWatcher(fake.factory);
    watchers.push(w);
    w.on('git', (e) => events.push(e));
    return w;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fake = fakeWatchFactory();
    events = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits the initial branch on update()', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const watcher = makeWatcher();
    watcher.update('s1', root);
    expect(events).toEqual([{ sessionId: 's1', branch: 'main', isWorktree: false }]);
  });

  it('arms the watch on the git dir before the first read', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    makeWatcher().update('s1', root);
    expect(fake.arms).toHaveLength(1);
    expect(fake.last().target).toBe(path.join(root, '.git'));
  });

  it('emits again when HEAD changes (branch switch)', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const watcher = makeWatcher();
    watcher.update('s1', root);
    expect(events).toHaveLength(1);

    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/feature-y\n');
    fake.last().listener('change', 'HEAD');
    // Nothing before the debounce elapses…
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(events).toHaveLength(1);
    // …and exactly one re-emit after it.
    vi.advanceTimersByTime(1);
    expect(events).toHaveLength(2);
    expect(events[1].branch).toBe('feature-y');
  });

  it('coalesces a burst of HEAD events into a single re-emit', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const watcher = makeWatcher();
    watcher.update('s1', root);

    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/feature-y\n');
    for (let i = 0; i < 5; i++) {
      fake.last().listener('change', 'HEAD');
      vi.advanceTimersByTime(10); // each event restarts the debounce
    }
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(events).toHaveLength(2);
    expect(events[1].branch).toBe('feature-y');
  });

  it('reacts to HEAD.lock (the rename git uses) and ignores unrelated files', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const watcher = makeWatcher();
    watcher.update('s1', root);

    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/locked\n');
    for (const name of ['config', 'index', 'refs', 'ORIG_HEAD', 'HEADER']) {
      fake.last().listener('change', name);
    }
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);
    expect(events).toHaveLength(1); // filtered out — no re-read scheduled

    fake.last().listener('rename', 'HEAD.lock');
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(events).toHaveLength(2);
    expect(events[1].branch).toBe('locked');
  });

  it('does not re-emit an unchanged value when HEAD is rewritten identically', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const watcher = makeWatcher();
    watcher.update('s1', root);

    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fake.last().listener('change', 'HEAD');
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);
    expect(events).toHaveLength(1);
  });

  it('does not re-emit an unchanged value on a repeated update()', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const watcher = makeWatcher();
    watcher.update('s1', root);
    watcher.update('s1', root);
    watcher.update('s1', path.join(root)); // identical cwd
    vi.advanceTimersByTime(DEBOUNCE_MS * 4);
    expect(events).toHaveLength(1);
  });

  it('emits branch null when leaving a repo for a non-repo cwd', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const plain = tmp();
    const watcher = makeWatcher();
    watcher.update('s1', root);
    watcher.update('s1', plain);
    expect(events).toHaveLength(2);
    expect(events[1].branch).toBeNull();
    expect(events[1].isWorktree).toBe(false);
  });

  it('picks up a git init in a previously non-repo cwd without polling', () => {
    const root = tmp();
    const watcher = makeWatcher();
    watcher.update('s1', root);
    // Outside a repo the watch arms on the cwd itself.
    expect(fake.last().target).toBe(root);
    const nonRepoWatch = fake.last();

    // Unrelated files in the cwd must not trigger a re-resolve.
    nonRepoWatch.listener('rename', 'scratch.txt');
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);
    expect(fake.arms).toHaveLength(1);

    initFakeRepo(root, 'fresh');
    nonRepoWatch.listener('rename', '.git');
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(events.at(-1)?.branch).toBe('fresh');
    // Re-armed on the freshly resolved git dir; the old watch was closed.
    expect(nonRepoWatch.closed).toBe(true);
    expect(fake.last().target).toBe(path.join(root, '.git'));
  });

  it('remove() closes the watch and clears a pending debounce', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const watcher = makeWatcher();
    watcher.update('s1', root);
    expect(watcher.size).toBe(1);

    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/never-seen\n');
    fake.last().listener('change', 'HEAD');
    watcher.remove('s1');

    vi.advanceTimersByTime(DEBOUNCE_MS * 4);
    expect(watcher.size).toBe(0);
    expect(fake.last().closed).toBe(true);
    expect(events).toHaveLength(1); // the pending re-read never fired
  });

  it('dispose() closes every session watch and clears pending debounces', () => {
    const a = tmp();
    const b = tmp();
    initFakeRepo(a, 'main');
    initFakeRepo(b, 'dev');
    const watcher = makeWatcher();
    watcher.update('s1', a);
    watcher.update('s2', b);
    expect(events).toHaveLength(2);

    for (const arm of fake.arms) arm.listener('change', 'HEAD');
    watcher.dispose();
    vi.advanceTimersByTime(DEBOUNCE_MS * 4);
    expect(watcher.size).toBe(0);
    expect(fake.arms.every((a2) => a2.closed)).toBe(true);
    expect(events).toHaveLength(2);
  });
});
