import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

/**
 * macOS daemon launch strategy: a launchd job when the host opts in on
 * darwin, the detached spawn otherwise, and the detached spawn as fallback
 * only when launchd could not load the job at all.
 */
class FakeChildProcess extends EventEmitter {
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  unref(): void { /* no-op */ }
}

let fakeChild: FakeChildProcess;
const spawnMock = vi.fn(() => fakeChild);
const startMock = vi.fn();
const noop = (): void => undefined;

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: (...a: unknown[]) => (spawnMock as (...x: unknown[]) => unknown)(...a) };
});

vi.mock('../launchdDaemonJob', async () => {
  const actual = await vi.importActual<typeof import('../launchdDaemonJob')>('../launchdDaemonJob');
  return { ...actual, startDaemonViaLaunchd: (...a: unknown[]) => startMock(...a) };
});

import { ensureDaemon, shouldLaunchDaemonViaLaunchd, type DaemonLauncherDeps } from '../daemonLauncherCore';
import { LaunchdUnavailableError } from '../launchdDaemonJob';

describe('shouldLaunchDaemonViaLaunchd', () => {
  it('only on darwin and only when the host opted in', () => {
    expect(shouldLaunchDaemonViaLaunchd({ launchViaLaunchdOnDarwin: true }, 'darwin')).toBe(true);
    expect(shouldLaunchDaemonViaLaunchd({}, 'darwin')).toBe(false);
    expect(shouldLaunchDaemonViaLaunchd({ launchViaLaunchdOnDarwin: true }, 'linux')).toBe(false);
    expect(shouldLaunchDaemonViaLaunchd({ launchViaLaunchdOnDarwin: true }, 'win32')).toBe(false);
  });
});

describe('daemonLauncherCore — launch strategy', () => {
  let wmuxDir: string;
  let prevSuffix: string | undefined;
  let scriptPath: string;
  const realPlatform = process.platform;

  beforeEach(() => {
    const suffix = `-launch-strategy-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    prevSuffix = process.env.WMUX_DATA_SUFFIX;
    process.env.WMUX_DATA_SUFFIX = suffix;
    wmuxDir = path.join(os.homedir(), `.wmux${suffix}`);
    fs.mkdirSync(wmuxDir, { recursive: true });
    scriptPath = path.join(wmuxDir, 'fake-daemon-index.js');
    fs.writeFileSync(scriptPath, '// never run\n');
    fakeChild = new FakeChildProcess();
    spawnMock.mockClear();
    startMock.mockReset();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    if (prevSuffix === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = prevSuffix;
    fs.rmSync(wmuxDir, { recursive: true, force: true });
  });

  function deps(launchd: boolean): DaemonLauncherDeps {
    return {
      resolveDaemonScriptCandidates: () => [scriptPath],
      resolveSpawnedByVersion: () => '9.9.9-test',
      askUserToRecoverFromStalePid: async () => false,
      isElectronHost: () => true,
      launchViaLaunchdOnDarwin: launchd,
      log: noop,
      warn: noop,
    };
  }

  it('starts a launchd job (not a child) with the spawn env and argv', async () => {
    startMock.mockResolvedValue({
      label: 'com.wmux.daemon.x',
      pid: 777,
      isAlive: () => false,
      onExit: (cb: (c: number | null) => void) => cb(1),
      dispose: noop,
    });
    await expect(ensureDaemon(deps(true))).rejects.toThrow(/exited during startup \(code 1\)/);
    expect(spawnMock).not.toHaveBeenCalled();
    const [opts] = startMock.mock.calls[0] as [{ baseLabel: string; plistDir: string; programArguments: string[]; env: Record<string, string> }];
    expect(opts.baseLabel).toBe(`com.wmux.daemon${process.env.WMUX_DATA_SUFFIX}`);
    expect(opts.plistDir).toBe(path.join(wmuxDir, 'launchd'));
    expect(opts.programArguments).toEqual([process.execPath, scriptPath]);
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(opts.env.WMUX_SPAWNED_BY_VERSION).toBe('9.9.9-test');
  });

  it('maps an early yield exit of the launchd job to EDAEMON_ALREADY_RUNNING handling', async () => {
    startMock.mockResolvedValue({
      label: 'com.wmux.daemon.x',
      pid: null,
      isAlive: () => false,
      onExit: (cb: (c: number | null) => void) => cb(3),
      dispose: noop,
    });
    // The yield path then tries to reconnect to the owning daemon, which does
    // not exist here — either way it must not fall back to a spawn.
    await expect(ensureDaemon(deps(true))).rejects.toThrow();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('falls back to the detached spawn when launchd cannot load the job', async () => {
    startMock.mockRejectedValue(new LaunchdUnavailableError('Bootstrap failed: 125'));
    const p = ensureDaemon(deps(true));
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    fakeChild.emit('error', new Error('spawn EACCES'));
    await expect(p).rejects.toThrow(/Failed to spawn daemon/);
  });

  it('does not fall back after the job was loaded (would start a second daemon)', async () => {
    startMock.mockRejectedValue(new Error('launchd job x was loaded but its daemon pid never appeared'));
    await expect(ensureDaemon(deps(true))).rejects.toThrow(/pid never appeared/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('clears leftover launchd plists on entry, before any start', async () => {
    const plistDir = path.join(wmuxDir, 'launchd');
    fs.mkdirSync(plistDir, { recursive: true });
    const leftover = path.join(plistDir, `com.wmux.daemon${process.env.WMUX_DATA_SUFFIX}.abc-1.plist`);
    fs.writeFileSync(leftover, 'env');
    let seenAtStart = true;
    startMock.mockImplementation(async () => {
      seenAtStart = fs.existsSync(leftover);
      throw new Error('stop here');
    });
    await expect(ensureDaemon(deps(true))).rejects.toThrow(/stop here/);
    expect(seenAtStart).toBe(false);
  });

  it('keeps the plain spawn when the host did not opt in', async () => {
    const p = ensureDaemon(deps(false));
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    fakeChild.emit('error', new Error('spawn EACCES'));
    await expect(p).rejects.toThrow(/Failed to spawn daemon/);
    expect(startMock).not.toHaveBeenCalled();
  });
});
