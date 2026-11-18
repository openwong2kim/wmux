import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { ensureDaemon, DAEMON_STDERR_LOG, DAEMON_STDERR_ROTATE_BYTES, type DaemonLauncherDeps } from '../daemonLauncherCore';

/**
 * #3440: the direct spawn (Windows, Linux) hands the daemon an append-mode
 * stderr file and closes its own copy right after; when the file cannot be
 * opened the daemon is still spawned, with stderr ignored as before.
 */
class FakeChildProcess extends EventEmitter {
  pid: number | undefined = 4343;
  exitCode: number | null = null;
  unref(): void { /* nothing to release in a fake */ }
}

let fakeChild: FakeChildProcess;

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: vi.fn(() => fakeChild) };
});

describe('daemonLauncherCore: the daemon stderr file', () => {
  let wmuxDir: string;
  let prevSuffix: string | undefined;
  let scriptPath: string;
  let stderrFile: string;

  beforeEach(() => {
    const suffix = `-stderr-log-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    prevSuffix = process.env.WMUX_DATA_SUFFIX;
    process.env.WMUX_DATA_SUFFIX = suffix;
    wmuxDir = path.join(os.homedir(), `.wmux${suffix}`);
    fs.mkdirSync(wmuxDir, { recursive: true });
    scriptPath = path.join(wmuxDir, 'install-daemon-index.js');
    fs.writeFileSync(scriptPath, '// not run: spawn is mocked\n');
    stderrFile = path.join(wmuxDir, DAEMON_STDERR_LOG);
    fakeChild = new FakeChildProcess();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    if (prevSuffix === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = prevSuffix;
    fs.rmSync(wmuxDir, { recursive: true, force: true });
  });

  const deps: () => DaemonLauncherDeps = () => ({
    resolveDaemonScriptCandidates: () => [scriptPath],
    resolveSpawnedByVersion: () => '9.9.9-test',
    askUserToRecoverFromStalePid: async () => false,
    isElectronHost: () => false,
    stageDaemonRuntime: async () => null,
    log: () => { /* quiet */ },
    warn: () => { /* quiet */ },
  });

  /** Ends the spawn the test looked at, so ensureDaemon settles. */
  async function endSpawn(promise: Promise<unknown>): Promise<void> {
    fakeChild.emit('error', new Error('spawn EACCES'));
    await expect(promise).rejects.toThrow(/Failed to spawn daemon/);
  }

  async function spawnedStdio(): Promise<unknown[]> {
    const promise = ensureDaemon(deps());
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const [, , options] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[], { stdio: unknown[] }];
    await endSpawn(promise);
    return options.stdio;
  }

  it('spawns with stdin and stdout ignored and stderr on the file, and closes its own descriptor', async () => {
    const stdio = await spawnedStdio();
    expect(stdio.slice(0, 2)).toEqual(['ignore', 'ignore']);
    const fd = stdio[2];
    expect(typeof fd).toBe('number');
    expect(fs.existsSync(stderrFile)).toBe(true);
    // Closed in the parent right after spawn.
    expect(() => fs.fstatSync(fd as number)).toThrow();
  });

  it('rotates a file past 1 MiB to .1 at spawn', async () => {
    fs.writeFileSync(stderrFile, Buffer.alloc(DAEMON_STDERR_ROTATE_BYTES + 1, 0x61));
    await spawnedStdio();
    expect(fs.statSync(`${stderrFile}.1`).size).toBe(DAEMON_STDERR_ROTATE_BYTES + 1);
    expect(fs.statSync(stderrFile).size).toBe(0);
  });

  it('still spawns, with stderr ignored, when the file cannot be opened', async () => {
    fs.mkdirSync(stderrFile); // a directory where the file should be
    const stdio = await spawnedStdio();
    expect(stdio).toEqual(['ignore', 'ignore', 'ignore']);
  });
});
