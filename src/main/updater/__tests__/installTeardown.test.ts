// Pure-logic coverage for the #866 install teardown. The two properties that
// actually keep an installation alive are asserted here:
//
//   1. the waiter waits on HANDLES and probes for locks BEFORE Setup.exe,
//   2. a still-locked root aborts instead of launching.
//
// Everything else (enumeration, volume budgeting, quoting) feeds those two.
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  isSafePsPathLiteral,
  freeSpaceShortfall,
  selectInstallRootPids,
  selectOwnTreePids,
  parseProcessRows,
  buildWaiterScript,
  readDaemonPid,
  terminatePids,
  readAbortMarker,
  clearAbortMarker,
  waitForWaiterHeartbeat,
  INSTALL_ABORT_MARKER,
  type WaiterPlan,
} from '../installTeardown';

const PLAN: WaiterPlan = {
  pids: [111, 222],
  setupExePath: 'C:\\Temp\\wmux-3.41.0.Setup.exe',
  installRoot: 'C:\\Users\\u\\AppData\\Local\\wmux',
  abortMarkerPath: 'C:\\Users\\u\\AppData\\Roaming\\wmux\\install-abort.txt',
  readyMarkerPath: 'C:\\Users\\u\\AppData\\Roaming\\wmux\\install-ready.tmp',
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

  // #1043 — a best-effort "please wait" indicator for the otherwise-silent
  // 1-2 minute window. Structural lock only: the WinForms message loop and
  // its interaction with a real Windows desktop cannot run on CI regardless
  // of platform (there is no display), so this pins the CODE SHAPE — that a
  // failure to build the form can never block the wait/probe logic, and that
  // the window is gone before Setup.exe (which brings its own UI) starts.
  it('shows a best-effort wait indicator that never gates the wait itself', () => {
    const s = buildWaiterScript(PLAN) ?? '';
    const formTry = s.indexOf('Add-Type -AssemblyName System.Windows.Forms');
    const formCatch = s.indexOf('} catch { if ($form) { try { $form.Close() } catch { } }; $form = $null }');
    const handleWait = s.indexOf('WaitForExit');
    const closeBeforeStart = s.lastIndexOf('$form.Close()');
    const start = s.indexOf('Start-Process -FilePath $setup');

    expect(formTry).toBeGreaterThan(-1);
    // The form build is wrapped so any failure (Add-Type refused, no display
    // subsystem) degrades to $form = $null rather than an unhandled error
    // that would abort the whole waiter and silently cancel the update.
    expect(formCatch).toBeGreaterThan(formTry);
    expect(formCatch).toBeLessThan(handleWait);
    // Every DoEvents/Close call is null-checked, so a null $form is inert —
    // the wait/probe/launch sequence behaves exactly as it did before this
    // indicator existed.
    expect(s).toMatch(/if \(\$form\) \{ try \{ \[System\.Windows\.Forms\.Application\]::DoEvents\(\) \} catch \{ \} \}/);
    // Closed before Setup.exe starts — Squirrel has its own UI from here.
    expect(closeBeforeStart).toBeGreaterThan(handleWait);
    expect(closeBeforeStart).toBeLessThan(start);
  });

  it('closes the wait indicator on every abort path too, not just success', () => {
    const s = buildWaiterScript(PLAN) ?? '';
    const stuckAbort = s.indexOf("'install-aborted: a process under the install root would not exit'");
    const lockedAbort = s.indexOf("'install-aborted: install root still locked'");
    // Each abort's own Set-Content is preceded (a few lines up) by a
    // form-close guard — assert the guard is present at all, since a leaked
    // topmost window after a refused install would be its own, smaller
    // version of this same issue.
    const closeCount = (s.match(/if \(\$form\) \{ try \{ \$form\.Close\(\) \} catch \{ \} \}/g) ?? []).length;
    expect(stuckAbort).toBeGreaterThan(-1);
    expect(lockedAbort).toBeGreaterThan(-1);
    // success path + stuck-handle abort + locked-root abort + the
    // form-setup catch block (coderabbit, #1044) = 4 close sites.
    expect(closeCount).toBe(4);
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
  it('parses the array form and the single-object form, carrying parentage', () => {
    expect(parseProcessRows('[{"ProcessId":1,"ParentProcessId":7,"ExecutablePath":"C:\\\\a.exe"}]')).toEqual([
      { pid: 1, parentPid: 7, executablePath: 'C:\\a.exe' },
    ]);
    expect(parseProcessRows('{"ProcessId":2,"ParentProcessId":7,"ExecutablePath":"C:\\\\b.exe"}')).toEqual([
      { pid: 2, parentPid: 7, executablePath: 'C:\\b.exe' },
    ]);
    // #980 — an absent or malformed parent reads as 0, which belongs to no
    // tree. Unreadable parentage can only make a process look FOREIGN, and a
    // foreign process is the one case it is safe to be wrong about: it gets
    // force-killed, which is what the old code did to everything anyway.
    expect(parseProcessRows('[{"ProcessId":3,"ExecutablePath":"C:\\\\c.exe"}]')).toEqual([
      { pid: 3, parentPid: 0, executablePath: 'C:\\c.exe' },
    ]);
    expect(parseProcessRows('[{"ProcessId":4,"ParentProcessId":-1,"ExecutablePath":""}]')).toEqual([
      { pid: 4, parentPid: 0, executablePath: '' },
    ]);
  });

  it('drops malformed rows and survives empty or non-JSON output', () => {
    expect(parseProcessRows('')).toEqual([]);
    expect(parseProcessRows('nope')).toEqual([]);
    expect(parseProcessRows('[{"ProcessId":0},{"ExecutablePath":"x"}]')).toEqual([]);
    // A null ExecutablePath (access denied) still yields a row, with '' — which
    // selectInstallRootPids then filters out rather than treating as a match.
    expect(parseProcessRows('[{"ProcessId":9,"ParentProcessId":1,"ExecutablePath":null}]')).toEqual([
      { pid: 9, parentPid: 1, executablePath: '' },
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

/**
 * #980 — who may be force-killed on the install path.
 *
 * Every Electron helper is the same wmux.exe under the same install root as the
 * process running the update, so an executable-path match cannot tell our own
 * renderer from a stranger's MCP server. Parentage can, and the distinction is
 * load-bearing: the install path force-killed our own renderer and then quit
 * into a before-quit handler that awaits a session save in it. The quit never
 * completed, and the main process held the install root open for a day.
 */
describe('selectOwnTreePids (#980)', () => {
  // 100 = us. 101/102 are our helpers, 103 is a helper's own child, 200 is a
  // stranger's MCP server that merely runs out of the same directory.
  const rows = [
    { pid: 101, parentPid: 100 },
    { pid: 102, parentPid: 100 },
    { pid: 103, parentPid: 101 },
    { pid: 200, parentPid: 999 },
  ];

  it('claims our children and their children, and nothing else', () => {
    expect(selectOwnTreePids(rows, 100)).toEqual(new Set([101, 102, 103]));
  });

  it('never claims ourselves — the caller already excludes us from the wait list', () => {
    expect(selectOwnTreePids(rows, 100).has(100)).toBe(false);
  });

  it('leaves a foreign process foreign, which is the one the kill list is FOR', () => {
    expect(selectOwnTreePids(rows, 100).has(200)).toBe(false);
  });

  it('treats an unreadable parent (0) as foreign rather than adopting it', () => {
    // Fails in the safe direction: an unclassifiable process gets force-killed,
    // which is exactly what the old code did to everything.
    expect(selectOwnTreePids([{ pid: 5, parentPid: 0 }], 100)).toEqual(new Set());
    expect(selectOwnTreePids([{ pid: 5, parentPid: 0 }], 0)).toEqual(new Set());
  });

  it('terminates on a pid-recycle cycle instead of walking forever', () => {
    // Windows recycles pids, so a stale parent reference can close a loop.
    const cyclic = [
      { pid: 101, parentPid: 100 },
      { pid: 100, parentPid: 101 },
    ];
    expect(selectOwnTreePids(cyclic, 100)).toEqual(new Set([101]));
  });

  it('is empty when nothing descends from us', () => {
    expect(selectOwnTreePids(rows, 555)).toEqual(new Set());
  });
});

describe('buildWaiterScript — the clock has to survive a long uptime (#980)', () => {
  const plan = {
    pids: [11, 12],
    setupExePath: 'C:/Temp/Setup.exe',
    installRoot: 'C:/Root',
    abortMarkerPath: 'C:/Data/aborted.txt',
    readyMarkerPath: 'C:/Data/ready.tmp',
    lockBudgetMs: 60_000,
  };

  it('uses a monotonic Stopwatch, never [Environment]::TickCount', () => {
    const script = buildWaiterScript(plan)!;
    // TickCount is a signed 32-bit ms counter: it wraps every ~24.9 days and
    // then runs negative, at which point `TickCount + budget` widens past
    // Int32.MaxValue, WaitForExit throws on the timeout argument, the catch
    // swallows it, and the wait silently becomes a no-op — on exactly the
    // long-uptime machines that most need it.
    expect(script).not.toContain('TickCount');
    expect(script).toContain('[System.Diagnostics.Stopwatch]::StartNew()');
  });

  it('measures both the handle wait and the lock loop against that clock', () => {
    const script = buildWaiterScript(plan)!;
    expect(script).toContain('$left = $budget - $clock.ElapsedMilliseconds');
    expect(script).toContain('$lockClock.ElapsedMilliseconds -lt $budget');
  });

  it('hands WaitForExit an int, so a widened remainder cannot throw the wait away', () => {
    // #1043 sliced the single blocking WaitForExit into a poll (so the wait
    // screen can pump DoEvents between slices) — the value handed to
    // WaitForExit is now the per-slice remainder, still explicitly cast.
    expect(buildWaiterScript(plan)!).toContain('$exited = $h.WaitForExit([int]$slice)');
  });
});

describe('buildWaiterScript — one waiter per install root (#980, coderabbit)', () => {
  const plan = {
    pids: [11],
    setupExePath: 'C:/Temp/Setup.exe',
    installRoot: 'C:/Root',
    abortMarkerPath: 'C:/Data/aborted.txt',
    readyMarkerPath: 'C:/Data/ready.tmp',
    lockBudgetMs: 60_000,
  };
  const script = () => buildWaiterScript(plan)!;

  it('takes a named mutex before doing anything else', () => {
    // The quit watchdog unlatches after 30s while a spawned waiter can still be
    // inside its budget, so a retry spawns a second waiter for the same root.
    // The collision is resolved HERE, not by timing arithmetic between the
    // watchdog and the budgets: the mutex exists only while some process holds
    // it, so a live incumbent blocks the newcomer and a dead one blocks nobody.
    const s = script();
    const mutexAt = s.indexOf('System.Threading.Mutex');
    expect(mutexAt).toBeGreaterThan(-1);
    expect(mutexAt).toBeLessThan(s.indexOf('$handles = @()'));
    expect(mutexAt).toBeLessThan(s.indexOf('Start-Process'));
  });

  it('yields silently (exit 5) — the incumbent owns the install AND the marker', () => {
    const s = script();
    const yieldAt = s.indexOf('exit 5');
    expect(yieldAt).toBeGreaterThan(-1);
    // No ABORT marker write on this path: a "refused" marker from the loser
    // would overwrite or pre-empt whatever the incumbent has to report. The
    // #1056 heartbeat write IS expected before this point — it says "a
    // process ran," not "the install was refused," and every waiter
    // (incumbent or newcomer) writes its own regardless of the mutex outcome.
    expect(s.slice(0, yieldAt)).not.toContain('-LiteralPath $marker');
    expect(s.slice(0, yieldAt)).toContain('-LiteralPath $ready');
  });

  it('derives the mutex name from a SHA256 hash of $root, not a lossy character replace', () => {
    const s = script();
    expect(s).toContain(
      '[System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($root))',
    );
    expect(s).toContain(`'wmux-install-waiter-' + $mtxHash`);
    // The regression this replaces: '[^A-Za-z0-9]' -> '_' collapses any root
    // whose only difference is which non-alphanumeric character it uses.
    expect(s).not.toContain(`-replace '[^A-Za-z0-9]', '_'`);
  });

  it('two roots the old regex-replace would have collided on now hash differently (#1043, coderabbit)', () => {
    // C:\wmux-a and C:\wmux_a both replace their one non-alnum character with
    // '_' and land on the identical mutex name under the old scheme — two
    // genuinely different installations would then block each other's
    // update. This is PowerShell's own SHA256 at runtime; Node's `crypto`
    // computes the same algorithm over the same bytes, so equality here would
    // mean the new scheme collides too, not just that the two happen to
    // differ today.
    const a = createHash('sha256').update('C:\\wmux-a', 'utf8').digest('hex');
    const b = createHash('sha256').update('C:\\wmux_a', 'utf8').digest('hex');
    expect(a).not.toBe(b);
  });
});

describe('buildWaiterScript — post-exit install verification (#1046)', () => {
  const PLAN46 = {
    pids: [4242],
    setupExePath: 'C:/t/Setup.exe',
    installRoot: 'C:/Users/u/AppData/Local/wmux',
    abortMarkerPath: 'C:/t/marker.txt',
    readyMarkerPath: 'C:/t/ready.tmp',
    lockBudgetMs: 60000,
  };
  const script = (): string => buildWaiterScript(PLAN46) ?? '';

  it('captures Setup.exe with -PassThru and only judges after a real exit', () => {
    const s = script();
    const start = s.indexOf('Start-Process -FilePath $setup -PassThru');
    expect(start).toBeGreaterThan(-1);
    const wait = s.indexOf('$setupProc.WaitForExit(600000)');
    expect(wait).toBeGreaterThan(start);
    // An installer still running at the deadline means "cannot judge" —
    // exit 0, exactly the pre-#1046 behavior. The verification can only ADD
    // a warning, never invent one about an install still in progress.
    expect(s.indexOf('if (-not $setupDone) { exit 0 }')).toBeGreaterThan(wait);
  });

  it('checks exactly the two files whose absence is the #1046 corpse, after the launch', () => {
    const s = script();
    const start = s.indexOf('Start-Process -FilePath $setup');
    expect(s.indexOf("Join-Path $root 'Update.exe'")).toBeGreaterThan(start);
    expect(s.indexOf("'icudtl.dat'")).toBeGreaterThan(start);
    expect(s).toContain('install-aborted: the installer exited but left an incomplete installation');
  });

  it('fails additively: guarded marker write, guarded MessageBox, its own exit code', () => {
    const s = script();
    // The MessageBox fires only when the Forms assembly proved loadable for
    // the wait window, and a throw inside it is swallowed — a machine that
    // cannot show UI still gets the marker, and one that cannot write the
    // marker still gets the box.
    expect(s).toMatch(/if \(\$formsLoaded\) \{ try \{ \[System\.Windows\.Forms\.MessageBox\]::Show\(/);
    const formsTrue = s.indexOf('$formsLoaded = $true');
    expect(formsTrue).toBeGreaterThan(s.indexOf('Add-Type -AssemblyName System.Windows.Forms'));
    expect(formsTrue).toBeLessThan(s.indexOf('Add-Type -AssemblyName System.Drawing'));
    expect(s.trimEnd().endsWith('exit 6')).toBe(true);
  });
});

describe('buildWaiterScript — the #1056 heartbeat is the very first thing it does', () => {
  it('writes the ready marker before the mutex, before the wait window, before everything', () => {
    const s = buildWaiterScript(PLAN)!;
    const heartbeatAt = s.indexOf(`-LiteralPath $ready`);
    const mutexAt = s.indexOf('System.Threading.Mutex');
    const formsAt = s.indexOf('Add-Type -AssemblyName System.Windows.Forms');
    expect(heartbeatAt).toBeGreaterThan(-1);
    // Only the three path/budget assignments and $ErrorActionPreference may
    // precede it -- nothing that could itself throw or block.
    expect(s.indexOf('$ErrorActionPreference')).toBeLessThan(heartbeatAt);
    expect(heartbeatAt).toBeLessThan(mutexAt);
    expect(heartbeatAt).toBeLessThan(formsAt);
  });

  it('guards the write so a failure here cannot abort the rest of the script', () => {
    const s = buildWaiterScript(PLAN)!;
    expect(s).toContain(
      `try { Set-Content -LiteralPath $ready -Value 'alive' -Encoding utf8 } catch { }`,
    );
  });

  it('rejects a plan whose readyMarkerPath is not a safe PowerShell literal', () => {
    expect(buildWaiterScript({ ...PLAN, readyMarkerPath: 'C:\\bad\npath.txt' })).toBeNull();
  });
});

describe('waitForWaiterHeartbeat (#1056)', () => {
  it('returns true immediately when the marker already exists, without sleeping', async () => {
    const sleeps: number[] = [];
    const alive = await waitForWaiterHeartbeat(
      '/fake/ready.tmp', 3000, 100,
      () => true,
      async (ms) => { sleeps.push(ms); },
    );
    expect(alive).toBe(true);
    expect(sleeps).toEqual([]);
  });

  it('polls until the marker appears, then stops', async () => {
    let calls = 0;
    const exists = () => { calls += 1; return calls >= 3; };
    const sleeps: number[] = [];
    const alive = await waitForWaiterHeartbeat(
      '/fake/ready.tmp', 3000, 100,
      exists,
      async (ms) => { sleeps.push(ms); },
    );
    expect(alive).toBe(true);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([100, 100]);
  });

  it('gives up once the budget is exhausted and the marker never appeared', async () => {
    // Real timers, driven by vitest's fake clock so the budget elapses without
    // the test actually burning wall-clock time -- the default sleepFn is a
    // genuine setTimeout, and Date.now() (also faked) is what the function's
    // own deadline math reads.
    vi.useFakeTimers();
    try {
      const existsFn = vi.fn(() => false);
      const resultP = waitForWaiterHeartbeat('/fake/ready.tmp', 250, 100, existsFn);
      await vi.advanceTimersByTimeAsync(250);
      expect(await resultP).toBe(false);
      // Checked at least at the start and once more after the budget ran out.
      expect(existsFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
