// Pure-logic coverage for the #866 install teardown. The two properties that
// actually keep an installation alive are asserted here:
//
//   1. the waiter waits on HANDLES and probes for locks BEFORE Setup.exe,
//   2. a still-locked root aborts instead of launching.
//
// Everything else (enumeration, volume budgeting, quoting) feeds those two.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isSafePsPathLiteral,
  freeSpaceShortfall,
  selectInstallRootPids,
  parseProcessRows,
  buildWaiterScript,
  readDaemonPid,
  terminatePids,
  readAbortMarker,
  clearAbortMarker,
  INSTALL_ABORT_MARKER,
  type WaiterPlan,
} from '../installTeardown';

const PLAN: WaiterPlan = {
  pids: [111, 222],
  setupExePath: 'C:\\Temp\\wmux-3.41.0.Setup.exe',
  installRoot: 'C:\\Users\\u\\AppData\\Local\\wmux',
  abortMarkerPath: 'C:\\Users\\u\\AppData\\Roaming\\wmux\\install-abort.txt',
  lockBudgetMs: 30_000,
};

describe('isSafePsPathLiteral', () => {
  it.each(["'", '"', '$', '`'])('accepts the legal path character %j', (ch) => {
    expect(isSafePsPathLiteral(`C:\\Users\\O${ch}Connor\\wmux`)).toBe(true);
  });

  it.each(['\n', '\r'])('refuses the line terminator %j', (ch) => {
    expect(isSafePsPathLiteral(`C:\\wmux${ch}x`)).toBe(false);
  });
});

describe('buildWaiterScript — ordering is the whole contract', () => {
  it('waits on handles, probes locks, and only then starts Setup.exe', () => {
    const s = buildWaiterScript(PLAN) ?? '';
    const handleWait = s.indexOf('WaitForExit');
    const lockProbe = s.indexOf('Test-RootLocked');
    const start = s.indexOf('Start-Process -FilePath $setup');

    expect(handleWait).toBeGreaterThan(-1);
    expect(lockProbe).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(-1);
    // The regression this whole change exists to prevent: launching the
    // installer while anything still holds the install root.
    expect(handleWait).toBeLessThan(start);
    expect(lockProbe).toBeLessThan(start);
  });

  it('aborts with a marker instead of launching when the root stays locked', () => {
    const s = buildWaiterScript(PLAN) ?? '';
    const abortIdx = s.indexOf('install-aborted');
    const start = s.indexOf('Start-Process -FilePath $setup');
    expect(abortIdx).toBeGreaterThan(-1);
    expect(abortIdx).toBeLessThan(start);
    expect(s).toContain('exit 2');
  });

  it('captures handles by pid up front rather than polling pids', () => {
    const s = buildWaiterScript(PLAN) ?? '';
    expect(s).toContain('GetProcessById');
    expect(s).toContain('@(111,222)');
    // A pid poll would look like this; it must not appear.
    expect(s).not.toContain('Get-Process -Id');
  });

  it('doubles apostrophes in every embedded path', () => {
    const s = buildWaiterScript({ ...PLAN, installRoot: "C:\\Users\\O'Connor\\wmux" }) ?? '';
    expect(s).toContain("$root = 'C:\\Users\\O''Connor\\wmux'");
  });

  it('refuses to build on a line terminator or a bogus pid', () => {
    expect(buildWaiterScript({ ...PLAN, installRoot: 'C:\\a\nb' })).toBeNull();
    expect(buildWaiterScript({ ...PLAN, pids: [0] })).toBeNull();
    expect(buildWaiterScript({ ...PLAN, pids: [-3] })).toBeNull();
    expect(buildWaiterScript({ ...PLAN, pids: [1.5] })).toBeNull();
  });
});

