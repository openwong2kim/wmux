import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitContextWatcher, parseHead, resolveRepo, readGitContext } from '../gitContextWatch';

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

function makeWatcher(): GitContextWatcher {
  const w = new GitContextWatcher();
  watchers.push(w);
  return w;
}

function host(cwd: string, sessionId = 's1') {
  return { sessionId, location: { domain: 'host' as const, cwd, shell: 'pwsh.exe' } };
}

afterEach(() => {
  for (const w of watchers.splice(0)) w.dispose();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win32 lock */ }
  }
});

function waitForEvent<T>(watcher: GitContextWatcher, event: string, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    watcher.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
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
  it('emits the initial branch on update()', async () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const watcher = makeWatcher();
    const eventP = waitForEvent<{ sessionId: string; branch: string | null; isWorktree: boolean }>(watcher, 'git');
    watcher.update('s1', host(root));
    const ev = await eventP;
    expect(ev).toEqual({ sessionId: 's1', branch: 'main', isWorktree: false });
  });

  it('emits again when HEAD changes (branch switch)', async () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const watcher = makeWatcher();
    const firstP = waitForEvent(watcher, 'git');
    watcher.update('s1', host(root));
    await firstP;

    const secondP = waitForEvent<{ branch: string | null }>(watcher, 'git');
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/feature-y\n');
    const ev = await secondP;
    expect(ev.branch).toBe('feature-y');
  });

  it('does not re-emit an unchanged value on a repeated update()', async () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const watcher = makeWatcher();
    const events: unknown[] = [];
    watcher.on('git', (e) => events.push(e));
    watcher.update('s1', host(root));
    watcher.update('s1', host(root));
    watcher.update('s1', host(path.join(root))); // identical cwd
    await new Promise((r) => setTimeout(r, 150));
    expect(events).toHaveLength(1);
  });

  it('emits branch null when leaving a repo for a non-repo cwd', async () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const plain = tmp();
    const watcher = makeWatcher();
    const firstP = waitForEvent(watcher, 'git');
    watcher.update('s1', host(root));
    await firstP;

    const secondP = waitForEvent<{ branch: string | null; isWorktree: boolean }>(watcher, 'git');
    watcher.update('s1', host(plain));
    const ev = await secondP;
    expect(ev.branch).toBeNull();
    expect(ev.isWorktree).toBe(false);
  });

  it('picks up a git init in a previously non-repo cwd without polling', async () => {
    const root = tmp();
    const watcher = makeWatcher();
    watcher.update('s1', host(root));
    await new Promise((r) => setTimeout(r, 100));

    const eventP = waitForEvent<{ branch: string | null }>(watcher, 'git');
    initFakeRepo(root, 'fresh');
    const ev = await eventP;
    expect(ev.branch).toBe('fresh');
  });

  it('remove() drops the session watcher', () => {
    const root = tmp();
    initFakeRepo(root);
    const watcher = makeWatcher();
    watcher.update('s1', host(root));
    expect(watcher.size).toBe(1);
    watcher.remove('s1');
    expect(watcher.size).toBe(0);
  });

  it('rejects a WSL watch when active session context is stale', () => {
    const watcher = makeWatcher();
    watcher.update('s1', {
      sessionId: 's1',
      location: { domain: 'wsl', cwd: '/repo', shell: 'wsl.exe', distro: 'Ubuntu' },
      activeContext: { sessionId: 'stale', active: true, distro: 'Ubuntu' },
    });
    expect(watcher.size).toBe(0);
  });
});
