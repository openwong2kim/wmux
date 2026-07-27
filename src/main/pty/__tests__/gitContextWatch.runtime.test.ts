import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitContextWatcher } from '../gitContextWatch';

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
});