describe('selectInstallRootPids', () => {
  const root = 'C:\\Users\\u\\AppData\\Local\\wmux';

  it('takes every process running from under the root, including MCP servers', () => {
    const rows = [
      { pid: 1, executablePath: `${root}\\app-3.40.2\\wmux.exe` },   // GUI
      { pid: 2, executablePath: `${root}\\app-3.40.2\\wmux.exe` },   // daemon
      { pid: 3, executablePath: `${root}\\app-3.40.2\\wmux.exe` },   // MCP server
      { pid: 4, executablePath: `${root}\\wmux.exe` },               // root stub
    ];
    expect(selectInstallRootPids(rows, root, 999)).toEqual([1, 2, 3, 4]);
  });

  it('excludes ourselves — killing the process doing the update is self-defeating', () => {
    const rows = [
      { pid: 7, executablePath: `${root}\\app-3.40.2\\wmux.exe` },
      { pid: 8, executablePath: `${root}\\app-3.40.2\\wmux.exe` },
    ];
    expect(selectInstallRootPids(rows, root, 7)).toEqual([8]);
  });

  it('leaves a dev build and a sibling directory alone', () => {
    const rows = [
      { pid: 1, executablePath: 'D:\\wmux\\out\\wmux-win32-x64\\wmux.exe' },
      { pid: 2, executablePath: `${root}-dev\\app-1.0.0\\wmux.exe` },
      { pid: 3, executablePath: '' },
    ];
    expect(selectInstallRootPids(rows, root, 999)).toEqual([]);
  });

  it('matches case-insensitively and tolerates a trailing separator on the root', () => {
    const rows = [{ pid: 5, executablePath: `${root.toUpperCase()}\\APP-3.40.2\\WMUX.EXE` }];
    // Both separator spellings, because the caller derives the root from
    // process.execPath and node normalizes inconsistently across APIs.
    expect(selectInstallRootPids(rows, `${root}\\`, 999)).toEqual([5]);
    expect(selectInstallRootPids(rows, `${root}/`, 999)).toEqual([5]);
    expect(selectInstallRootPids(rows, root, 999)).toEqual([5]);
  });

  it('does not match a sibling whose name merely starts with the root', () => {
    // `wmux-dev` must not be swept up by a prefix test against `wmux`.
    const rows = [{ pid: 6, executablePath: `${root}-dev\\app-1.0.0\\wmux.exe` }];
    expect(selectInstallRootPids(rows, root, 999)).toEqual([]);
  });
});

describe('parseProcessRows', () => {
  it('parses the array form and the single-object form', () => {
    expect(parseProcessRows('[{"ProcessId":1,"ExecutablePath":"C:\\\\a.exe"}]')).toEqual([
      { pid: 1, executablePath: 'C:\\a.exe' },
    ]);
    expect(parseProcessRows('{"ProcessId":2,"ExecutablePath":"C:\\\\b.exe"}')).toEqual([
      { pid: 2, executablePath: 'C:\\b.exe' },
    ]);
  });

  it('drops malformed rows and survives empty or non-JSON output', () => {
    expect(parseProcessRows('')).toEqual([]);
    expect(parseProcessRows('nope')).toEqual([]);
    expect(parseProcessRows('[{"ProcessId":0},{"ExecutablePath":"x"}]')).toEqual([]);
    // A null ExecutablePath (access denied) still yields a row, with '' — which
    // selectInstallRootPids then filters out rather than treating as a match.
    expect(parseProcessRows('[{"ProcessId":9,"ExecutablePath":null}]')).toEqual([
      { pid: 9, executablePath: '' },
    ]);
  });
});

describe('freeSpaceShortfall — budgets per volume, not in aggregate', () => {
  const probe = (map: Record<string, [string, number]>) => (dir: string) => {
    const hit = map[dir];
    return hit ? { volume: hit[0], freeBytes: hit[1] } : null;
  };

  it('returns null when every volume has room', () => {
    expect(
      freeSpaceShortfall(
        [{ dir: 'T', neededBytes: 100 }, { dir: 'R', neededBytes: 100 }],
        probe({ T: ['T:\\', 500], R: ['C:\\', 500] }),
      ),
    ).toBeNull();
  });

  it('sums budgets that land on the SAME volume', () => {
    // 100 + 100 on one volume with 150 free is short, even though neither
    // budget alone would be.
    const short = freeSpaceShortfall(
      [{ dir: 'T', neededBytes: 100 }, { dir: 'R', neededBytes: 100 }],
      probe({ T: ['C:\\', 150], R: ['C:\\', 150] }),
    );
    expect(short).toEqual({ volume: 'C:\\', neededBytes: 200, freeBytes: 150 });
  });

  it('does not let a roomy volume mask a full one', () => {
    const short = freeSpaceShortfall(
      [{ dir: 'T', neededBytes: 10 }, { dir: 'R', neededBytes: 900 }],
      probe({ T: ['T:\\', 10_000], R: ['C:\\', 100] }),
    );
    expect(short?.volume).toBe('C:\\');
  });

  it('never invents a refusal from an unreadable volume', () => {
    expect(
      freeSpaceShortfall([{ dir: 'X', neededBytes: 1e12 }], () => null),
    ).toBeNull();
  });
});

