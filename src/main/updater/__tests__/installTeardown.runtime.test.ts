// End-to-end proof of the two properties that keep an installation alive
// (#866), against real processes, real file locks and the real waiter script:
//
//   1. the waiter does not start the installer while anything still holds the
//      install root open,
//   2. when the root never clears, it ABORTS and says so, instead of launching
//      into a live tree.
//
// The waiter runs in the FOREGROUND here (spawnSync) rather than detached. Same
// script, but the test observes an exit code instead of racing a background
// process against afterEach teardown — an earlier detached version of this file
// produced inverted, timing-dependent results that said nothing about the code.
// Exit codes are the contract: 0 = installer launched, 2 = refused,
// 5 = another waiter already owns this install root (#980).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  buildWaiterScript,
  spawnInstallWaiter,
  collectInstallRootPids,
  probeVolume,
  type WaiterPlan,
} from '../installTeardown';

const onWindows = process.platform === 'win32';
const PS = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
);

function q(p: string): string {
  return `'${p.replace(/'/g, "''")}'`;
}

describe.skipIf(!onWindows)('install waiter (real processes, real locks)', () => {
  let sandbox: string;
  let root: string;
  let heldExe: string;
  let setupStamp: string;
  let fakeSetup: string;
  let abortMarker: string;
  let readyMarker: string;
  let scriptPath: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-waiter-')));
    root = path.join(sandbox, 'wmux');
    fs.mkdirSync(path.join(root, 'app-1.0.0'), { recursive: true });
    heldExe = path.join(root, 'app-1.0.0', 'held.exe');
    fs.writeFileSync(heldExe, 'x');
    setupStamp = path.join(sandbox, 'setup-ran.txt');
    abortMarker = path.join(sandbox, 'abort.txt');
    readyMarker = path.join(sandbox, 'ready.tmp');
    fakeSetup = path.join(sandbox, 'fake-setup.cmd');
    // Stand-in for Setup.exe: proves it ran without installing anything.
    fs.writeFileSync(fakeSetup, `@echo off\r\necho ran > "${setupStamp}"\r\n`);
    scriptPath = path.join(sandbox, 'waiter.ps1');
  });

  afterEach(() => {
    for (const c of children.splice(0)) { try { c.kill(); } catch { /* already gone */ } }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* lock lingers */ }
  });

  /** Holds heldExe open until killed. Returns once the lock is actually taken. */
  function holdRoot(seconds = 120): ChildProcess {
    const child = spawn(
      PS,
      ['-NoProfile', '-NonInteractive', '-Command',
        `$s=[System.IO.File]::Open(${q(heldExe)},'Open','Read','None'); Start-Sleep -Seconds ${seconds}; $s.Close()`],
      { windowsHide: true, stdio: 'ignore' },
    );
    children.push(child);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try { const fd = fs.openSync(heldExe, 'r+'); fs.closeSync(fd); } catch { return child; }
      execFileSync(PS, ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 200'], { windowsHide: true });
    }
    throw new Error('holder never took the lock');
  }

  function writeWaiter(plan: WaiterPlan): void {
    const script = buildWaiterScript(plan);
    expect(script).not.toBeNull();
    fs.writeFileSync(scriptPath, script as string, 'utf-8');
  }

  const plan = (
    pids: number[],
    lockBudgetMs: number,
    forceKillEligiblePids: number[] = [],
    forceKillGraceMs = 5_000,
  ): WaiterPlan => ({
    pids, setupExePath: fakeSetup, installRoot: root, abortMarkerPath: abortMarker,
    readyMarkerPath: readyMarker, lockBudgetMs, forceKillEligiblePids, forceKillGraceMs,
  });

  function runWaiter(timeoutMs: number): { status: number | null; timedOut: boolean } {
    const res = spawnSync(
      PS,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { encoding: 'utf-8', timeout: timeoutMs, windowsHide: true },
    );
    return { status: res.status, timedOut: res.status === null };
  }

  it('blocks while a tracked process is alive, and never launches meanwhile', () => {
    const holder = holdRoot();
    // Budget comfortably longer than our patience: the waiter must still be
    // waiting when we give up, and must not have launched the installer.
    writeWaiter(plan([holder.pid as number], 90_000));

    const { timedOut } = runWaiter(12_000);
    expect(timedOut).toBe(true);
    expect(fs.existsSync(setupStamp)).toBe(false);
    // #1056 — mid-wait the incumbent's interrupted sentinel is ON DISK by
    // design (it is what reports a waiter killed before any terminal); the
    // pin here is that no TERMINAL reason has been written yet.
    expect(fs.readFileSync(abortMarker, 'utf-8')).toContain('interrupted before it could report');
  }, 120_000);

  it('gives up instead of waiting forever on a process that will not die', () => {
    // taskkill is best-effort. Before the wait was bounded, a survivor left the
    // waiter blocked forever — and wmux had already quit, so the update stalled
    // with nothing to show for it on the next boot.
    const holder = holdRoot();
    writeWaiter(plan([holder.pid as number], 3_000));

    expect(runWaiter(60_000).status).toBe(3);
    expect(fs.readFileSync(abortMarker, 'utf-8')).toContain('would not exit');
    expect(fs.existsSync(setupStamp)).toBe(false);
  }, 120_000);

  it('#1084 — force-kills a hung force-kill-eligible pid instead of refusing over it', () => {
    // The incident this closes: a process app.quit() already asked to exit
    // sits at 0% CPU past the lock budget, and the waiter refused rather
    // than ending it. Same holder as the "gives up" test above, but this
    // pid is marked force-kill-eligible with a short grace window — the
    // waiter must end it and go on to launch Setup.exe, not abort.
    // Shape of a SUCCESSFUL install, same as the "launches the installer"
    // test below — otherwise the real #1046 post-exit verification (Update.exe
    // + icudtl.dat) fails after Start-Process, falls through to exit 6, and a
    // MessageBox blocks a headless runner forever.
    fs.writeFileSync(path.join(root, 'Update.exe'), 'x');
    fs.writeFileSync(path.join(root, 'app-1.0.0', 'icudtl.dat'), 'x');

    const holder = holdRoot();
    writeWaiter(plan([holder.pid as number], 60_000, [holder.pid as number], 3_000));

    expect(runWaiter(60_000).status).toBe(0);
    expect(fs.existsSync(setupStamp)).toBe(true);
    expect(fs.existsSync(abortMarker)).toBe(false);
    // The waiter's own taskkill did the killing, not our afterEach cleanup —
    // confirm the holder is actually gone rather than merely unobserved.
    expect(() => process.kill(holder.pid as number, 0)).toThrow();
  }, 120_000);

  it('#1084 — still refuses a hung pid that is NOT force-kill-eligible (the daemon path)', () => {
    // Same shape as the eligible case above, but forceKillEligiblePids stays
    // empty — this is the daemon's own contract, unchanged: nothing but the
    // graceful daemon.shutdown RPC may end it, so a hang still refuses.
    const holder = holdRoot();
    writeWaiter(plan([holder.pid as number], 3_000));

    expect(runWaiter(60_000).status).toBe(3);
    expect(fs.readFileSync(abortMarker, 'utf-8')).toContain('would not exit');
    expect(fs.existsSync(setupStamp)).toBe(false);
  }, 120_000);

  it('launches the installer once the tracked process is gone and the root is clear', () => {
    const holder = holdRoot();
    holder.kill();
    // Wait for the lock to actually drop before starting the waiter, so this
    // test measures the launch path rather than kill latency.
    const deadline = Date.now() + 15_000;
    let released = false;
    while (Date.now() < deadline && !released) {
      try { const fd = fs.openSync(heldExe, 'r+'); fs.closeSync(fd); released = true; }
      catch { execFileSync(PS, ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 200'], { windowsHide: true }); }
    }
    expect(released).toBe(true);

    // #1046: the waiter now stays for Setup.exe's exit and verifies what it
    // left behind (Update.exe at the root, icudtl.dat in the newest app-*).
    // The fake installer installs nothing, so give the sandbox the shape of
    // a SUCCESSFUL install up front -- this test is about the launch path,
    // and the verification's failure branch is pinned by the script-shape
    // tests (a live 30s corpse-poll here would spend half the test budget
    // proving what the shape tests already prove).
    fs.writeFileSync(path.join(root, 'Update.exe'), 'x');
    fs.writeFileSync(path.join(root, 'app-1.0.0', 'icudtl.dat'), 'x');

    writeWaiter(plan([holder.pid as number], 5_000));
    expect(runWaiter(60_000).status).toBe(0);

    const stampDeadline = Date.now() + 20_000;
    while (Date.now() < stampDeadline && !fs.existsSync(setupStamp)) {
      execFileSync(PS, ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 200'], { windowsHide: true });
    }
    expect(fs.existsSync(setupStamp)).toBe(true);
    expect(fs.existsSync(abortMarker)).toBe(false);
  }, 120_000);

  it('aborts instead of launching when an UNTRACKED process still holds the root', () => {
    // The TOCTOU case: an MCP host spawned a fresh server into the directory
    // after we took our pid snapshot. Every pid we know about is gone, so the
    // handle waits pass — only the lock probe stands between us and destroying
    // the install.
    holdRoot();
    const doomed = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command', 'exit'], {
      windowsHide: true, stdio: 'ignore',
    });
    children.push(doomed);
    execFileSync(PS, ['-NoProfile', '-Command', 'Start-Sleep -Seconds 2'], { windowsHide: true });

    writeWaiter(plan([doomed.pid as number], 3_000));
    expect(runWaiter(60_000).status).toBe(2);

    expect(fs.existsSync(abortMarker)).toBe(true);
    expect(fs.readFileSync(abortMarker, 'utf-8')).toContain('install-aborted');
    // The whole point of the change.
    expect(fs.existsSync(setupStamp)).toBe(false);
  }, 120_000);

  it('aborts when only a DLL is locked — the file the field failure actually died on', () => {
    // The install that destroyed a real machine threw deleting `ffmpeg.dll`,
    // not an .exe. An .exe-only probe reports "clear" here and launches into a
    // live tree; this is the regression guard for that narrowing.
    const heldDll = path.join(root, 'app-1.0.0', 'ffmpeg.dll');
    fs.writeFileSync(heldDll, 'x');
    const holder = spawn(
      PS,
      ['-NoProfile', '-NonInteractive', '-Command',
        `$s=[System.IO.File]::Open(${q(heldDll)},'Open','Read','None'); Start-Sleep -Seconds 120; $s.Close()`],
      { windowsHide: true, stdio: 'ignore' },
    );
    children.push(holder);
    const deadline = Date.now() + 15_000;
    let taken = false;
    while (Date.now() < deadline && !taken) {
      try { const fd = fs.openSync(heldDll, 'r+'); fs.closeSync(fd); }
      catch { taken = true; }
      if (!taken) execFileSync(PS, ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 200'], { windowsHide: true });
    }
    expect(taken).toBe(true);

    // Every pid the waiter knows about is already gone, so only the lock probe
    // stands between it and Setup.exe.
    const doomed = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command', 'exit'], {
      windowsHide: true, stdio: 'ignore',
    });
    children.push(doomed);
    execFileSync(PS, ['-NoProfile', '-Command', 'Start-Sleep -Seconds 2'], { windowsHide: true });

    writeWaiter(plan([doomed.pid as number], 3_000));
    expect(runWaiter(60_000).status).toBe(2);
    expect(fs.existsSync(abortMarker)).toBe(true);
    expect(fs.existsSync(setupStamp)).toBe(false);
  }, 120_000);

  it('places the waiter script OUTSIDE the install root', () => {
    // Setup.exe deletes the install root. A waiter living inside it would be
    // deleting itself mid-run.
    const written = spawnInstallWaiter(plan([process.pid], 1_000));
    expect(written).not.toBeNull();
    expect((written as string).toLowerCase().startsWith(root.toLowerCase())).toBe(false);
    // #1056/P2-6 — this call now really launches a waiter (it terminates
    // itself in ~1s: its handle wait is against our own live pid on a 1s
    // budget). Reap the temp dir this test used to leak every run; retried
    // briefly because the dying waiter can hold its script file a moment.
    const leaked = path.dirname(written as string);
    const rmDeadline = Date.now() + 10_000;
    for (;;) {
      try { fs.rmSync(leaked, { recursive: true, force: true }); break; }
      catch { if (Date.now() > rmDeadline) break; execFileSync(PS, ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 500'], { windowsHide: true }); }
    }
  }, 60_000);

  it('enumerates nothing for a root no process runs from', () => {
    expect(collectInstallRootPids(root)).toEqual([]);
  }, 30_000);
});

