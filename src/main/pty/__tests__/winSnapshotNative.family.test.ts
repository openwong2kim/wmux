import { afterEach, describe, expect, it } from 'vitest';
import {
  PROCESSENTRY32W_SIZE,
  decodeProcessName,
  setNativeBindingsForTests,
  tryProcessFamily,
  type NativeBindings,
} from '../winSnapshotNative';

const ERROR_NO_MORE_FILES = 18;

interface Row { pid: number; ppid: number; name: string; created?: bigint }

/** Bindings whose Toolhelp walk lists `rows` (plus this process) and whose creation times are `created`. */
function fakeBindings(rows: Row[]): NativeBindings {
  const all: Row[] = [{ pid: process.pid, ppid: 1, name: 'node.exe', created: 1n }, ...rows];
  let cursor = 0;
  let lastError = 0;
  const write = (entry: Buffer): number => {
    expect(entry.length).toBe(PROCESSENTRY32W_SIZE);
    entry.fill(0, 44);
    entry.writeUInt32LE(all[cursor].pid, 8);
    entry.writeUInt32LE(all[cursor].ppid, 32);
    entry.write(all[cursor].name, 44, 'utf16le');
    return 1;
  };
  const unused = () => { throw new Error('not used here'); };
  return {
    CreateToolhelp32Snapshot: () => 7n,
    Process32FirstW: (_s: unknown, entry: Buffer) => { cursor = 0; return write(entry); },
    Process32NextW: (_s: unknown, entry: Buffer) => {
      cursor++;
      if (cursor >= all.length) { lastError = ERROR_NO_MORE_FILES; return 0; }
      return write(entry);
    },
    GetLastError: () => lastError,
    CloseHandle: () => 1,
    OpenProcess: (_access: number, _inherit: number, pid: number) => {
      const row = all.find((r) => r.pid === pid);
      return row?.created === undefined ? 0n : BigInt(pid);
    },
    GetProcessTimes: (h: unknown, creation: Buffer) => {
      creation.writeBigUInt64LE(all.find((r) => BigInt(r.pid) === h)!.created!, 0);
      return 1;
    },
    GetExtendedTcpTable: unused,
    QueryFullProcessImageNameW: unused,
    TerminateProcess: unused,
    WaitForSingleObject: unused,
    GetSystemTimeAsFileTime: unused,
    GetExitCodeProcess: unused,
    NtQueryInformationProcess: unused,
    addressOf: unused,
  } as unknown as NativeBindings;
}

afterEach(() => setNativeBindingsForTests(undefined));

describe('tryProcessFamily', () => {
  it('returns the root and its direct children with their image names', () => {
    setNativeBindingsForTests(fakeBindings([
      { pid: 100, ppid: 4, name: 'pwsh.exe', created: 50n },
      { pid: 200, ppid: 100, name: 'claude.exe', created: 60n },
      { pid: 210, ppid: 100, name: 'node.exe', created: 70n },
      // A grandchild: run by the agent, not by the shell.
      { pid: 300, ppid: 200, name: 'bash.exe', created: 80n },
    ]));
    expect(tryProcessFamily(100)).toEqual([
      { pid: 100, ppid: 4, name: 'pwsh.exe' },
      { pid: 200, ppid: 100, name: 'claude.exe' },
      { pid: 210, ppid: 100, name: 'node.exe' },
    ]);
  });

  it('leaves out a child older than the root (an orphan of the pid\'s previous owner) or of unknown age', () => {
    setNativeBindingsForTests(fakeBindings([
      { pid: 100, ppid: 4, name: 'pwsh.exe', created: 50n },
      { pid: 200, ppid: 100, name: 'claude.exe', created: 40n },
      { pid: 210, ppid: 100, name: 'codex.exe' },
    ]));
    expect(tryProcessFamily(100)).toEqual([{ pid: 100, ppid: 4, name: 'pwsh.exe' }]);
  });

  it('is null when the root is not running or the walk fails', () => {
    setNativeBindingsForTests(fakeBindings([{ pid: 100, ppid: 4, name: 'pwsh.exe', created: 50n }]));
    expect(tryProcessFamily(999)).toBeNull();
    setNativeBindingsForTests({ ...fakeBindings([]), CreateToolhelp32Snapshot: () => -1n } as NativeBindings);
    expect(tryProcessFamily(100)).toBeNull();
  });

  it('decodes the image name up to its NUL', () => {
    const entry = Buffer.alloc(PROCESSENTRY32W_SIZE, 0x41);
    entry.fill(0, 44);
    entry.write('claude.exe', 44, 'utf16le');
    expect(decodeProcessName(entry)).toBe('claude.exe');
  });
});
