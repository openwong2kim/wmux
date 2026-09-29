import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitContextWatcher } from '../gitContextWatch';
import { shortPathOf } from '../../../test-utils/shortPath';

/**
 * Real-filesystem end-to-end proof that the production default actually wires
 * `fs.watch` and re-emits on a real HEAD rewrite. The deterministic logic
 * (filename filtering, debounce coalescing, re-resolve, teardown) is covered by
 * the fake-watcher unit tests in gitContextWatch.test.ts; this one exists only
 * so a regression in the default wiring cannot hide behind the test seam.
 *
 * Lives under vitest.runtime.config.ts (serial, no file parallelism) because it
 * waits on real FSEvents/inotify delivery, whose latency is load-dependent —
 * hence the generous per-test timeout.
 */

const tmpDirs: string[] = [];
const watchers: GitContextWatcher[] = [];

afterEach(() => {
  for (const w of watchers.splice(0)) w.dispose();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win32 lock */ }
  }
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-gitwatch-rt-'));
  tmpDirs.push(dir);
  return dir;
}

describe('GitContextWatcher (real fs.watch)', () => {
  it('re-emits on a real HEAD rewrite with the default fs.watch wiring', async () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    const watcher = new GitContextWatcher();
    watchers.push(watcher);

    type GitEvent = { sessionId: string; branch: string | null; isWorktree: boolean };
    const events: GitEvent[] = [];
    const secondEvent = new Promise<void>((resolve) => {
      watcher.on('git', (e: GitEvent) => {
        events.push(e);
        if (events.length === 2) resolve();
      });
    });

    watcher.update('s1', root);
    expect(events).toEqual([{ sessionId: 's1', branch: 'main', isWorktree: false }]);

    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/feature-y\n');
    await secondEvent;
    expect(events[1].branch).toBe('feature-y');
  }, 15_000);

  it.runIf(process.platform === 'win32')('re-emits on an in-place HEAD rewrite when the cwd is an 8.3 short path (#984)', async (ctx) => {
    // For a directory watched through a short alias, libuv 1.52 reports
    // `<tail of the long dir>\HEAD` instead of `HEAD` with asserts off
    // (Electron 41) and aborts the process with asserts on (official Node
    // 24.16–24.20 and 26.0–26.7). Either way the HEAD filter never matches.
    // This models an IN-PLACE write, as a tool other than git would make. git
    // swaps HEAD in via HEAD.lock + rename, and libuv reports those events
    // under their raw names, so `git checkout` got through even before the
    // fix. The `git init` case below is the one a git user hits.
    const root = tmp();
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const short = shortPathOf(root);
    if (!short) return ctx.skip(); // 8.3 names are off for this volume

    const watcher = new GitContextWatcher();
    watchers.push(watcher);

    type GitEvent = { sessionId: string; branch: string | null; isWorktree: boolean };
    const events: GitEvent[] = [];
    const secondEvent = new Promise<void>((resolve) => {
      watcher.on('git', (e: GitEvent) => {
        events.push(e);
        if (events.length === 2) resolve();
      });
    });

    watcher.update('s1', short);
    expect(events).toEqual([{ sessionId: 's1', branch: 'main', isWorktree: false }]);

    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/feature-y\n');
    await secondEvent;
    expect(events[1].branch).toBe('feature-y');
  }, 15_000);

  it.runIf(process.platform === 'win32')('picks up a real `git init` in a cwd spelled with an 8.3 short path (#984)', async (ctx) => {
    // Reproduced live on Electron 41: through a short alias every event for
    // the new `.git` arrived under a garbled name, so the non-repo watch never
    // re-resolved, and the sidebar showed no branch until the first commit.
    // The 5 s metadata poll cannot fill that in: it cannot read an unborn
    // branch.
    const root = tmp();
    const short = shortPathOf(root);
    if (!short) return ctx.skip(); // 8.3 names are off for this volume
    if (spawnSync('git', ['--version']).status !== 0) return ctx.skip(); // no git on PATH

    const watcher = new GitContextWatcher();
    watchers.push(watcher);

    type GitEvent = { sessionId: string; branch: string | null; isWorktree: boolean };
    const events: GitEvent[] = [];
    const sawMain = new Promise<void>((resolve) => {
      watcher.on('git', (e: GitEvent) => {
        events.push(e);
        if (e.branch === 'main') resolve();
      });
    });

    watcher.update('s1', short);
    expect(events).toEqual([{ sessionId: 's1', branch: null, isWorktree: false }]);

    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: root, stdio: 'ignore' });
    await sawMain;
    expect(events.at(-1)).toEqual({ sessionId: 's1', branch: 'main', isWorktree: false });
  }, 15_000);
});
