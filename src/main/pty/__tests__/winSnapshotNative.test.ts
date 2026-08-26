import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import {
  decodeTcpTableV4,
  decodeTcpTableV6,
  decodeProcessEntry,
  PROCESSENTRY32W_SIZE,
  TCP_ROW4_SIZE,
  TCP_ROW6_SIZE,
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

  it.each(['portWatch.ts', 'winSnapshotNative.ts'])(
    '%s contains no spawnable PowerShell artifact',
    (file) => {
      const src = fs
        .readFileSync(new URL(`../${file}`, import.meta.url), 'utf-8')
        .toLowerCase();
      for (const token of banned) {
        expect(src).not.toContain(token);
      }
    },
  );
});
