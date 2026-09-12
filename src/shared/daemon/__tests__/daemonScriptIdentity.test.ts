import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import {
  argvIdentifiesDaemonScript,
  psArgvFromCommand,
  killVerifiedDaemonPid,
  ensureDaemon,
  type DaemonLauncherDeps,
} from '../daemonLauncherCore';

/**
 * #1025 redo (#1028) — the four requirements, each pinned here:
 *
 *  1. Entry-script POSITION comparison, not any-token: our script path as a
 *     mere argument must not verify the process as the daemon.
 *  2. argv preserved as an array (NUL-split /proc cmdline on Linux; the
 *     progressive re-join covers space-joined `ps` output elsewhere).
 *  3. The cross-host fallback is an exclusive branch with an EXACT shape
 *     (`daemon-bundle/index.js`), so `daemon-bundler` / `daemon-bundle-backup`
 *     no longer match via startsWith.
 *  4. ensureDaemon's cmdline-mismatch branch REFUSES (or asks) instead of
 *     cleaning + spawning over a possibly-live daemon (#537/#543 shape).
 *
 * #1027's test flaw ("injected candidates by hand, leaving the actual new
 * wiring unexercised") is answered by the ensureDaemon tests below, which
 * reach the matcher through `deps.resolveDaemonScriptCandidates` — the real
 * wiring — and by the execution tests, which assert on real OS probes.
 */