describe.skipIf(!onWindows)('probeVolume', () => {
  it('agrees with the OS on free space (guards a blocks-vs-bytes mistake)', () => {
    const info = probeVolume(os.tmpdir());
    expect(info).not.toBeNull();
    expect(info?.volume).toMatch(/^[A-Za-z]:\\$/);

    const osFree = Number(execFileSync(
      PS,
      ['-NoProfile', '-NonInteractive', '-Command',
        `(New-Object System.IO.DriveInfo(${q(info?.volume ?? 'C:\\')})).AvailableFreeSpace`],
      { encoding: 'utf-8', windowsHide: true },
    ).trim());

    const ratio = (info?.freeBytes ?? 0) / osFree;
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  }, 30_000);
});

describe.skipIf(!onWindows)('concurrent waiters (#980)', () => {
  let sandbox: string;
  let root: string;
  let heldExe: string;
  let setupStamp: string;
  let fakeSetup: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-waiter2-')));
    root = path.join(sandbox, 'wmux');
    fs.mkdirSync(path.join(root, 'app-1.0.0'), { recursive: true });
    heldExe = path.join(root, 'app-1.0.0', 'held.exe');
    fs.writeFileSync(heldExe, 'x');
    setupStamp = path.join(sandbox, 'setup-ran.txt');
    fakeSetup = path.join(sandbox, 'fake-setup.cmd');
    fs.writeFileSync(fakeSetup, `@echo off\r\necho ran > "${setupStamp}"\r\n`);
  });

  afterEach(() => {
    for (const c of children.splice(0)) { try { c.kill(); } catch { /* already gone */ } }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* lock lingers */ }
  });

  it('a second waiter for the same root yields to the incumbent instead of racing it', () => {
    // The quit watchdog unlatches isInstalling after 30s so a refused quit
    // stays retryable — but the first waiter can still be inside its own
    // budget. Without the mutex both reach Start-Process on the same
    // Setup.exe: two concurrent Squirrel installs against one root, which is
    // the exact corruption #866 exists to prevent.
    const holderA = spawn(
      PS,
      ['-NoProfile', '-NonInteractive', '-Command',
        `$s=[System.IO.File]::Open(${q(heldExe)},'Open','Read','None'); Start-Sleep -Seconds 120; $s.Close()`],
      { windowsHide: true, stdio: 'ignore' },
    );
    children.push(holderA);

    const planFor = (marker: string): WaiterPlan => ({
      pids: [holderA.pid as number],
      setupExePath: fakeSetup,
      installRoot: root,
      abortMarkerPath: marker,
      readyMarkerPath: marker.replace(/\.txt$/, '-ready.tmp'),
      lockBudgetMs: 90_000,
      forceKillEligiblePids: [],
      forceKillGraceMs: 5_000,
    });

    // Waiter A: async, long budget — parked in WaitForExit holding the mutex.
    const scriptA = path.join(sandbox, 'waiter-a.ps1');
    fs.writeFileSync(scriptA, buildWaiterScript(planFor(path.join(sandbox, 'abort-a.txt'))) as string, 'utf-8');
    const waiterA = spawn(
      PS,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptA],
      { windowsHide: true, stdio: 'ignore' },
    );
    children.push(waiterA);

    // Deterministic gate, not a sleep: proceed only once A actually HOLDS the
    // mutex — otherwise B could win the race and this test would invert.
    // #1044, coderabbit: the real script now hashes $root with SHA256 instead
    // of the old lossy character replace. Node's crypto computes the same
    // digest over the same bytes — .toUpperCase() to match PowerShell's
    // BitConverter.ToString output, which the real script also strips dashes
    // from.
    const mtxHash = createHash('sha256').update(root, 'utf8').digest('hex').toUpperCase();
    const mtxName = 'wmux-install-waiter-' + mtxHash;
    const deadline = Date.now() + 15_000;
    let held = false;
    while (Date.now() < deadline) {
      const probe = spawnSync(
        PS,
        ['-NoProfile', '-NonInteractive', '-Command',
          `try { $m=[System.Threading.Mutex]::OpenExisting('${mtxName}'); exit 0 } catch { exit 1 }`],
        { windowsHide: true, timeout: 10_000 },
      );
      if (probe.status === 0) { held = true; break; }
    }
    expect(held).toBe(true);

    // Waiter B, same root: must yield IMMEDIATELY (exit 5), touch neither the
    // installer nor its own marker, and leave reporting to the incumbent.
    const markerB = path.join(sandbox, 'abort-b.txt');
    const scriptB = path.join(sandbox, 'waiter-b.ps1');
    fs.writeFileSync(scriptB, buildWaiterScript(planFor(markerB)) as string, 'utf-8');
    const resB = spawnSync(
      PS,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptB],
      { encoding: 'utf-8', timeout: 20_000, windowsHide: true },
    );
    expect(resB.status).toBe(5);
    expect(fs.existsSync(markerB)).toBe(false);
    expect(fs.existsSync(setupStamp)).toBe(false);
  }, 120_000);
});

