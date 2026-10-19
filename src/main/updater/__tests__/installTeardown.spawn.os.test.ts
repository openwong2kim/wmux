// #1264 — what spawnInstallWaiter actually LAUNCHES, and in what order.
//
// The field failure this pins: every transport the module had was started with
// `child_process.spawn` from the Electron main process, which on Windows makes
// the waiter a member of the app's job object — so it was killed by the kernel
// the moment wmux exited, before reaching any of its own exit branches. The fix
// is a transport whose process is started by the Task Scheduler service instead
// of by us. Nothing about that is observable from a spawn's return value, so
// what is asserted here is the launch PATH: schtasks is tried first, with the
// arguments that make the scheduler (not us) the parent, and the in-tree
// transports are only reached when it does not prove execution.
//
// win32 is forced and child_process is mocked, so this runs on any host — the
// real-kernel half lives in installTeardown.runtime.test.ts (windows-latest).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { spawnInstallWaiter, sweepStaleWaiterTasks } from '../installTeardown';

const spawnMock = vi.fn();
const execFileSyncMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...a: unknown[]) => spawnMock(...a),
  execFileSync: (...a: unknown[]) => execFileSyncMock(...a),
}));


const realPlatform = process.platform;

/** A ChildProcess stub good enough for `swallowSpawnError` + `unref`. */
function fakeChild(pid = 4242) {
  return { pid, on: vi.fn(), unref: vi.fn() };
}

describe('spawnInstallWaiter launch path (#1264)', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    spawnMock.mockReset();
    execFileSyncMock.mockReset();
    spawnMock.mockImplementation(() => fakeChild());
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    for (const d of dirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  const plan = () => ({
    pids: [],
    setupExePath: 'C:\\Temp\\Setup.exe',
    installRoot: 'C:\\Users\\Daniel\\AppData\\Local\\wmux',
    abortMarkerPath: 'C:\\Temp\\abort.txt',
    readyMarkerPath: 'C:\\Temp\\ready.tmp',
    lockBudgetMs: 60_000,
    forceKillEligiblePids: [],
    forceKillGraceMs: 5_000,
  });

  /** The directory the module mkdtemp'd, read off the definition it registered. */
  function waiterDirFrom(xmlPath: string): string {
    const dir = path.dirname(xmlPath);
    dirs.push(dir);
    return dir;
  }

  /** schtasks calls only — the elevation probe shares the mock. */
  const schtasksCalls = () =>
    execFileSyncMock.mock.calls.filter((c) => /schtasks\.exe$/.test(c[0] as string));

  it('registers and runs a scheduled task BEFORE spawning anything of its own', () => {
    execFileSyncMock.mockImplementation((exe: string, args: string[]) => {
      if (args[0] === '/Run') {
        // The scheduler started it: stamp, exactly as the real waiter's first
        // lines do.
        const xmlPath = execFileSyncMock.mock.calls.find((c) => c[1][0] === '/Create')![1][4] as string;
        fs.writeFileSync(path.join(waiterDirFrom(xmlPath), 'launched-s.txt'), 'launched');
      }
      return '';
    });

    const written = spawnInstallWaiter(plan());

    expect(written).not.toBeNull();
    // The transport that carried it is identifiable from the script name.
    expect(path.basename(written as string)).toBe('wait-and-install-s.ps1');
    // Nothing of ours was spawned — no wscript, no cmd, no powershell child.
    expect(spawnMock).not.toHaveBeenCalled();

    const calls = schtasksCalls();
    expect(calls[0][1][0]).toBe('/Create');
    expect(calls[1][1][0]).toBe('/Run');
    // The registration is removed once the scheduler has started the process:
    // the running instance is not ours to keep registered.
    expect(calls[2][1][0]).toBe('/Delete');
    expect(calls[0][1][2]).toBe(calls[1][1][2]);
    expect(calls[0][1][2]).toBe(calls[2][1][2]);
    expect(calls[0][1][2]).toMatch(/^wmux-update-[A-Za-z0-9]+$/);
    // Registered from XML, not /TR — the short form cannot carry the battery
    // settings, and the definition on disk is the hidden wscript launcher.
    expect(calls[0][1][3]).toBe('/XML');
    const xml = fs.readFileSync(calls[0][1][4] as string, 'utf16le').replace(/^\uFEFF/, '');
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
    expect(xml).toMatch(/<Arguments>\/\/B \/\/Nologo "[^"]*launch-waiter-s\.vbs"<\/Arguments>/);
    expect(xml).toMatch(/<Command>[^<]*wscript\.exe<\/Command>/);
    // #1283 review — every call is silent and SHORT: this blocks the main
    // process right after the user clicked Install.
    for (const c of execFileSyncMock.mock.calls) {
      expect((c[2] as { windowsHide?: boolean }).windowsHide).toBe(true);
      expect((c[2] as { timeout?: number }).timeout).toBeGreaterThan(0);
      expect((c[2] as { timeout?: number }).timeout).toBeLessThanOrEqual(3_000);
    }
  });

  it('falls through to the in-tree transports when the scheduler proves nothing', () => {
    // No stamp is ever written, so the S gate times out. The fallbacks must
    // still be reachable — a machine with Task Scheduler locked down keeps
    // today's behaviour rather than losing the update entirely.
    execFileSyncMock.mockImplementation((_exe: string, args: string[]) => {
      if (args[0] === '/Create') waiterDirFrom(args[4]);
      return '';
    });
    spawnMock.mockImplementation((exe: string, args: string[]) => {
      if (/wscript\.exe$/.test(exe)) {
        fs.writeFileSync(path.join(path.dirname(args[2]), 'launched-w.txt'), 'launched');
      }
      return fakeChild();
    });

    const written = spawnInstallWaiter(plan());

    expect(path.basename(written as string)).toBe('wait-and-install-w.ps1');
    expect(spawnMock.mock.calls[0][0]).toMatch(/wscript\.exe$/);
    // ...and the task registration is not left behind on the way past.
    expect(schtasksCalls().some((c) => c[1][0] === '/Delete')).toBe(true);
  }, 30_000);

  it('a schtasks that throws does not abort the handoff', () => {
    execFileSyncMock.mockImplementation(() => { throw new Error('access denied'); });
    spawnMock.mockImplementation((exe: string, args: string[]) => {
      if (/wscript\.exe$/.test(exe)) {
        fs.writeFileSync(path.join(path.dirname(args[2]), 'launched-w.txt'), 'launched');
      }
      return fakeChild();
    });

    expect(path.basename(spawnInstallWaiter(plan()) as string)).toBe('wait-and-install-w.ps1');
  }, 30_000);
});