describe('argvIdentifiesDaemonScript — unit (#1025/#1028)', () => {
  it('matches a candidate at the entry position', () => {
    expect(argvIdentifiesDaemonScript(
      ['/usr/bin/node', '/opt/wmux/dist/daemon/index.js'],
      ['/opt/wmux/dist/daemon/index.js'],
    )).toBe(true);
  });

  it('skips runtime flags when locating the entry script', () => {
    expect(argvIdentifiesDaemonScript(
      ['/usr/bin/node', '--max-old-space-size=4096', '/opt/wmux/dist/daemon/index.js'],
      ['/opt/wmux/dist/daemon/index.js'],
    )).toBe(true);
  });

  it('requirement 1: a candidate path in a NON-entry argument does not match (the vim case)', () => {
    expect(argvIdentifiesDaemonScript(
      ['/usr/bin/node', '/srv/other-tool/main.js', '/opt/wmux/dist/daemon-bundle/index.js'],
      ['/opt/wmux/dist/daemon-bundle/index.js'],
    )).toBe(false);
  });

  it('requirement 2 corollary: a space-shattered POSIX line re-joins against a known candidate', () => {
    // macOS `ps` output for an install under "/Applications/wmux 2.app/...":
    // the path arrives as two whitespace tokens. The exact candidate is
    // known, so the progressive re-join recovers the identity.
    expect(argvIdentifiesDaemonScript(
      ['/usr/bin/node', '/Applications/wmux', '2.app/daemon-bundle/index.js'],
      ['/Applications/wmux 2.app/daemon-bundle/index.js'],
    )).toBe(true);
  });

  it('the #1025 bug stays dead: a generic daemon/index.js layout never matches', () => {
    expect(argvIdentifiesDaemonScript(
      ['/usr/bin/node', '/srv/someones-app/daemon/index.js'],
      [],
    )).toBe(false);
    expect(argvIdentifiesDaemonScript(
      ['/usr/bin/node', '/srv/someones-app/daemon/index.js'],
      ['/opt/wmux/dist/daemon/index.js'],
    )).toBe(false);
  });

  it('cross-host fallback: exact daemon-bundle/index.js shape matches with no candidates', () => {
    expect(argvIdentifiesDaemonScript(
      ['/usr/bin/other-host-node', '/opt/wmux/resources/daemon-bundle/index.js'],
      [],
    )).toBe(true);
  });

  it('requirement 3: suffixed directory names no longer match (startsWith is gone)', () => {
    for (const dir of ['daemon-bundler', 'daemon-bundle-backup', 'my-daemon-bundle']) {
      expect(argvIdentifiesDaemonScript(
        ['/usr/bin/node', `/srv/${dir}/index.js`],
        [],
      )).toBe(false);
    }
    // A single segment merely CONTAINING the marker is not the shape either.
    expect(argvIdentifiesDaemonScript(
      ['/usr/bin/node', '/tmp/daemon-bundle-fake-index.js'],
      [],
    )).toBe(false);
    // Right directory, wrong entry file.
    expect(argvIdentifiesDaemonScript(
      ['/usr/bin/node', '/opt/wmux/daemon-bundle/other.js'],
      [],
    )).toBe(false);
  });

  it('#1132: a macOS install whose EXECUTABLE and script both fragment still matches', () => {
    // Real dogfood argv from `/Applications/wmux 2.app` — the name macOS
    // gives a second copy. `ps -o comm=` anchors argv[0] whole, so only the
    // script fragments and the progressive re-join reaches the candidate.
    const exe = '/Applications/wmux 2.app/Contents/MacOS/wmux';
    const script = '/Applications/wmux 2.app/Contents/Resources/daemon-bundle/index.js';
    const argv = psArgvFromCommand(`${exe} ${script}`, exe);
    expect(argv).toEqual([exe, '/Applications/wmux', '2.app/Contents/Resources/daemon-bundle/index.js']);
    expect(argvIdentifiesDaemonScript(argv!, [script])).toBe(true);
  });

  it('#1132: the trailing-argument case stays false through the same probe path', () => {
    // Requirement 1 re-checked against comm-anchored argv: our script as a
    // mere argument must still not verify the process.
    const argv = psArgvFromCommand(
      '/usr/bin/node /srv/other-tool/main.js /opt/wmux/dist/daemon-bundle/index.js',
      '/usr/bin/node',
    );
    expect(argvIdentifiesDaemonScript(argv!, ['/opt/wmux/dist/daemon-bundle/index.js'])).toBe(false);
    // ...and with a fragmented executable in front of it too.
    const spacedExe = '/Applications/evil 2.app/Contents/MacOS/node';
    const argv2 = psArgvFromCommand(
      `${spacedExe} /srv/other-tool/main.js /opt/wmux/dist/daemon-bundle/index.js`,
      spacedExe,
    );
    expect(argvIdentifiesDaemonScript(argv2!, ['/opt/wmux/dist/daemon-bundle/index.js'])).toBe(false);
  });

  it('#1132: psArgvFromCommand falls back to whitespace tokens without a usable comm', () => {
    expect(psArgvFromCommand('/usr/bin/node /x/index.js', '')).toEqual(['/usr/bin/node', '/x/index.js']);
    // comm that is not the line's prefix (argv[0] rewritten) must not be forced on.
    expect(psArgvFromCommand('/usr/bin/node /x/index.js', '/other/bin/node'))
      .toEqual(['/usr/bin/node', '/x/index.js']);
    expect(psArgvFromCommand('   ', '/usr/bin/node')).toBe(null);
    // A TRUNCATED comm that happens to be a prefix must not cut mid-path:
    // the remainder would not start with '/' or '-', so the strip is refused.
    expect(psArgvFromCommand(
      '/Applications/wmux 2.app/Contents/MacOS/wmux /Applications/wmux 2.app/x/daemon-bundle/index.js',
      '/Applications/wmux',
    )).toEqual([
      '/Applications/wmux', '2.app/Contents/MacOS/wmux',
      '/Applications/wmux', '2.app/x/daemon-bundle/index.js',
    ]);
    // Runtime flags after the executable are a legitimate remainder.
    expect(psArgvFromCommand(
      '/Applications/wmux 2.app/Contents/MacOS/wmux --max-old-space-size=4096 /a/b.js',
      '/Applications/wmux 2.app/Contents/MacOS/wmux',
    )).toEqual([
      '/Applications/wmux 2.app/Contents/MacOS/wmux', '--max-old-space-size=4096', '/a/b.js',
    ]);
    expect(psArgvFromCommand('/Applications/wmux 2.app/Contents/MacOS/wmux', '/Applications/wmux 2.app/Contents/MacOS/wmux'))
      .toEqual(['/Applications/wmux 2.app/Contents/MacOS/wmux']);
  });

  it('no entry script (flags only, or bare executable) never matches', () => {
    expect(argvIdentifiesDaemonScript(['/usr/bin/node', '--version'], ['/x/index.js'])).toBe(false);
    expect(argvIdentifiesDaemonScript(['/usr/bin/node'], ['/x/index.js'])).toBe(false);
    expect(argvIdentifiesDaemonScript([], ['/x/index.js'])).toBe(false);
  });

  it.runIf(process.platform === 'win32')('win32: backslashes and case fold for comparison', () => {
    expect(argvIdentifiesDaemonScript(
      ['C:\\wmux\\wmux.exe', 'C:\\Wmux\\Resources\\Daemon-Bundle\\Index.js'],
      ['c:/wmux/resources/daemon-bundle/index.js'],
    )).toBe(true);
  });
});