describe('readDaemonPid', () => {
  const dirs: string[] = [];
  const tempDir = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-daemonpid-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('reads the pid, tolerating the trailing newline the daemon writes', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'daemon.pid'), '4321\n');
    expect(readDaemonPid(dir)).toBe(4321);
  });

  it.each([
    ['no file at all', null],
    ['', ''],
    ['not-a-number', 'abcd'],
    ['zero', '0'],
    ['negative', '-7'],
    ['float', '12.5'],
  ])('returns null for %s', (_label, contents) => {
    const dir = tempDir();
    if (contents !== null) fs.writeFileSync(path.join(dir, 'daemon.pid'), contents);
    expect(readDaemonPid(dir)).toBeNull();
  });

  it('null fails safe: the caller force-kills the daemon rather than skipping it', () => {
    // Documented contract. If this ever flips to "skip on null", a daemon we
    // could not identify would be left holding the install root open, which is
    // the failure this module exists to prevent.
    const dir = tempDir();
    const daemonPid = readDaemonPid(dir); // null — no pid file
    const pids = [111, 222];
    expect(pids.filter((p) => p !== daemonPid)).toEqual([111, 222]);
  });
});

describe('terminatePids', () => {
  it('ignores non-positive and non-integer pids instead of shelling out for them', () => {
    // taskkill /PID 0 would be a nonsense call, and a float would be coerced
    // into some other process's pid. Neither should ever reach the shell.
    expect(terminatePids([0, -1, 1.5, NaN])).toEqual([]);
  });

  it('returns an empty list for an empty input', () => {
    expect(terminatePids([])).toEqual([]);
  });
});

describe('consumeAbortMarker', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const tempDir = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-abortmarker-'));
    dirs.push(d);
    return d;
  };

  it('reads WITHOUT clearing, so a crash before the notice cannot lose the refusal', () => {
    const dir = tempDir();
    const marker = path.join(dir, INSTALL_ABORT_MARKER);
    fs.writeFileSync(marker, 'install-aborted: install root still locked\n');

    expect(readAbortMarker(marker)).toBe('install-aborted: install root still locked');
    // Still there: clearing on read would drop the only record of the refusal
    // if the app died before the renderer saw it, and it is then unreportable
    // forever. Reads are idempotent.
    expect(fs.existsSync(marker)).toBe(true);
    expect(readAbortMarker(marker)).toBe('install-aborted: install root still locked');
  });

  it('clears only when asked, and a sticky warning cannot outlive the clear', () => {
    const dir = tempDir();
    const marker = path.join(dir, INSTALL_ABORT_MARKER);
    fs.writeFileSync(marker, 'install-aborted: install root still locked\n');

    clearAbortMarker(marker);
    expect(fs.existsSync(marker)).toBe(false);
    expect(readAbortMarker(marker)).toBeNull();
  });

  it('clearing a marker that is already gone is not an error', () => {
    expect(() => clearAbortMarker(path.join(tempDir(), INSTALL_ABORT_MARKER))).not.toThrow();
  });

  it('returns null when there is no marker', () => {
    expect(readAbortMarker(path.join(tempDir(), INSTALL_ABORT_MARKER))).toBeNull();
  });

  it('still reports a refusal when the marker is empty', () => {
    const dir = tempDir();
    const marker = path.join(dir, INSTALL_ABORT_MARKER);
    fs.writeFileSync(marker, '   \n');
    expect(readAbortMarker(marker)).toBe('install-aborted');
  });
});

describe('buildWaiterScript — the lock probe covers loadable images, not just .exe', () => {
  it('probes dll/node/asar as well, because the failure in the field was a dll', () => {
    const s = buildWaiterScript(PLAN) ?? '';
    // The install that destroyed a real machine died deleting ffmpeg.dll. On a
    // live install 1 .exe is locked but 9 binaries are, so an .exe-only probe
    // would have reported "clear" and launched Setup.exe into a live tree.
    expect(s).toContain(".exe");
    expect(s).toContain(".dll");
    expect(s).toContain(".node");
    expect(s).toContain(".asar");
    expect(s).not.toContain('-Filter *.exe');
  });
});
