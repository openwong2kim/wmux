import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  collectTreeCpuTimes,
  decodeTcpTableV4,
  decodeTcpTableV6,
  decodeProcessEntry,
  PROCESSENTRY32W_SIZE,
  TCP_ROW4_SIZE,
  TCP_ROW6_SIZE,
  tryProcessCreatedAt,
} from '../winSnapshotNative';

// ── fixtures ────────────────────────────────────────────────────────────────

function table(rows: Buffer[]): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(rows.length, 0);
  return Buffer.concat([head, ...rows]);
}

/** MIB_TCPROW_OWNER_PID with only the fields the decoder reads populated. */
function v4Row(port: number, pid: number): Buffer {
  const row = Buffer.alloc(TCP_ROW4_SIZE);
  row.writeUInt32LE(2, 0); // dwState (LISTEN) — ignored by the decoder
  row.writeUInt16BE(port, 8); // dwLocalPort — network byte order, low word
  row.writeUInt32LE(pid, 20); // dwOwningPid
  return row;
}

function v6Row(port: number, pid: number): Buffer {
  const row = Buffer.alloc(TCP_ROW6_SIZE);
  row.writeUInt16BE(port, 20); // dwLocalPort
  row.writeUInt32LE(pid, 52); // dwOwningPid
  return row;
}

describe('decodeTcpTableV4', () => {
  it('decodes ports (network byte order) and owning pids', () => {
    const buf = table([v4Row(3000, 1234), v4Row(5173, 42)]);
    // 3000 = 0x0BB8 → the row stores bytes 0x0B 0xB8 at the port offset.
    expect(buf[4 + 8]).toBe(0x0b);
    expect(buf[4 + 9]).toBe(0xb8);
    expect(decodeTcpTableV4(buf)).toEqual([
      { port: 3000, pid: 1234 },
      { port: 5173, pid: 42 },
    ]);
  });

  it('returns [] for an empty table and for a headerless buffer', () => {
    expect(decodeTcpTableV4(table([]))).toEqual([]);
    expect(decodeTcpTableV4(Buffer.alloc(0))).toEqual([]);
  });

  it('drops rows past the end of the buffer instead of throwing', () => {
    // The table can shrink between the size probe and the fill call; a row
    // count larger than the buffer must never read out of bounds.
    const full = table([v4Row(3000, 1234), v4Row(4000, 99)]);
    const truncated = full.subarray(0, 4 + TCP_ROW4_SIZE + 5);
    expect(decodeTcpTableV4(truncated)).toEqual([{ port: 3000, pid: 1234 }]);
  });
});

describe('decodeTcpTableV6', () => {
  it('decodes ports and pids at the v6 row offsets', () => {
    const buf = table([v6Row(8080, 777), v6Row(3000, 1234)]);
    expect(decodeTcpTableV6(buf)).toEqual([
      { port: 8080, pid: 777 },
      { port: 3000, pid: 1234 },
    ]);
  });
});

describe('decodeProcessEntry', () => {
  it('reads th32ProcessID and th32ParentProcessID at the 64-bit offsets', () => {
    const entry = Buffer.alloc(PROCESSENTRY32W_SIZE);
    entry.writeUInt32LE(PROCESSENTRY32W_SIZE, 0); // dwSize
    entry.writeUInt32LE(4321, 8); // th32ProcessID
    entry.writeUInt32LE(100, 32); // th32ParentProcessID
    expect(decodeProcessEntry(entry)).toEqual({ pid: 4321, ppid: 100 });
  });
});