describe('killVerifiedDaemonPid — execution (#1025/#1028)', () => {
  let tmpDir = '';
  let child: ChildProcess | null = null;

  afterEach(async () => {
    if (child && child.pid && child.exitCode === null) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
      await new Promise<void>((resolve) => {
        if (!child) return resolve();
        child.once('exit', () => resolve());
        setTimeout(resolve, 2000);
      });
    }
    child = null;
    if (tmpDir) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
      }
      tmpDir = '';
    }
  });

  async function spawnSleeper(scriptPath: string, extraArgs: string[] = []): Promise<number> {
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, 'setTimeout(() => {}, 30000);\n');
    child = spawn(process.execPath, [scriptPath, ...extraArgs], { stdio: 'ignore' });
    expect(child.pid).toBeTruthy();
    // Let the OS register the PID before tasklist/ps is asked about it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    return child.pid as number;
  }

  function isAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  /**
   * Re-import the module with ONLY the win32 argv probe stubbed, so a refusal
   * case can stay in the `definitiveOnly: false` mode that `killDaemonByPidFile`
   * actually uses and still be deterministic.
   *
   * #1274: on win32 `getProcessArgv` shells out to PowerShell + Get-CimInstance
   * with a 5 s timeout and returns null on failure, and a null cmdline under
   * `definitiveOnly: false` is DOCUMENTED to proceed to SIGKILL — so on a loaded
   * runner these tests killed their own sleeper. Asserting them under
   * `definitiveOnly: true` instead would make them tautologies on exactly the
   * platform that flaked: production returns false on ANY indeterminate probe
   * before `argvIdentifiesDaemonScript` is ever called, so the #1025
   * entry-position guard would no longer be exercised there. Replacing just the
   * CIM call with the sleeper's real command line keeps the matcher in the loop
   * on every platform. Every other `execFileSync` call — the tasklist / `ps`
   * image lookup included — passes through to the real implementation, and on
   * macOS/Linux the argv probe is untouched (it is fast and never flaked).
   */
  async function importWithStubbedWin32Cmdline(argv: string[]) {
    vi.resetModules();
    vi.doMock('child_process', async () => {
      const actual = await vi.importActual<typeof import('child_process')>('child_process');
      const execFileSync = ((file: unknown, args?: unknown, opts?: unknown) => {
        const isCimProbe = Array.isArray(args)
          && args.some((a) => typeof a === 'string' && a.includes('Get-CimInstance Win32_Process'));
        // The CIM string quotes arguments carrying spaces; production
        // re-tokenizes it quote-aware, so quote every part.
        if (isCimProbe) return argv.map((part) => `"${part}"`).join(' ');
        return (actual.execFileSync as (...rest: unknown[]) => unknown)(file, args, opts);
      }) as typeof actual.execFileSync;
      return { ...actual, default: { ...actual, execFileSync }, execFileSync };
    });
    return import('../daemonLauncherCore');
  }

  function undoModuleStubs(): void {
    vi.doUnmock('child_process');
    vi.doUnmock('fs');
    vi.resetModules();
  }

  // #1274: stays in `definitiveOnly: false` — the mode `killDaemonByPidFile`
  // uses — with the win32 CIM probe stubbed to the sleeper's real command line
  // (see importWithStubbedWin32Cmdline). The argv gate is therefore the only
  // thing refusing the kill on every platform, instead of the probe's latency
  // deciding the outcome.
  it('refuses an unrelated process whose argv merely ends in daemon/index.js (the #1025 repro)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-identity-innocent-'));
    // Somebody else's program, using the same everyday layout. The image
    // matches too (both plain node), so the argv gate is the ONLY thing
    // standing between this process and a SIGKILL.
    const scriptPath = path.join(tmpDir, 'someone-elses-app', 'daemon', 'index.js');
    const pid = await spawnSleeper(scriptPath);

    try {
      const stubbed = await importWithStubbedWin32Cmdline([process.execPath, scriptPath]);
      expect(stubbed.killVerifiedDaemonPid(pid, { definitiveOnly: false })).toBe(false);
      expect(stubbed.killVerifiedDaemonPid(pid, {
        definitiveOnly: false,
        scriptCandidates: [path.join(tmpDir, 'unrelated', 'daemon-bundle', 'index.js')],
      })).toBe(false);
      expect(isAlive(pid)).toBe(true);
    } finally {
      undoModuleStubs();
    }
    // 15 s: two kill attempts, each paying the real win32 tasklist image
    // lookup (3 s worst case). The 5 s cmdline probe is stubbed out, so the
    // old 5 s default was only ever missed by the image lookup plus spawn.
  }, 15_000);

  // #1274: the other half of the split — the documented indeterminate branch.
  // When the argv probe cannot resolve and the caller is in the before-quit
  // mode (`definitiveOnly: false`, what `killDaemonByPidFile` uses), a null
  // cmdline next to a non-mismatching image is INTENDED to proceed to
  // SIGKILL. The probe is stubbed (execFileSync throws, /proc reads throw) so
  // the assertion never waits on the real 5 s WMI timeout.
  it('proceeds to SIGKILL when the argv probe cannot resolve and definitiveOnly is false', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-identity-indeterminate-'));
    const pid = await spawnSleeper(path.join(tmpDir, 'someone-elses-app', 'daemon', 'index.js'));

    vi.resetModules();
    // Kill every OS probe the module can use to read an image or a cmdline:
    // `execFileSync` covers win32 (tasklist / PowerShell) and macOS (`ps`),
    // and the /proc guard covers Linux. Everything else passes through, so
    // the real `process.kill` still does the killing.
    vi.doMock('child_process', async () => {
      const actual = await vi.importActual<typeof import('child_process')>('child_process');
      const execFileSync = () => { throw new Error('stubbed probe failure (#1274)'); };
      return { ...actual, default: { ...actual, execFileSync }, execFileSync };
    });
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      const readFileSync = ((file: unknown, ...rest: unknown[]) => {
        if (typeof file === 'string' && file.startsWith('/proc/')) {
          throw new Error('stubbed /proc failure (#1274)');
        }
        return (actual.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
      }) as typeof actual.readFileSync;
      return { ...actual, default: { ...actual, readFileSync }, readFileSync };
    });

    let survivorPid = 0;
    try {
      const stubbed = await import('../daemonLauncherCore');
      expect(stubbed.killVerifiedDaemonPid(pid, { definitiveOnly: false })).toBe(true);
      // ...and the same indeterminate reading REFUSES under definitiveOnly.
      survivorPid = await spawnSleeper(path.join(tmpDir, 'second', 'daemon', 'index.js'));
      expect(stubbed.killVerifiedDaemonPid(survivorPid, { definitiveOnly: true })).toBe(false);
      expect(isAlive(survivorPid)).toBe(true);
    } finally {
      // afterEach only tracks the LAST spawned child, and a failed expect
      // above would skip the survivor spawn entirely — reap both by hand so a
      // red run cannot orphan 30 s sleepers on the runner.
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      if (survivorPid) { try { process.kill(survivorPid, 'SIGKILL'); } catch { /* already gone */ } }
      undoModuleStubs();
    }
  }, 15_000);

  it('requirement 1, executed: our script path as a trailing ARGUMENT does not verify the process', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-identity-arg-'));
    const bundlePath = path.join(tmpDir, 'daemon-bundle', 'index.js');
    // The running entry script is unrelated; the daemon-bundle path rides
    // along as a plain argument (an editor, a build tool, a log grepper).
    const pid = await spawnSleeper(path.join(tmpDir, 'unrelated-entry.js'), [bundlePath]);

    // #1274: a refusal assertion, so the win32 cmdline probe is stubbed to
    // this sleeper's real argv (entry script first, bundlePath as a trailing
    // argument) and the mode stays `definitiveOnly: false` — the
    // entry-position guard is what must refuse here, not probe latency.
    try {
      const stubbed = await importWithStubbedWin32Cmdline([
        process.execPath, path.join(tmpDir, 'unrelated-entry.js'), bundlePath,
      ]);
      expect(stubbed.killVerifiedDaemonPid(pid, {
        definitiveOnly: false,
        scriptCandidates: [bundlePath],
      })).toBe(false);
      expect(isAlive(pid)).toBe(true);
    } finally {
      undoModuleStubs();
    }
    // 15 s: one kill attempt at the real win32 tasklist worst case (3 s).
  }, 15_000);

  it('kills a process running exactly one of the supplied candidate scripts', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-identity-ours-'));
    // An everyday layout that the fallback shape does NOT accept — only the
    // candidate identity can clear it, which is the point.
    const scriptPath = path.join(tmpDir, 'dist', 'daemon', 'index.js');
    const pid = await spawnSleeper(scriptPath);

    expect(killVerifiedDaemonPid(pid, {
      definitiveOnly: false,
      scriptCandidates: [path.join(tmpDir, 'dist', 'daemon-bundle', 'index.js'), scriptPath],
    })).toBe(true);
  }, 15_000);

  it('requirement 3, executed: daemon-bundler/index.js is refused, daemon-bundle/index.js is killed', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-identity-shape-'));
    const bundlerScript = path.join(tmpDir, 'daemon-bundler', 'index.js');
    const bundlerPid = await spawnSleeper(bundlerScript);
    // #1274: the refusal half runs with the win32 cmdline probe stubbed to
    // this sleeper's real argv, so the near-miss path shape ("daemon-bundler"
    // vs "daemon-bundle") is what refuses — in the same
    // `definitiveOnly: false` mode the kill half below uses.
    try {
      const stubbed = await importWithStubbedWin32Cmdline([process.execPath, bundlerScript]);
      expect(stubbed.killVerifiedDaemonPid(bundlerPid, { definitiveOnly: false })).toBe(false);
      expect(isAlive(bundlerPid)).toBe(true);
    } finally {
      undoModuleStubs();
    }
    try { process.kill(bundlerPid, 'SIGKILL'); } catch { /* cleanup */ }

    // The kill half keeps the real probe: it must pass the matcher on a real
    // cmdline read, which is the other half of the #1028 guarantee.
    const exactPid = await spawnSleeper(path.join(tmpDir, 'daemon-bundle', 'index.js'));
    expect(killVerifiedDaemonPid(exactPid, { definitiveOnly: false })).toBe(true);
    // 30 s: two spawns plus the kill half's real win32 tasklist (3 s) + WMI
    // cmdline (5 s) worst case (#1274).
  }, 30_000);
});

