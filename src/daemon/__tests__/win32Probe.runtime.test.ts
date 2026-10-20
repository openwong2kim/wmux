import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import {
  classifyReapIdentity,
  dmtfToUtcMicros,
  fileTimeToUtcMicros,
  getProcessCreatedAtFt,
  getProcessStartTime,
  getWin32BootId,
  getWin32BootIdSync,
  readProcessCreatedAtFt,
  readWin32ReapIdentity,
  resetWin32BootIdCache,
} from '../phantomExit';

// #1493: the real probes on a real Windows box. wmic.exe is absent on current
// Windows 11, so before the fix every one of these came back empty.
// #2398: the per-process reads are native now. #2497: the boot ID is the
// registry boot counter.
const BOOT_COUNTER = /^win32-boot-\d+$/;
const DMTF = /^\d{14}\.\d{6}[+-]\d{3}$/;
const FILETIME = /^\d{17,}$/;
const onWindows = process.platform === 'win32';

let child: ChildProcess | undefined;

afterEach(() => {
  if (child?.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  }
  child = undefined;
});

function spawnCmd(): ChildProcess {
  const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  // A shell that stays alive while we probe it.
  return spawn(cmd, ['/c', 'ping -n 60 127.0.0.1 >nul'], { stdio: 'ignore', windowsHide: true });
}

describe.skipIf(!onWindows)('win32 probes (live)', () => {
  it('boot ID is the registry boot counter and identical across uncached reads', async () => {
    resetWin32BootIdCache();
    const first = await getWin32BootId();
    resetWin32BootIdCache();
    const second = getWin32BootIdSync();
    expect(first).toMatch(BOOT_COUNTER);
    expect(second).toBe(first);
  }, 20_000);

  it('boot ID read from a separate process matches', async () => {
    resetWin32BootIdCache();
    const here = await getWin32BootId();
    const script =
      "(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters').BootId";
    const there = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf-8',
      windowsHide: true,
    }).trim();
    expect(here).toBe(`win32-boot-${there}`);
  }, 20_000);

  it('start time of a spawned shell is readable and stable', async () => {
    child = spawnCmd();
    const pid = child.pid!;
    const t0 = Date.now();
    const first = await getProcessStartTime(pid);
    const elapsed = Date.now() - t0;
    const second = await getProcessStartTime(pid);
    console.log(`[win32Probe] start-time probe took ${elapsed} ms`);
    expect(first).toMatch(FILETIME);
    expect(second).toBe(first);
  }, 20_000);

  it('the native FILETIME matches the DMTF value CIM reports, so pre-#2398 records keep authorizing', () => {
    // The exact query pre-#2398 builds stored as pidStartTime.
    const ping = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PING.EXE');
    child = spawn(ping, ['-n', '30', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
    const pid = child.pid ?? 0;
    const ft = getProcessCreatedAtFt(pid);
    if (ft === null) throw new Error(`no native creation time for pid ${pid}`);
    const script =
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop;` +
      ' [System.Management.ManagementDateTimeConverter]::ToDmtfDateTime($p.CreationDate)';
    const dmtf = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf-8',
      windowsHide: true,
    }).trim();
    console.log(`[win32Probe] pid ${pid}: FILETIME ${ft} vs CIM ${dmtf}`);
    expect(dmtf).toMatch(DMTF);
    expect(dmtfToUtcMicros(dmtf)).toBe(fileTimeToUtcMicros(ft));
    expect(classifyReapIdentity({ storedStartTime: dmtf, currentCreatedAtFt: ft, looksLikeOurShell: false }))
      .toBe('start-time');
    expect(classifyReapIdentity({ storedCreatedAtFt: ft.toString(), currentCreatedAtFt: getProcessCreatedAtFt(pid), looksLikeOurShell: false }))
      .toBe('start-time');
  }, 20_000);

  it('identity check recognizes the spawned cmd.exe and nothing else', async () => {
    child = spawnCmd();
    const pid = child.pid!;
    expect(readWin32ReapIdentity(pid, 'cmd.exe').looksLikeOurShell).toBe(true);
    expect(readWin32ReapIdentity(pid, 'C:\\Windows\\System32\\cmd.exe').looksLikeOurShell).toBe(true);
    expect(readWin32ReapIdentity(pid, 'powershell.exe').looksLikeOurShell).toBe(false);
    expect(readWin32ReapIdentity(pid, 'cmd.exe').currentCreatedAtFt).toBe(getProcessCreatedAtFt(pid));
  }, 20_000);

  it('a pid that does not exist reads as unknown', async () => {
    expect(await getProcessStartTime(99_999_996)).toBeNull();
    expect(readWin32ReapIdentity(99_999_996, 'cmd.exe')).toEqual({ currentCreatedAtFt: null, currentGone: true, looksLikeOurShell: false });
    // ...and the native read tells the reaper it is gone, not unreadable.
    expect(readProcessCreatedAtFt(99_999_996)).toEqual({ value: null, gone: true });
  }, 20_000);
});
