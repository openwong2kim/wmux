// Uninstall removes the staged daemon copies only once the daemons it stopped
// have exited: taskkill /F returns before the process is gone, and a delete
// that races its exit leaves a half-deleted copy.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { removeDaemonRuntimeStagesAfterExit } from '../daemonRuntimeStage';
import type { ProcessLiveness } from '../../../shared/processLiveness';

describe('removeDaemonRuntimeStagesAfterExit', () => {
  let root: string;
  let stageRoot: string;
  let files: string[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-stage-uninstall-'));
    stageRoot = path.join(root, 'daemon-runtime');
    const copy = path.join(stageRoot, '4.13.0-1');
    fs.mkdirSync(path.join(copy, 'resources', 'daemon-bundle'), { recursive: true });
    files = [path.join(copy, 'wmux.exe'), path.join(copy, 'resources', 'app.asar'), path.join(copy, 'resources', 'daemon-bundle', 'index.js')];
    for (const file of files) fs.writeFileSync(file, 'x');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  /** A clock that moves only when the wait sleeps. */
  function fakeClock() {
    let t = 0;
    const slept: number[] = [];
    return { now: () => t, sleep: (ms: number) => { slept.push(ms); t += ms; }, slept };
  }

  it('waits for a stopped daemon to exit, then removes the copies', () => {
    const clock = fakeClock();
    let probes = 0;
    const liveness = (pid: number): ProcessLiveness => {
      expect(pid).toBe(4242);
      probes++;
      // Still exiting: nothing is deleted yet.
      expect(files.every((file) => fs.existsSync(file))).toBe(true);
      return probes <= 3 ? 'alive' : 'dead';
    };
    expect(removeDaemonRuntimeStagesAfterExit(stageRoot, [4242], { liveness, ...clock })).toEqual({ exiting: [], removed: true });
    expect(probes).toBe(4);
    expect(clock.slept).toEqual([100, 100, 100]);
    expect(fs.existsSync(stageRoot)).toBe(false);
  });

  it('leaves the copies whole when a daemon has not exited by the deadline', () => {
    const clock = fakeClock();
    const states: Record<number, ProcessLiveness> = { 10: 'dead', 11: 'alive', 12: 'unknown' };
    const result = removeDaemonRuntimeStagesAfterExit(stageRoot, [10, 11, 12], { liveness: (pid) => states[pid]!, waitMs: 500, ...clock });
    expect(result).toEqual({ exiting: [11, 12], removed: false });
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBe(500);
    expect(files.every((file) => fs.existsSync(file))).toBe(true);
  });

  it('removes at once when no daemon was stopped', () => {
    const clock = fakeClock();
    const liveness = (): ProcessLiveness => { throw new Error('nothing to probe'); };
    expect(removeDaemonRuntimeStagesAfterExit(stageRoot, [], { liveness, ...clock })).toEqual({ exiting: [], removed: true });
    expect(clock.slept).toEqual([]);
    expect(fs.existsSync(stageRoot)).toBe(false);
  });
});
