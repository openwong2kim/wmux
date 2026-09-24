import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import {
  getProcessStartTime,
  getWin32BootId,
  getWin32BootIdSync,
  isWin32ShellProcess,
  resetWin32BootIdCache,
} from '../phantomExit';

// #1493: the real probes on a real Windows box. wmic.exe is absent on current
// Windows 11, so before the fix every one of these came back empty.
const DMTF = /^\d{14}\.\d{6}[+-]\d{3}$/;
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
  it('boot ID is a DMTF boot time and identical across uncached reads', async () => {
    resetWin32BootIdCache();
    const first = await getWin32BootId();
    resetWin32BootIdCache();
    const second = getWin32BootIdSync();
    expect(first).toMatch(DMTF);
    expect(second).toBe(first);
  }, 20_000);

  it('boot ID read from a separate process matches', async () => {
    resetWin32BootIdCache();
    const here = await getWin32BootId();
    const script =
      "[System.Management.ManagementDateTimeConverter]::ToDmtfDateTime(" +
      '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime)';
    const there = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf-8',
      windowsHide: true,
    }).trim();
    expect(here).toBe(there);
  }, 20_000);

  it('start time of a spawned shell is readable and stable', async () => {
    child = spawnCmd();
    const pid = child.pid!;
    const t0 = Date.now();
    const first = await getProcessStartTime(pid);
    const elapsed = Date.now() - t0;
    const second = await getProcessStartTime(pid);
    console.log(`[win32Probe] start-time probe took ${elapsed} ms`);
    expect(first).toMatch(DMTF);
    expect(second).toBe(first);
  }, 20_000);

  it('identity check recognizes the spawned cmd.exe and nothing else', async () => {
    child = spawnCmd();
    const pid = child.pid!;
    expect(await isWin32ShellProcess(pid, 'cmd.exe')).toBe(true);
    expect(await isWin32ShellProcess(pid, 'C:\\Windows\\System32\\cmd.exe')).toBe(true);
    expect(await isWin32ShellProcess(pid, 'powershell.exe')).toBe(false);
  }, 20_000);

  it('a pid that does not exist reads as unknown', async () => {
    expect(await getProcessStartTime(99_999_996)).toBeNull();
    expect(await isWin32ShellProcess(99_999_996, 'cmd.exe')).toBe(false);
  }, 20_000);
});