describe('leaked waiter task registrations (#1283 review)', () => {
  const realPlatform2 = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    spawnMock.mockReset();
    execFileSyncMock.mockReset();
    spawnMock.mockImplementation(() => fakeChild());
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform2, configurable: true });
  });

  it('a /Create that fails still tries to remove a name the server may have committed', () => {
    // The dangerous shape: /Create TIMES OUT after the scheduler committed, so
    // the registration exists even though we saw a failure. Without this the
    // only cleanup is the next startup sweep.
    execFileSyncMock.mockImplementation((exe: string, args: string[]) => {
      if (/schtasks\.exe$/.test(exe) && args[0] === '/Create') {
        const e = new Error('ETIMEDOUT') as Error & { code: string };
        e.code = 'ETIMEDOUT';
        throw e;
      }
      return '';
    });
    spawnMock.mockImplementation((exe: string, args: string[]) => {
      if (/wscript\.exe$/.test(exe)) {
        fs.writeFileSync(path.join(path.dirname(args[2]), 'launched-w.txt'), 'launched');
      }
      return fakeChild();
    });

    expect(path.basename(spawnInstallWaiter({
      pids: [], setupExePath: 'C:\\Temp\\Setup.exe', installRoot: 'C:\\wmux',
      abortMarkerPath: 'C:\\Temp\\a.txt', readyMarkerPath: 'C:\\Temp\\r.tmp',
      lockBudgetMs: 60_000, forceKillEligiblePids: [], forceKillGraceMs: 5_000,
    }) as string)).toBe('wait-and-install-w.ps1');

    const deletes = execFileSyncMock.mock.calls.filter((c) => c[1][0] === '/Delete');
    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes[0][1][2]).toMatch(/^wmux-update-[A-Za-z0-9]+$/);
  }, 30_000);

  it('the startup sweep removes only our own leftovers', () => {
    execFileSyncMock.mockImplementation((_exe: string, args: string[]) => {
      if (args[0] === '/Query') {
        return [
          'Folder: \\',
          'HostName:                             DESKTOP',
          'TaskName:                             \\wmux-update-wmuxinstallwaiterA1b2',
          'Next Run Time:                        N/A',
          '',
          'TaskName:                             \\wmux-update-wmuxinstallwaiterZ9y8',
          '',
          // Not ours, and a name that only LOOKS close — neither may be touched.
          'TaskName:                             \\GoogleUpdateTaskMachineUA',
          'TaskName:                             \\wmux-update-nested\\evil',
          'TaskName:                             \\OneDrive Reporting Task-S-1-5-21',
        ].join('\r\n');
      }
      return '';
    });

    expect(sweepStaleWaiterTasks()).toBe(2);
    const deleted = execFileSyncMock.mock.calls
      .filter((c) => c[1][0] === '/Delete')
      .map((c) => c[1][2]);
    expect(deleted.sort()).toEqual([
      'wmux-update-wmuxinstallwaiterA1b2',
      'wmux-update-wmuxinstallwaiterZ9y8',
    ]);
  });

  it('the sweep is inert off Windows and when the scheduler refuses', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    expect(sweepStaleWaiterTasks()).toBe(0);
    expect(execFileSyncMock).not.toHaveBeenCalled();

    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    execFileSyncMock.mockImplementation(() => { throw new Error('access denied'); });
    expect(sweepStaleWaiterTasks()).toBe(0);
  });
});
