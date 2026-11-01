import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { ensureDaemon, type DaemonLauncherDeps } from '../daemonLauncherCore';
import { deliberateSleep } from '../../../test-utils/waitFor';

/**
 * The Windows daemon runs from a copy of the app outside the install
 * (main/daemon/daemonRuntimeStage.ts). The first spawn of a build waits for
 * that copy, which runs async, and spawns from it; a stage that comes back
 * null (a failed or half copy) spawns from the install.
 */
class FakeChildProcess extends EventEmitter {
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  unref(): void { /* nothing to release in a fake */ }
}

let fakeChild: FakeChildProcess;

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: vi.fn(() => fakeChild) };
});

describe('daemonLauncherCore — the staged daemon runtime', () => {
  let wmuxDir: string;
  let prevSuffix: string | undefined;
  let scriptPath: string;

  beforeEach(() => {
    const suffix = `-staged-runtime-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    prevSuffix = process.env.WMUX_DATA_SUFFIX;
    process.env.WMUX_DATA_SUFFIX = suffix;
    wmuxDir = path.join(os.homedir(), `.wmux${suffix}`);
    fs.mkdirSync(wmuxDir, { recursive: true });
    scriptPath = path.join(wmuxDir, 'install-daemon-index.js');
    fs.writeFileSync(scriptPath, '// not run: spawn is mocked\n');
    fakeChild = new FakeChildProcess();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    if (prevSuffix === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = prevSuffix;
    fs.rmSync(wmuxDir, { recursive: true, force: true });
  });

  const deps = (stageDaemonRuntime: DaemonLauncherDeps['stageDaemonRuntime']): DaemonLauncherDeps => ({
    resolveDaemonScriptCandidates: () => [scriptPath],
    resolveSpawnedByVersion: () => '9.9.9-test',
    askUserToRecoverFromStalePid: async () => false,
    isElectronHost: () => false,
    stageDaemonRuntime,
    log: () => { /* quiet */ },
    warn: () => { /* quiet */ },
  });

  /** Ends the spawn the test looked at, so ensureDaemon settles. */
  async function endSpawn(promise: Promise<unknown>): Promise<void> {
    fakeChild.emit('error', new Error('spawn EACCES'));
    await expect(promise).rejects.toThrow(/Failed to spawn daemon/);
  }

  it('waits for the copy in progress, then spawns from it', async () => {
    let finish!: (staged: { script: string; nodePath: string; dir: string } | null) => void;
    const stage = vi.fn(() => new Promise<{ script: string; nodePath: string; dir: string } | null>((r) => { finish = r; }));
    const promise = ensureDaemon(deps(stage));
    await vi.waitFor(() => expect(stage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    await deliberateSleep(50, 'negative: no spawn while the copy is in progress');
    expect(spawn).not.toHaveBeenCalled();

    const dir = path.join(wmuxDir, 'daemon-runtime', '9.9.9-1');
    finish({ script: path.join(dir, 'resources', 'daemon-bundle', 'index.js'), nodePath: path.join(dir, 'wmux.exe'), dir });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const [command, args, options] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[], { cwd?: string }];
    expect(command).toBe(path.join(dir, 'wmux.exe'));
    expect(args).toContain(path.join(dir, 'resources', 'daemon-bundle', 'index.js'));
    expect(options.cwd).toBe(dir);
    await endSpawn(promise);
  });

  it('spawns from the install when the copy could not be made', async () => {
    const promise = ensureDaemon(deps(async () => null));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const [, args, options] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[], { cwd?: string }];
    expect(args).toContain(scriptPath);
    expect(options.cwd).toBeUndefined();
    await endSpawn(promise);
  });
});
