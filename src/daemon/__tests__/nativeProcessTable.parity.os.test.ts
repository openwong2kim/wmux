import { describe, it, expect, afterAll, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { loadNativeTerminalCore, type NativeTerminalCore } from '../../shared/nativeTerminalCore';
import { ProcessMonitor } from '../ProcessMonitor';

// The built native process table against the PowerShell CIM enumeration it
// replaces (Windows). Run by native-terminal-core.yml after the module is
// built; elsewhere it skips when the module is absent.
let core: NativeTerminalCore | undefined;
if (process.platform === 'win32') {
  try {
    core = loadNativeTerminalCore('process-table-v1');
  } catch (error) {
    if (process.env.WMUX_REQUIRE_RUST_CORE === '1') throw error;
  }
}

type Row = { pid: number; ppid: number; name: string; created?: number; cmdline?: string };

function cimTable(): Map<number, Row> {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const stdout = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance -ClassName Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }), $_.Name, $_.CommandLine }"],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  const rows = new Map<number, Row>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^(\d+)\|(\d+)\|(\d*)\|(.+)$/);
    if (!m) continue;
    const parts = m[4].split('|');
    const cmdline = parts.slice(1).join('|');
    rows.set(Number(m[1]), {
      pid: Number(m[1]), ppid: Number(m[2]), name: parts[0],
      ...(m[3] ? { created: Number(m[3]) } : {}),
      ...(cmdline ? { cmdline } : {}),
    });
  }
  return rows;
}

describe.runIf(core)('native process table parity with CIM', () => {
  let child: ChildProcess | undefined;
  afterAll(() => { child?.kill(); });

  it('reads a known child exactly as CIM does', async () => {
    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'wmux parity|arg', '한글'], { windowsHide: true });
    const pid = child.pid as number;
    // The command line is readable once the child has initialised.
    const native = await vi.waitFor(async () => {
      const row = (await core!.processTable!(true)).find((r) => r.pid === pid);
      expect(row?.cmdline).toBeTruthy();
      return row;
    }, { timeout: 10_000 });
    const cim = cimTable().get(pid);
    expect(cim?.cmdline).toContain('wmux parity|arg');
    expect(native).toEqual(cim);
  }, 90_000);

  it('agrees on every row both sides read', async () => {
    const native = await core!.processTable!(true);
    const cim = cimTable();
    let compared = 0;
    for (const row of native) {
      const other = cim.get(row.pid);
      // A pid that exited and was reused between the two reads is skipped.
      if (!other || other.created === undefined || row.created == null || other.created !== row.created) continue;
      compared++;
      expect({ pid: row.pid, ppid: row.ppid, name: row.name }).toEqual({ pid: other.pid, ppid: other.ppid, name: other.name });
      // WmiPrvSE hosts the provider answering this very CIM query, and CIM can
      // report a host's command line without its arguments (seen on a CI
      // runner: the bare exe path for a host the native read sees with its
      // arguments). No caller reads these rows; every other row must agree.
      if (row.name.toLowerCase() === 'wmiprvse.exe') continue;
      if (row.cmdline && other.cmdline) expect(row.cmdline).toBe(other.cmdline);
    }
    expect(compared).toBeGreaterThan(native.length / 2);
  }, 90_000);

  it('serves ProcessMonitor without tasklist', async () => {
    const { alive, images } = await ProcessMonitor.batchCheckAliveDetailed([process.pid]);
    expect(alive.has(process.pid)).toBe(true);
    expect(images.get(process.pid)?.toLowerCase()).toBe(path.basename(process.execPath).toLowerCase());
  });
});