describe('ensureDaemon — cmdline-mismatch branch refuses instead of cleaning (#1028 requirement 4)', () => {
  let wmuxDir: string;
  let prevSuffix: string | undefined;
  let suffix: string;
  let tmpDir = '';
  let child: ChildProcess | null = null;

  beforeEach(() => {
    // Same isolation as daemonLauncherCore.deps.test.ts: a per-run
    // WMUX_DATA_SUFFIX keeps this away from the real ~/.wmux and any live
    // daemon on the test box.
    suffix = `-identity-redo-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    prevSuffix = process.env.WMUX_DATA_SUFFIX;
    process.env.WMUX_DATA_SUFFIX = suffix;
    wmuxDir = path.join(os.homedir(), `.wmux${suffix}`);
    fs.mkdirSync(wmuxDir, { recursive: true });
  });

  afterEach(async () => {
    if (prevSuffix === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = prevSuffix;
    if (child && child.pid && child.exitCode === null) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
      await new Promise<void>((resolve) => {
        if (!child) return resolve();
        child.once('exit', () => resolve());
        setTimeout(resolve, 2000);
      });
    }
    child = null;
    fs.rmSync(wmuxDir, { recursive: true, force: true });
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  /** A live process whose image matches this test runner (plain node) but
   *  whose argv does not identify the daemon script — the exact ambiguity
   *  the (b) branch must no longer resolve by cleaning + spawning. */
  async function occupyPidFile(): Promise<number> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-identity-ensure-'));
    const scriptPath = path.join(tmpDir, 'innocent-app', 'daemon', 'index.js');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, 'setTimeout(() => {}, 30000);\n');
    child = spawn(process.execPath, [scriptPath], { stdio: 'ignore' });
    expect(child.pid).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.writeFileSync(path.join(wmuxDir, 'daemon.pid'), String(child.pid));
    return child.pid as number;
  }

  function deps(overrides: Partial<DaemonLauncherDeps>): DaemonLauncherDeps {
    return {
      // REAL wiring under test (#1027's test flaw): the matcher receives
      // these through deps inside ensureDaemon, not through hand-injected
      // opts on the kill helper.
      resolveDaemonScriptCandidates: () => [path.join(wmuxDir, 'nonexistent', 'daemon-bundle', 'index.js')],
      resolveSpawnedByVersion: () => '9.9.9-test',
      askUserToRecoverFromStalePid: async () => false,
      isElectronHost: () => false,
      ...overrides,
    };
  }

  it('refuses by default: throws, kills nothing, deletes no state files', async () => {
    const pid = await occupyPidFile();
    const asked: string[] = [];

    await expect(ensureDaemon(deps({
      askUserToRecoverFromStalePid: async (opts) => { asked.push(opts.reason); return false; },
    }))).rejects.toThrow(/does not identify the wmux daemon script/);

    // The user was consulted (with the mismatch reason), the innocent
    // process survived, and daemon.pid was NOT cleaned — nothing was
    // spawned over a possibly-live daemon.
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain('does not identify the wmux daemon script');
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(true);
    expect(fs.existsSync(path.join(wmuxDir, 'daemon.pid'))).toBe(true);
  }, 15_000);

  it('proceeds to cleanup + spawn ONLY on explicit user approval', async () => {
    const pid = await occupyPidFile();

    // Approval falls through to the stale-file cleanup + spawn; the spawn
    // then fails on the nonexistent candidate list, which is exactly the
    // proof that the flow moved PAST the refusal into the (approved)
    // clean-and-spawn path — without ever killing the occupant.
    await expect(ensureDaemon(deps({
      askUserToRecoverFromStalePid: async () => true,
    }))).rejects.toThrow(/Daemon script not found/);

    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(true);
  }, 15_000);
});
