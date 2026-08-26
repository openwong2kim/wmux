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

  const plan = (pids: number[], lockBudgetMs: number): WaiterPlan => ({
    pids, setupExePath: fakeSetup, installRoot: root, abortMarkerPath: abortMarker, lockBudgetMs,
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
    expect(fs.existsSync(abortMarker)).toBe(false);
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
  }, 30_000);

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
      lockBudgetMs: 90_000,
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