// ── issue #1051 regression guard ────────────────────────────────────────────
//
describe('collectTreeCpuTimes', () => {
  // created / cpu in 100 ns units; only their order matters here.
  const times = (rows: Record<number, [created: number, cpu: number]>) => (pid: number) => {
    const row = rows[pid];
    return row ? { created: BigInt(row[0]), cpu: BigInt(row[1]) } : null;
  };

  it('sums the roots and every descendant', () => {
    const procs = [
      { pid: 10, ppid: 1 }, // root (wmux main)
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 11 },
      { pid: 20, ppid: 1 }, // second root (daemon)
      { pid: 21, ppid: 20 },
      { pid: 99, ppid: 1 }, // unrelated
    ];
    const out = collectTreeCpuTimes(procs, [10, 20], times({
      10: [100, 1], 11: [110, 2], 12: [120, 3], 20: [50, 4], 21: [60, 5], 99: [10, 6],
    }));
    expect([...out.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [10, 1n], [11, 2n], [12, 3n], [20, 4n], [21, 5n],
    ]);
  });

  it('drops an orphan whose dead parent pid was reused by one of our processes', () => {
    // pid 11 is our shell, created at 500. Process 30 (with its child 31) was
    // started at 200 by an unrelated process that also had pid 11 and has
    // since exited; Windows kept 30's ppid at 11.
    const procs = [
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 10 },
      { pid: 30, ppid: 11 },
      { pid: 31, ppid: 30 },
      { pid: 12, ppid: 11 }, // a real child of our shell
    ];
    const out = collectTreeCpuTimes(procs, [10], times({
      10: [100, 1], 11: [500, 2], 30: [200, 1_000], 31: [210, 1_000], 12: [600, 3],
    }));
    expect(out.has(30)).toBe(false);
    expect(out.has(31)).toBe(false);
    expect(out.get(12)).toBe(3n);
  });

  it('skips a process it cannot read but still walks its children', () => {
    const procs = [{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }];
    const out = collectTreeCpuTimes(procs, [10], times({ 10: [100, 1], 12: [120, 3] }));
    expect(out.has(11)).toBe(false);
    expect(out.get(12)).toBe(3n);
  });

  it('terminates on a ppid cycle', () => {
    const procs = [{ pid: 10, ppid: 11 }, { pid: 11, ppid: 10 }];
    const out = collectTreeCpuTimes(procs, [10], times({ 10: [100, 1], 11: [100, 2] }));
    expect(out.size).toBe(2);
  });
});

describe.skipIf(process.platform !== 'win32')('tryProcessCreatedAt (Windows, live)', () => {
  it('orders a parent before the child it spawns, and reads nothing for a pid that is not running', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore', windowsHide: true });
    try {
      await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
      const self = tryProcessCreatedAt(process.pid);
      const spawned = tryProcessCreatedAt(child.pid ?? -1);
      expect(self).not.toBeNull();
      expect(spawned).not.toBeNull();
      expect((spawned ?? 0n) > (self ?? 0n)).toBe(true);
    } finally {
      child.kill();
    }
    expect(tryProcessCreatedAt(0)).toBeNull();
    expect(tryProcessCreatedAt(-1)).toBeNull();
  });
});

// The Defender quarantine byte-matched the exact shell command this module
// replaced. Keeping any spawnable artifact of it in the port-watch path —
// the interpreter path or the enumeration cmdlets — would re-ship the
// signature, so the sources themselves are scanned. (Style precedent:
// installedFonts.test.ts's absolute-path guard and security.test.ts's
// no-spawn guard.)
describe('issue #1051 regression guard', () => {
  const banned = [
    'powershell.exe',
    'windowspowershell',
    'get-ciminstance',
    'get-nettcpconnection',
    'convertto-json',
    '-noprofile',
  ];

  // Resolved from the repo root rather than from `import.meta.url`: the
  // project type-checks as CommonJS, where `import.meta` is a hard tsc error
  // even though vitest itself would happily run it.
  const srcDir = path.join(process.cwd(), 'src', 'main', 'pty');

  it.each(['portWatch.ts', 'winSnapshotNative.ts'])(
    '%s contains no spawnable PowerShell artifact',
    (file) => {
      const full = path.join(srcDir, file);
      // A missing file must fail the guard, never silently pass it.
      expect(fs.existsSync(full), `guard could not find ${full}`).toBe(true);
      const src = fs.readFileSync(full, 'utf-8').toLowerCase();
      for (const token of banned) {
        expect(src).not.toContain(token);
      }
    },
  );
});