describe.skipIf(!onWindows)('waiter transport (#1056 — the REAL spawnInstallWaiter)', () => {
  // Smoke coverage, billed honestly: on CI runners the direct detached spawn
  // still works, so this suite is green before AND after the transport change
  // and cannot regress-pin #1056 itself. What it closes is the older hole
  // that let #1056 ship: no test anywhere ran the waiter through the real
  // spawnInstallWaiter transport. The env assertion is the part that would
  // go red if a future transport stopped inheriting the caller's environment
  // — Setup.exe resolves its install target from %LOCALAPPDATA%.
  let sandbox: string;
  let root: string;
  let envStamp: string;
  let fakeSetup: string;
  let marker: string;
  let launchedDir: string | null = null;

  beforeEach(() => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-transport-')));
    root = path.join(sandbox, 'wmux');
    fs.mkdirSync(path.join(root, 'app-1.0.0'), { recursive: true });
    // The shape of a SUCCESSFUL install, so the waiter's post-exit
    // verification passes, removes its sentinel and exits 0 — the failure
    // branches are pinned by the script-shape tests, and an exit-6
    // MessageBox here would hang a headless runner.
    fs.writeFileSync(path.join(root, 'Update.exe'), 'x');
    fs.writeFileSync(path.join(root, 'app-1.0.0', 'icudtl.dat'), 'x');
    envStamp = path.join(sandbox, 'env.txt');
    marker = path.join(sandbox, 'abort.txt');
    fakeSetup = path.join(sandbox, 'fake-setup.cmd');
    // Redirect-first, so a username ending in a digit cannot turn `%USERNAME%>`
    // into a stream redirect.
    fs.writeFileSync(fakeSetup, `@echo off\r\n>"${envStamp}" echo %LOCALAPPDATA%^|%USERPROFILE%^|%USERNAME%\r\n`);
  });

  afterEach(() => {
    // The waiter is NOT our child (that is the whole point of the trampoline)
    // — reap by command line before dropping the directories.
    if (launchedDir !== null) {
      const dirLike = launchedDir.replace(/'/g, "''");
      try {
        execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='cmd.exe' OR Name='wscript.exe'" | Where-Object { $_.CommandLine -like '*${dirLike}*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F } | Out-Null`,
        ], { windowsHide: true, timeout: 20_000 });
      } catch { /* nothing left to reap */ }
      try { fs.rmSync(launchedDir, { recursive: true, force: true }); } catch { /* lock lingers */ }
      launchedDir = null;
    }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* lock lingers */ }
  });

  const mkPlan = (): WaiterPlan => ({
    pids: [], setupExePath: fakeSetup, installRoot: root,
    abortMarkerPath: marker, readyMarkerPath: path.join(sandbox, 'ready-transport.tmp'),
    lockBudgetMs: 2_000, forceKillEligiblePids: [], forceKillGraceMs: 5_000,
  });

  function sleep200(): void {
    execFileSync(PS, ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 200'], { windowsHide: true });
  }

  it('a verified transport runs the waiter with the caller environment intact', () => {
    const written = spawnInstallWaiter(mkPlan());
    // The launch-stamp gate passed — a real process executed our first line.
    expect(written).not.toBeNull();
    launchedDir = path.dirname(written as string);

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !fs.existsSync(envStamp)) sleep200();
    expect(fs.existsSync(envStamp)).toBe(true);
    const [la, up, un] = fs.readFileSync(envStamp, 'utf-8').trim().split('|');
    expect(la).toBe(process.env.LOCALAPPDATA);
    expect(up).toBe(process.env.USERPROFILE);
    expect(un).toBe(process.env.USERNAME);

    // Success path: the interrupted sentinel must be GONE once the waiter's
    // post-exit verification passes.
    const markerDeadline = Date.now() + 45_000;
    while (Date.now() < markerDeadline && fs.existsSync(marker)) sleep200();
    expect(fs.existsSync(marker)).toBe(false);
  }, 120_000);

  it("survives a TEMP with spaces and an apostrophe (the cmd /c quoting pin)", () => {
    // cmd /c re-parses its tail with its own rules; today's safety rests on
    // the FIRST token (the System32 powershell path) being space-free and
    // unquoted. The script path is the token that inherits the user's TEMP,
    // so this pins the one quoting risk left in the transport.
    const weird = path.join(sandbox, "tmp o'brien");
    fs.mkdirSync(weird);
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };
    process.env.TEMP = weird;
    process.env.TMP = weird;
    try {
      const written = spawnInstallWaiter(mkPlan());
      expect(written).not.toBeNull();
      expect((written as string).toLowerCase().startsWith(weird.toLowerCase())).toBe(true);
      launchedDir = path.dirname(written as string);
    } finally {
      process.env.TEMP = saved.TEMP;
      process.env.TMP = saved.TMP;
    }
  }, 120_000);

  it('#1136 — the hidden wscript transport is the one that carries the install', () => {
    // The defect: the cmd.exe trampoline is spawned `detached`, and
    // DETACHED_PROCESS overrides the CREATE_NO_WINDOW that `windowsHide: true`
    // asks for. The child then allocates its own console, that allocation goes
    // through the Win11 default-terminal delegation, and Windows Terminal opens
    // a real visible window. A/B measured on a Win11 26200 box with WT as the
    // default host: the same cmd.exe with `detached: true` produced a visible
    // WindowsTerminal window, without it produced none.
    //
    // What this asserts is transport IDENTITY, not window count. A global
    // visible-window diff was tried first and rejected: it goes red for any
    // console window that happens to open on the box during the sample (a
    // parallel test file, another tool), so it reports the machine's mood
    // rather than this code's behaviour. The identity check is exact — the
    // per-transport script name is already distinct because each transport
    // needs its own launch stamp — and it is the property that actually
    // matters: on a machine where the hidden transport works, it must be the
    // one that runs, never the visible fallback behind it.
    const written = spawnInstallWaiter(mkPlan());
    expect(written).not.toBeNull();
    launchedDir = path.dirname(written as string);
    expect(path.basename(written as string)).toBe('wait-and-install-w.ps1');

    // ...and it is a REAL waiter, not just a process that stamped and died:
    // the same end-to-end proof the transport suite's first test makes.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !fs.existsSync(envStamp)) sleep200();
    expect(fs.existsSync(envStamp)).toBe(true);
  }, 120_000);
});
