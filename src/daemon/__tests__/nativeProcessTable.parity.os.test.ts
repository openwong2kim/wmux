import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadNativeTerminalCore, type NativeTerminalCore } from '../../shared/nativeTerminalCore';
import { ProcessMonitor } from '../ProcessMonitor';
import { defaultSnapshot } from '../../main/pty/portWatch';

// The built native process table against what it replaces: the PowerShell
// CIM enumeration on Windows; on macOS and Linux, `ps` for the walk and
// `lsof` for the listening sockets PortWatcher reads. Run by
// native-terminal-core.yml after the module is built; elsewhere it skips
// when the module is absent.
const posix = process.platform === 'darwin' || process.platform === 'linux';
let core: NativeTerminalCore | undefined;
if (process.platform === 'win32' || posix) {
  try {
    core = loadNativeTerminalCore(posix ? 'listen-sockets-v1' : 'process-table-v1');
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

describe.runIf(core && process.platform === 'win32')('native process table parity with CIM', () => {
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

/** `ps -axo pid=,ppid=,ucomm=`: pid → (ppid, short name). `ucomm` is the
 *  kernel's name on both systems (macOS `comm` prints argv[0]); ps pads it. */
function psWalk(): Map<number, { ppid: number; name: string }> {
  const stdout = execFileSync('ps', ['-axo', 'pid=,ppid=,ucomm='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const rows = new Map<number, { ppid: number; name: string }>();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s(.*?)\s*$/);
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), name: m[3].trim() });
  }
  return rows;
}

const LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((p) => fs.existsSync(p));

/** Every listening TCP socket lsof lists, as `pid:port` (parsed as
 *  PortWatcher does) → the address lsof prints (`*` for any). */
function lsofListeners(): Map<string, string> {
  const stdout = execFileSync(LSOF as string, ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = new Map<string, string>();
  let pid: number | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || null;
    else if (line.startsWith('n') && pid !== null) {
      const m = line.slice(1).match(/^\[?(.*?)\]?:(\d+)$/);
      if (m) out.set(`${pid}:${m[2]}`, m[1]);
    }
  }
  return out;
}

async function nativeListeners(): Promise<Set<string>> {
  return new Set((await core!.portSnapshot!()).sockets.map((s) => `${s.pid}:${s.port}`));
}

/** The hosts the listener child binds, in the order it prints their ports:
 *  IPv4, a v4-mapped IPv6 address, IPv6 loopback, and dual-stack any. */
const HOSTS = ['127.0.0.1', '::ffff:127.0.0.1', '::1', '::'];

describe.runIf(core && posix)('native process walk and listening sockets parity with ps and lsof', () => {
  let child: ChildProcess | undefined;
  const stopChild = (): void => {
    child?.kill('SIGKILL');
    child = undefined;
  };
  // A retried or failed test must never leave a listener behind: it would
  // keep the fork worker (and vitest) from exiting.
  afterEach(stopChild);

  /** A child listening on HOSTS; resolves to its ports (0 where a bind failed).
   *  It exits on its own after a minute whatever happens to the test. */
  async function startListeners(): Promise<{ pid: number; ports: number[] }> {
    stopChild();
    child = spawn(process.execPath, ['-e', `
      const net = require('node:net');
      Promise.all(${JSON.stringify(HOSTS)}.map((h) => new Promise((ok) => {
        const s = net.createServer().listen(0, h, () => ok(s.address().port)).on('error', () => ok(0));
      }))).then((ports) => console.log(ports.join(' ')));
      setTimeout(() => process.exit(0), 60000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
    const ports = await new Promise<number[]>((resolve) => child!.stdout!.once('data', (d) => resolve(String(d).trim().split(' ').map(Number))));
    return { pid: child.pid as number, ports };
  }

  it('walks every process ps lists, with the same parent and name', async () => {
    const native = (await core!.portSnapshot!()).processes;
    const ps = psWalk();
    let compared = 0;
    for (const row of native) {
      const other = ps.get(row.pid);
      if (!other) continue; // exited between the reads
      compared++;
      // Linux kernel threads (kthreadd, pid 2, and its children) rename
      // themselves at any moment (a kworker's name carries its current
      // workqueue), so only their pid and parent are compared.
      if (process.platform === 'linux' && (row.pid === 2 || row.ppid === 2)) {
        expect({ pid: row.pid, ppid: row.ppid }).toEqual({ pid: row.pid, ppid: other.ppid });
        continue;
      }
      // ps pads ucomm, so a name's own trailing blank is lost there.
      expect({ pid: row.pid, ppid: row.ppid, name: row.name.trimEnd() }).toEqual({ pid: row.pid, ...other });
    }
    expect(compared).toBeGreaterThan(native.length * 0.9);
    expect(native.some((r) => r.pid === process.pid && r.ppid === process.ppid)).toBe(true);
    // processTable(false) is the same walk.
    expect((await core!.processTable!(false)).some((r) => r.pid === process.pid && r.ppid === process.ppid)).toBe(true);
  });

  it.runIf(LSOF)('lists the listening sockets lsof lists, with the address it prints', async () => {
    const { pid, ports } = await startListeners();
    const snap = await core!.portSnapshot!();
    const lsof = lsofListeners();
    const after = await nativeListeners();
    const mine = snap.sockets.filter((s) => s.pid === pid);
    ports.forEach((port, i) => {
      if (!port) return; // this host could not be bound here (no IPv6)
      const row = mine.find((s) => s.port === port);
      const printed = lsof.get(`${pid}:${port}`);
      // lsof prints `*` for any; otherwise native reports the address lsof prints.
      const want = printed === '*' && (row?.address === '0.0.0.0' || row?.address === '::') ? row.address : printed;
      expect({ port, host: HOSTS[i], native: row?.address, lsof: printed }).toEqual({ port, host: HOSTS[i], native: want, lsof: printed });
      expect(row!.family).toBe(row!.address.includes(':') ? 6 : 4);
    });
    // A v4-mapped bind is IPv4 with the dotted address lsof prints, on both systems.
    if (ports[1]) expect(mine.find((s) => s.port === ports[1])).toMatchObject({ address: '127.0.0.1', family: 4 });
    // Every socket's pid is in the same snapshot's walk.
    expect(snap.sockets.every((s) => snap.processes.some((r) => r.pid === s.pid))).toBe(true);
    // A socket opened or closed between the reads is in one native read only.
    const before = new Set(snap.sockets.map((s) => `${s.pid}:${s.port}`));
    const steady = [...before].filter((k) => after.has(k));
    expect(steady.filter((k) => !lsof.has(k))).toEqual([]);
    expect([...lsof.keys()].filter((k) => !before.has(k) && !after.has(k))).toEqual([]);
  }, 60_000);

  it('feeds PortWatcher the same snapshot as ps and lsof', async () => {
    const { pid } = LSOF ? await startListeners() : { pid: undefined };
    const snap = await defaultSnapshot();
    const ps = psWalk();
    for (const [p, ppid] of snap.ppidByPid) if (ps.has(p)) expect(ppid).toBe(ps.get(p)!.ppid);
    if (LSOF) {
      const lsof = lsofListeners();
      expect(snap.listeners.some((l) => l.pid === pid)).toBe(true);
      for (const l of snap.listeners.filter((x) => x.pid === pid)) expect(lsof.has(`${l.pid}:${l.port}`)).toBe(true);
    }
  }, 60_000);
});
