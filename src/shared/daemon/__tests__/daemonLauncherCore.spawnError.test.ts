import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { ensureDaemon, type DaemonLauncherDeps } from '../daemonLauncherCore';

/**
 * CodeRabbit finding on #1019: `spawn()` reports failures asynchronously via
 * an `error` event (EMFILE, EACCES, ...). Without a listener, that emission
 * throws an UNCAUGHT exception rather than rejecting `ensureDaemon`'s
 * promise — which bypasses the clean `wmux daemon start: <message>` / exit 1
 * contract every caller, including the new headless CLI, relies on.
 *
 * Mocking `child_process.spawn` lets this be a fast, portable unit test
 * instead of trying to provoke a genuine EMFILE/EACCES on the real OS.
 */
class FakeChildProcess extends EventEmitter {
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  unref(): void { /* real ChildProcess#unref has no observable return; no-op is correct here */ }
}

let fakeChild: FakeChildProcess;

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeChild),
  };
});

// `vi.mock` above is hoisted above these imports by vitest's transform, so
// daemonLauncherCore's `import { spawn } from 'child_process'` binds to the
// mocked export even though this import is written after it.

describe('daemonLauncherCore — spawn error handling (#1019 CodeRabbit finding)', () => {
  let wmuxDir: string;
  let prevSuffix: string | undefined;
  let suffix: string;
  let scriptPath: string;

  beforeEach(() => {
    suffix = `-spawn-error-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    prevSuffix = process.env.WMUX_DATA_SUFFIX;
    process.env.WMUX_DATA_SUFFIX = suffix;
    wmuxDir = path.join(os.homedir(), `.wmux${suffix}`);
    fs.mkdirSync(wmuxDir, { recursive: true });
    // Must exist on disk — spawnDaemon only proceeds past the "script not
    // found" check once a candidate resolves via fs.existsSync.
    scriptPath = path.join(wmuxDir, 'fake-daemon-index.js');
    fs.writeFileSync(scriptPath, '// not actually run — spawn is mocked\n');
    fakeChild = new FakeChildProcess();
  });

  afterEach(() => {
    if (prevSuffix === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = prevSuffix;
    fs.rmSync(wmuxDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function deps(): DaemonLauncherDeps {
    return {
      resolveDaemonScriptCandidates: () => [scriptPath],
      resolveSpawnedByVersion: () => '9.9.9-test',
      askUserToRecoverFromStalePid: async () => false,
      isElectronHost: () => false,
    };
  }

  it('rejects cleanly instead of throwing uncaught when spawn emits "error"', async () => {
    const promise = ensureDaemon(deps());

    // Simulate an asynchronous spawn failure (EMFILE/EACCES class) BEFORE
    // the pid guard would have run synchronously in the real event loop —
    // emitting on the next microtask mirrors how Node actually reports it.
    await Promise.resolve();
    fakeChild.emit('error', Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }));

    await expect(promise).rejects.toThrow(/Failed to spawn daemon.*EMFILE/);
  });

  it('does not reject twice when both "error" and the pid guard could fire', async () => {
    // pid stays defined here (4242), so this exercises the case where
    // 'error' fires despite a pid existing (e.g. the process was created
    // but immediately failed) — reject() must be idempotent, not throw on
    // a second settle attempt.
    const promise = ensureDaemon(deps());
    await Promise.resolve();
    fakeChild.emit('error', new Error('spawn EACCES'));
    fakeChild.emit('exit', 1);
    await expect(promise).rejects.toThrow(/Failed to spawn daemon/);
  });
});
