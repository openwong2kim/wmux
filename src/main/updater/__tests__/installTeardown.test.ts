// Pure-logic coverage for the #866 install teardown. The two properties that
// actually keep an installation alive are asserted here:
//
//   1. the waiter waits on HANDLES and probes for locks BEFORE Setup.exe,
//   2. a still-locked root aborts instead of launching.
//
// Everything else (enumeration, volume budgeting, quoting) feeds those two.
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  isSafePsPathLiteral,
  freeSpaceShortfall,
  selectInstallRootPids,
  parseProcessRows,
  buildWaiterScript,
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
    expect(selectInstallRootPids(rows, root + path.sep, 999)).toEqual([5]);
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
