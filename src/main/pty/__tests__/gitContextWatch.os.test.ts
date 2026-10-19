import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GitContextWatcher,
  parseHead,
  resolveRepo,
  resolveRepoState,
  readGitContext,
  serialProbeIo,
  REMOTE_POLL_MS,
  REMOTE_RESOLVE_TIMEOUT_MS,
  REMOTE_POLL_DEADLINE_MS,
  REMOTE_POLL_MAX_MS,
  type ProbeIo,
  type GitWatchFactory,
  type GitWatchListener,
} from '../gitContextWatch';
import { watchTarget } from '../../../shared/watchTarget';
import { shortPathOf } from '../../../test-utils/shortPath';

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

  it('maps a POSIX gitdir (a worktree made by git inside WSL) through the mapper (#2407)', () => {
    const main = tmp();
    initFakeRepo(main);
    const wtGitDir = path.join(main, '.git', 'worktrees', 'wt1');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/feature-x\n');
    const wt = tmp();
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /home/me/repo/.git/worktrees/wt1\n');
    const seen: string[] = [];
    const map = (gitdir: string) => {
      seen.push(gitdir);
      return gitdir.replace('/home/me/repo', main);
    };

    const { repo } = resolveRepoState(wt, map);
    expect(seen).toEqual(['/home/me/repo/.git/worktrees/wt1']);
    expect(repo).toEqual({ gitDir: path.resolve(wtGitDir), isWorktree: true });
    expect(readGitContext(repo!)).toEqual({ branch: 'feature-x', isWorktree: true });
  });

  it('never hands a relative gitdir to the mapper', () => {
    const main = tmp();
    initFakeRepo(main);
    const wtGitDir = path.join(main, '.git', 'worktrees', 'wt1');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/rel\n');
    const wt = tmp();
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.relative(wt, wtGitDir)}\n`);
    const map = vi.fn((gitdir: string) => gitdir);
    expect(resolveRepoState(wt, map).repo?.gitDir).toBe(path.resolve(wtGitDir));
    expect(map).not.toHaveBeenCalled();
  });

  // #2407: a worktree added by Linux git on a Windows drive records its gitdir
  // as the WSL path of the host folder.
  it.runIf(process.platform === 'win32')('resolves a gitdir written as a WSL drive-mount path', () => {
    const main = tmp();
    initFakeRepo(main);
    const wtGitDir = path.join(main, '.git', 'worktrees', 'wt2');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/feature-wsl\n');
    // `C:\Users\me\x` → `/mnt/c/Users/me/x`
    const asWsl = '/mnt/' + wtGitDir[0].toLowerCase() + wtGitDir.slice(2).replace(/\\/g, '/');

    const wt = tmp();
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${asWsl}\n`);

    const repo = resolveRepo(wt);
    expect(repo?.gitDir.toLowerCase()).toBe(wtGitDir.toLowerCase());
    expect(readGitContext(repo!)).toEqual({ branch: 'feature-wsl', isWorktree: true });
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
  let events: Array<{ sessionId: string; branch: string | null; isWorktree: boolean; absent?: true }>;

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
    expect(fake.last().target).toBe(watchTarget(path.join(root, '.git')));
  });

  it.runIf(process.platform === 'win32')('arms on the long spelling when the cwd is an 8.3 short path (#984)', (ctx) => {
    // libuv 1.52 garbles (or asserts on) the event filename for a directory
    // watched through a short alias, and the HEAD filter would drop it.
    const root = tmp();
    initFakeRepo(root, 'main');
    const short = shortPathOf(root);
    if (!short) return ctx.skip(); // 8.3 names are off for this volume
    makeWatcher().update('s1', short);
    expect(events).toEqual([{ sessionId: 's1', branch: 'main', isWorktree: false }]);
    expect(fake.last().target).not.toContain('~');
    expect(fake.last().target.toLowerCase()).toBe(
      fs.realpathSync.native(path.join(root, '.git')).toLowerCase(),
    );
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
    expect(events[1].absent).toBe(true);
  });

  it('repo → non-repo → repo: known absent only while outside a repo', () => {
    const a = tmp();
    initFakeRepo(a, 'main');
    const plain = tmp();
    const b = tmp();
    initFakeRepo(b, 'feat');
    const watcher = makeWatcher();
    watcher.update('s1', a);
    watcher.update('s1', plain);
    watcher.update('s1', b);
    expect(events).toEqual([
      { sessionId: 's1', branch: 'main', isWorktree: false },
      { sessionId: 's1', branch: null, isWorktree: false, absent: true },
      { sessionId: 's1', branch: 'feat', isWorktree: false },
    ]);
  });

  it('an unreadable HEAD inside a repo is unknown, not absent', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.git')); // no HEAD file
    makeWatcher().update('s1', root);
    expect(events).toEqual([{ sessionId: 's1', branch: null, isWorktree: false }]);
  });

  it('outside a repo with no live watch, "no branch" is unknown', () => {
    const w = new GitContextWatcher(() => { throw new Error('EPERM'); });
    watchers.push(w);
    w.on('git', (e) => events.push(e));
    w.update('s1', tmp());
    expect(events).toEqual([{ sessionId: 's1', branch: null, isWorktree: false }]);
  });

  it('a non-repo watch that errors turns known absent back into unknown', () => {
    let onError: (() => void) | undefined;
    const w = new GitContextWatcher(() => ({
      close() { /* nothing armed */ },
      on(_event: 'error', listener: () => void) { onError = listener; return this; },
    }));
    watchers.push(w);
    w.on('git', (e) => events.push(e));
    w.update('s1', tmp());
    expect(events.at(-1)?.absent).toBe(true);
    onError?.();
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ sessionId: 's1', branch: null, isWorktree: false });
  });

  it('resync() re-emits every session\'s current answer, unchanged or not', () => {
    const repo = tmp();
    initFakeRepo(repo, 'main');
    const plain = tmp();
    const watcher = makeWatcher();
    watcher.update('s1', repo);
    watcher.update('s2', plain);
    expect(events).toHaveLength(2);
    watcher.resync();
    expect(events.slice(2)).toEqual([
      { sessionId: 's1', branch: 'main', isWorktree: false },
      { sessionId: 's2', branch: null, isWorktree: false, absent: true },
    ]);
  });

  it('a walk that gives up before the root is unknown, not absent', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    // 30 levels below the repo: past the 24-level walk limit.
    const deep = path.join(root, ...Array.from({ length: 30 }, (_, i) => `d${i}`));
    fs.mkdirSync(deep, { recursive: true });
    expect(resolveRepoState(deep)).toEqual({ repo: null, conclusive: false });
    makeWatcher().update('s1', deep);
    expect(events).toEqual([{ sessionId: 's1', branch: null, isWorktree: false }]);
  });

  it('a cwd reached through a symlink into a repo is not absent', () => {
    const repo = tmp();
    initFakeRepo(repo, 'main');
    const src = path.join(repo, 'src');
    fs.mkdirSync(src);
    const alias = path.join(tmp(), 'alias');
    try {
      fs.symlinkSync(src, alias, 'junction');
    } catch {
      return; // no symlink permission (Windows without developer mode)
    }
    const state = resolveRepoState(alias);
    expect(state.repo?.gitDir).toBe(path.join(fs.realpathSync.native(repo), '.git'));
    makeWatcher().update('s1', alias);
    expect(events).toEqual([{ sessionId: 's1', branch: 'main', isWorktree: false }]);
  });

  it('a bare repository (no .git, HEAD at the top) is unknown, not absent', () => {
    const bare = tmp();
    fs.writeFileSync(path.join(bare, 'HEAD'), 'ref: refs/heads/main\n');
    fs.mkdirSync(path.join(bare, 'objects'));
    fs.mkdirSync(path.join(bare, 'refs'));
    const sub = path.join(bare, 'objects');
    expect(resolveRepoState(bare).conclusive).toBe(false);
    expect(resolveRepoState(sub).conclusive).toBe(false);
    makeWatcher().update('s1', bare);
    expect(events).toEqual([{ sessionId: 's1', branch: null, isWorktree: false }]);
  });

  it('a bare clone into a watched non-repo cwd drops the known absent', () => {
    const root = tmp();
    const watcher = makeWatcher();
    watcher.update('s1', root);
    expect(events.at(-1)?.absent).toBe(true);
    fs.writeFileSync(path.join(root, 'HEAD'), 'ref: refs/heads/main\n');
    fake.last().listener('rename', 'HEAD');
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(events.at(-1)).toEqual({ sessionId: 's1', branch: null, isWorktree: false });
  });

  it('a .git created while the cwd watch is being armed is not missed as absent', () => {
    const root = tmp();
    const w = new GitContextWatcher((target, listener) => {
      initFakeRepo(root, 'raced'); // appears before the watch is live
      return fake.factory(target, listener);
    });
    watchers.push(w);
    w.on('git', (e) => events.push(e));
    w.update('s1', root);
    expect(events).toEqual([{ sessionId: 's1', branch: null, isWorktree: false }]);
  });

  it('a non-repo cwd that cannot be resolved to a real path is unknown', () => {
    const gone = path.join(tmp(), 'gone');
    expect(resolveRepoState(gone)).toEqual({ repo: null, conclusive: false });
  });

  it('a .git file without a gitdir line is unknown, not absent', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, '.git'), 'garbage\n');
    makeWatcher().update('s1', root);
    expect(events).toEqual([{ sessionId: 's1', branch: null, isWorktree: false }]);
  });

  it('resync() resolves a non-repo session again (an ancestor git init)', () => {
    const parent = tmp();
    const sub = path.join(parent, 'sub');
    fs.mkdirSync(sub);
    const watcher = makeWatcher();
    watcher.update('s1', sub);
    expect(events.at(-1)?.absent).toBe(true);
    initFakeRepo(parent, 'late');
    watcher.resync();
    expect(events.at(-1)).toEqual({ sessionId: 's1', branch: 'late', isWorktree: false });
    expect(events).toHaveLength(2);
  });

  it('picks up a git init in a previously non-repo cwd without polling', () => {
    const root = tmp();
    const watcher = makeWatcher();
    watcher.update('s1', root);
    // Outside a repo the watch arms on the cwd itself.
    expect(fake.last().target).toBe(watchTarget(root));
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
    expect(fake.last().target).toBe(watchTarget(path.join(root, '.git')));
  });

  it('a re-resolve after git worktree add keeps the session\'s gitdir mapper (#2407)', () => {
    const main = tmp();
    initFakeRepo(main);
    const wtGitDir = path.join(main, '.git', 'worktrees', 'wt1');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/linked\n');
    const wt = tmp();
    const watcher = makeWatcher();
    watcher.update('s1', wt, (gitdir) => gitdir.replace('/home/me/repo', main));
    expect(events.at(-1)?.absent).toBe(true);

    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /home/me/repo/.git/worktrees/wt1\n');
    fake.last().listener('rename', '.git');
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(events.at(-1)).toEqual({ sessionId: 's1', branch: 'linked', isWorktree: true });
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

describe('GitContextWatcher on a WSL share (#2407)', () => {
  /** Answers probes from the local fs, as the real ProbeIo would over 9P. */
  const localIo: ProbeIo = async ({ op, path: p }) => {
    try {
      if (op === 'read') return fs.readFileSync(p, 'utf8');
      if (op === 'realpath') return fs.realpathSync.native(p);
      const st = fs.statSync(p);
      return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
    } catch (err) {
      if (op !== 'stat') return null;
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'error';
    }
  };

  /** A ProbeIo that can be held, like a distro that is booting or wedged. */
  function holdableIo() {
    const waiting: Array<() => void> = [];
    let held = false;
    let probes = 0;
    const io: ProbeIo = (probe) => {
      probes++;
      if (!held) return localIo(probe);
      return new Promise((resolve) => waiting.push(() => resolve(localIo(probe))));
    };
    return {
      io,
      get probes() { return probes; },
      hold() { held = true; },
      release() { held = false; for (const run of waiting.splice(0)) run(); },
    };
  }

  /** Let every queued probe (a few dozen awaits per walk) settle. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 500; i++) await Promise.resolve();
  }

  let fake: ReturnType<typeof fakeWatchFactory>;
  let events: Array<{ sessionId: string; branch: string | null; isWorktree: boolean; absent?: true }>;

  function makeRemoteWatcher(io: ProbeIo = localIo): GitContextWatcher {
    // Every cwd takes the WSL-share path; tmp dirs stand in for `\\wsl$\…`.
    const w = new GitContextWatcher(fake.factory, { isRemote: () => true, io });
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

  it('resolves off the event loop and never arms fs.watch', async () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    makeRemoteWatcher().update('s1', root);
    expect(events).toEqual([]);
    await settle();
    expect(events).toEqual([{ sessionId: 's1', branch: 'main', isWorktree: false }]);
    expect(fake.arms).toHaveLength(0);
  });

  it('takes the WSL-share path only for a WSL share by default', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const w = new GitContextWatcher(fake.factory);
    watchers.push(w);
    w.on('git', (e) => events.push(e));
    w.update('s1', root);
    expect(events).toEqual([{ sessionId: 's1', branch: 'main', isWorktree: false }]);
    expect(fake.arms).toHaveLength(1);
  });

  it('polls HEAD and emits a branch switch without a cd', async () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    makeRemoteWatcher().update('s1', root);
    await settle();
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    await settle();
    expect(events).toHaveLength(1); // unchanged HEAD, no re-emit

    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS - 1);
    await settle();
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(events.at(-1)).toEqual({ sessionId: 's1', branch: 'other', isWorktree: false });
  });

  it('polls a non-repo cwd for a .git appearing, and is known absent meanwhile', async () => {
    const root = tmp();
    makeRemoteWatcher().update('s1', root);
    await settle();
    expect(events).toEqual([{ sessionId: 's1', branch: null, isWorktree: false, absent: true }]);

    initFakeRepo(root, 'fresh');
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    await settle();
    expect(events.at(-1)).toEqual({ sessionId: 's1', branch: 'fresh', isWorktree: false });

    // Now polling the new repo's HEAD.
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/next\n');
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    await settle();
    expect(events.at(-1)?.branch).toBe('next');
  });

  it('stops polling once the session is removed', async () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const io = holdableIo();
    const watcher = makeRemoteWatcher(io.io);
    watcher.update('s1', root);
    await settle();
    watcher.remove('s1');
    const before = io.probes;
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS * 4);
    await settle();
    expect(io.probes).toBe(before);
  });

  it('drops a resolve that lands after the session moved to another cwd', async () => {
    const a = tmp();
    const b = tmp();
    initFakeRepo(a, 'stale');
    initFakeRepo(b, 'fresh');
    const io = holdableIo();
    const watcher = makeRemoteWatcher(io.io);
    io.hold();
    watcher.update('s1', a);
    watcher.update('s1', b);
    io.release();
    await settle();
    expect(events).toEqual([{ sessionId: 's1', branch: 'fresh', isWorktree: false }]);
  });

  it('drops a resolve that lands after the session was removed', async () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const io = holdableIo();
    const watcher = makeRemoteWatcher(io.io);
    io.hold();
    watcher.update('s1', root);
    watcher.remove('s1');
    io.release();
    await settle();
    expect(events).toEqual([]);
    expect(watcher.size).toBe(0);
  });

  it('a local cwd supersedes a WSL-share resolve still in flight', async () => {
    const remoteDir = tmp();
    const localDir = tmp();
    initFakeRepo(remoteDir, 'remote');
    initFakeRepo(localDir, 'local');
    const io = holdableIo();
    const w = new GitContextWatcher(fake.factory, { isRemote: (cwd) => cwd === remoteDir, io: io.io });
    watchers.push(w);
    w.on('git', (e) => events.push(e));
    io.hold();
    w.update('s1', remoteDir);
    w.update('s1', localDir);
    io.release();
    await settle();
    expect(events).toEqual([{ sessionId: 's1', branch: 'local', isWorktree: false }]);
  });

  it('reads as unknown when the share does not answer in time, then applies the late answer', async () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const io = holdableIo();
    const watcher = makeRemoteWatcher(io.io);
    io.hold();
    watcher.update('s1', root);
    await vi.advanceTimersByTimeAsync(REMOTE_RESOLVE_TIMEOUT_MS - 1);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual([{ sessionId: 's1', branch: null, isWorktree: false }]);

    io.release();
    await settle();
    expect(events.at(-1)).toEqual({ sessionId: 's1', branch: 'main', isWorktree: false });
  });

  it('a slow re-resolve of the same cwd keeps its live answer', async () => {
    const root = tmp();
    const io = holdableIo();
    const watcher = makeRemoteWatcher(io.io);
    watcher.update('s1', root);
    await settle();
    expect(events).toEqual([{ sessionId: 's1', branch: null, isWorktree: false, absent: true }]);
    io.hold();
    watcher.resync(); // re-resolves a non-repo session
    await vi.advanceTimersByTimeAsync(REMOTE_RESOLVE_TIMEOUT_MS);
    expect(events.every((e) => e.absent)).toBe(true);
    io.release();
    await settle();
    expect(events.at(-1)?.absent).toBe(true);
  });

  it('polls a host-drive worktree whose repository is on the share', async () => {
    // `/mnt/d/wt` made by git in the distro for a repo under `/home/…`: the
    // cwd is local, the HEAD it points at is not.
    const share = tmp();
    initFakeRepo(share);
    const wtGitDir = path.join(share, '.git', 'worktrees', 'wt');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/linked\n');
    const wt = tmp();
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /home/me/repo/.git/worktrees/wt\n');
    const w = new GitContextWatcher(fake.factory, { isRemote: (p) => p.startsWith(share), io: localIo });
    watchers.push(w);
    w.on('git', (e) => events.push(e));

    w.update('s1', wt, (gitdir) => gitdir.replace('/home/me/repo', share));
    expect(events).toEqual([]); // HEAD is not read on the event loop
    await settle();
    expect(events).toEqual([{ sessionId: 's1', branch: 'linked', isWorktree: true }]);
    expect(fake.arms).toHaveLength(0);

    fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/moved\n');
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    await settle();
    expect(events.at(-1)?.branch).toBe('moved');
  });

  it('a host-drive worktree whose share HEAD does not answer reads as unknown in time', async () => {
    const share = tmp();
    initFakeRepo(share);
    const wtGitDir = path.join(share, '.git', 'worktrees', 'wt');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/linked\n');
    const before = tmp();
    initFakeRepo(before, 'previous');
    const wt = tmp();
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /home/me/repo/.git/worktrees/wt\n');
    const io = holdableIo();
    const w = new GitContextWatcher(fake.factory, { isRemote: (p) => p.startsWith(share), io: io.io });
    watchers.push(w);
    w.on('git', (e) => events.push(e));
    w.update('s1', before);
    expect(events.at(-1)?.branch).toBe('previous');

    io.hold();
    w.update('s1', wt, (gitdir) => gitdir.replace('/home/me/repo', share));
    await vi.advanceTimersByTimeAsync(REMOTE_RESOLVE_TIMEOUT_MS);
    expect(events.at(-1)).toEqual({ sessionId: 's1', branch: null, isWorktree: false });
    io.release();
    await settle();
    expect(events.at(-1)).toEqual({ sessionId: 's1', branch: 'linked', isWorktree: true });
  });

  it('a move to the share cancelled by a cd back re-arms the local watch', async () => {
    const local = tmp();
    const share = tmp();
    initFakeRepo(local, 'main');
    const io = holdableIo();
    const w = new GitContextWatcher(fake.factory, { isRemote: (p) => p.startsWith(share), io: io.io });
    watchers.push(w);
    w.on('git', (e) => events.push(e));
    w.update('s1', local);
    expect(fake.arms).toHaveLength(1);

    io.hold();
    w.update('s1', share); // `cd ~` …
    w.update('s1', local); // … and straight back before it resolved
    io.release();
    await settle();
    expect(fake.arms).toHaveLength(2);
    expect(fake.last().closed).toBe(false);

    fs.writeFileSync(path.join(local, '.git', 'HEAD'), 'ref: refs/heads/after\n');
    fake.last().listener('change', 'HEAD');
    await vi.advanceTimersByTimeAsync(50);
    expect(events.at(-1)?.branch).toBe('after');
  });

  it('resync() while moving to another cwd keeps the move', async () => {
    const a = tmp();
    const b = tmp();
    initFakeRepo(b, 'dest');
    const io = holdableIo();
    const watcher = makeRemoteWatcher(io.io);
    watcher.update('s1', a);
    await settle();
    expect(events.at(-1)?.absent).toBe(true);

    io.hold();
    watcher.update('s1', b);
    watcher.resync(); // an app subscribing mid-move
    io.release();
    await settle();
    expect(events.at(-1)).toEqual({ sessionId: 's1', branch: 'dest', isWorktree: false });

    fs.writeFileSync(path.join(b, '.git', 'HEAD'), 'ref: refs/heads/dest2\n');
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    await settle();
    expect(events.at(-1)?.branch).toBe('dest2');
  });

  it('finds a .git created before the first round after an inconclusive walk', async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'HEAD'), 'not a repo\n'); // makes the walk inconclusive
    makeRemoteWatcher().update('s1', root);
    await settle();
    expect(events).toEqual([{ sessionId: 's1', branch: null, isWorktree: false }]);

    initFakeRepo(root, 'early');
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    await settle();
    expect(events.at(-1)).toEqual({ sessionId: 's1', branch: 'early', isWorktree: false });
  });

  it('picks up a .git file whose gitdir line is written in place', async () => {
    const main = tmp();
    initFakeRepo(main);
    const wtGitDir = path.join(main, '.git', 'worktrees', 'wt');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/fixed\n');
    const wt = tmp();
    fs.writeFileSync(path.join(wt, '.git'), 'garbage\n');
    makeRemoteWatcher().update('s1', wt);
    await settle();
    expect(events).toEqual([{ sessionId: 's1', branch: null, isWorktree: false }]);
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS); // the first round takes its baseline
    await settle();

    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGitDir}\n`);
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    await settle();
    expect(events.at(-1)).toEqual({ sessionId: 's1', branch: 'fixed', isWorktree: true });
  });

  it('walks again after a passing error made the walk inconclusive', async () => {
    const root = tmp();
    initFakeRepo(root, 'recovered');
    const cwd = path.join(root, 'a', 'b');
    fs.mkdirSync(cwd, { recursive: true });
    let failed = false;
    const flaky: ProbeIo = (probe) => {
      // The distro answers the ancestor's `.git` with an error once.
      if (!failed && probe.op === 'stat' && probe.path === path.join(root, '.git')) { failed = true; return Promise.resolve('error'); }
      return localIo(probe);
    };
    makeRemoteWatcher(flaky).update('s1', cwd);
    await settle();
    expect(events).toEqual([{ sessionId: 's1', branch: null, isWorktree: false }]);
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    await settle();
    expect(events.at(-1)).toEqual({ sessionId: 's1', branch: 'recovered', isWorktree: false });
  });

  it('backs off walking a cwd that stays inconclusive', async () => {
    const parent = tmp();
    const cwd = path.join(parent, 'bare');
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, 'HEAD'), 'not a repo\n'); // inconclusive for good
    let walks = 0;
    const counting: ProbeIo = (probe) => {
      if (probe.path === path.join(parent, '.git')) walks++; // only a walk looks above the cwd
      return localIo(probe);
    };
    makeRemoteWatcher(counting).update('s1', cwd);
    await settle();
    expect(walks).toBe(1);
    for (let round = 0; round < 15; round++) {
      await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
      await settle();
    }
    expect(walks).toBe(1 + 4); // rounds 1, 3, 7 and 15
  });

  it('a poll round the distro does not answer reads as unknown at its deadline, and queues nothing more', async () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const io = holdableIo();
    const watcher = makeRemoteWatcher(io.io);
    watcher.update('s1', root);
    await settle();
    expect(events).toEqual([{ sessionId: 's1', branch: 'main', isWorktree: false }]);

    io.hold();
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS); // the round starts and sticks
    const stuck = io.probes;
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_DEADLINE_MS - 1);
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(events.at(-1)).toEqual({ sessionId: 's1', branch: null, isWorktree: false });

    // Backed off, and nothing stacked behind the stuck round.
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MAX_MS * 2);
    expect(io.probes).toBe(stuck);
    expect(watcher.probesOutstanding).toBe(1);

    // The late answer is dropped; the next round reads afresh and recovers.
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/after\n');
    io.release();
    await settle();
    expect(events.at(-1)?.branch).toBeNull();
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MAX_MS);
    await settle();
    expect(events.at(-1)).toEqual({ sessionId: 's1', branch: 'after', isWorktree: false });
  });

  it('backs off a stuck poll, then returns to the normal interval once it answers', async () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const io = holdableIo();
    makeRemoteWatcher(io.io).update('s1', root);
    await settle();
    io.hold();
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS + REMOTE_POLL_DEADLINE_MS);
    io.release();
    await settle();
    const before = io.probes;
    // The next round comes at twice the interval, not at the normal one.
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS * 2 - 1);
    await settle();
    expect(io.probes).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(io.probes).toBe(before + 1);
    // Answered: the interval is back to normal.
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    await settle();
    expect(io.probes).toBe(before + 2);
  });

  it.runIf(process.platform === 'win32')('a wedged distro does not hold up another distro\'s panes', async () => {
    // Two distros' shares, answered from memory: A never answers, B does.
    let headB = 'ref: refs/heads/b-main\n';
    const answer: ProbeIo = ({ op, path: p }) => {
      if (/^\\\\wsl\$\\A\\/i.test(p)) return new Promise(() => undefined);
      if (op === 'stat') return Promise.resolve(p === '\\\\wsl$\\B\\repo\\.git' ? 'dir' : 'missing');
      if (op === 'read') return Promise.resolve(p === '\\\\wsl$\\B\\repo\\.git\\HEAD' ? headB : null);
      return Promise.resolve(p);
    };
    const w = new GitContextWatcher(fake.factory, { io: answer });
    watchers.push(w);
    w.on('git', (e) => events.push(e));
    w.update('a', '\\\\wsl$\\A\\repo');
    w.update('b', '\\\\wsl$\\B\\repo');
    await settle();
    expect(events).toEqual([{ sessionId: 'b', branch: 'b-main', isWorktree: false }]);
    headB = 'ref: refs/heads/b-next\n';
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    await settle();
    expect(events.at(-1)).toEqual({ sessionId: 'b', branch: 'b-next', isWorktree: false });
    await vi.advanceTimersByTimeAsync(REMOTE_RESOLVE_TIMEOUT_MS);
    expect(events.filter((e) => e.sessionId === 'a')).toEqual([{ sessionId: 'a', branch: null, isWorktree: false }]);
  });

  it('1,000 cds behind a stuck probe, then remove(): one probe in flight, none after', async () => {
    const io = holdableIo();
    const watcher = makeRemoteWatcher(io.io);
    const root = tmp();
    io.hold();
    watcher.update('s1', path.join(root, 'first'));
    await settle();
    expect(io.probes).toBe(1); // the first walk's first probe, now stuck
    for (let i = 0; i < 1_000; i++) watcher.update('s1', path.join(root, `d${i}`));
    await settle();
    expect(watcher.probesOutstanding).toBe(1); // coalesced: nothing queued behind it
    watcher.remove('s1');
    io.release();
    await settle();
    expect(io.probes).toBe(1);
    expect(events).toEqual([]);
  });

  it('1,000 cds behind a stuck probe walk only the last one', async () => {
    const io = holdableIo();
    const watcher = makeRemoteWatcher(io.io);
    const root = tmp();
    const last = path.join(root, 'd999');
    fs.mkdirSync(last);
    initFakeRepo(last, 'latest');
    io.hold();
    watcher.update('s1', path.join(root, 'first'));
    await settle();
    for (let i = 0; i < 1_000; i++) watcher.update('s1', path.join(root, `d${i}`));
    io.release();
    await settle();
    expect(events).toEqual([{ sessionId: 's1', branch: 'latest', isWorktree: false }]);
    // The stuck probe, then the last cwd's own walk and HEAD read: `.git` is a
    // directory there, so two probes.
    expect(io.probes).toBe(1 + 2);
  });

  it('serialProbeIo runs one probe at a time', async () => {
    const order: string[] = [];
    let finishFirst: (() => void) | undefined;
    const io = serialProbeIo((probe) => {
      order.push(`start ${probe.path}`);
      if (probe.path === 'a') {
        return new Promise((resolve) => { finishFirst = () => { order.push('end a'); resolve('missing'); }; });
      }
      order.push(`end ${probe.path}`);
      return Promise.resolve('missing');
    });
    const first = io({ op: 'stat', path: 'a' });
    const second = io({ op: 'stat', path: 'b' });
    await settle();
    expect(order).toEqual(['start a']);
    finishFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
  });
});
