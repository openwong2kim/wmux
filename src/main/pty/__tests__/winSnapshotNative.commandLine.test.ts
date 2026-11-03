import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeCommandLine,
  readProcessCommandLine,
  setNativeBindingsForTests,
  type NativeBindings,
} from '../winSnapshotNative';

const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004 | 0;
const STATUS_ACCESS_DENIED = 0xc0000022 | 0;
const BASE = 0x10000n;

/** A ProcessCommandLineInformation result: header at 0, characters at `at`. */
function commandLineBuffer(text: string, size: number, at = 16, base = BASE): Buffer {
  const buf = Buffer.alloc(size);
  const bytes = Buffer.from(text, 'utf16le');
  buf.writeUInt16LE(bytes.length, 0);
  buf.writeUInt16LE(bytes.length, 2);
  buf.writeBigUInt64LE(base + BigInt(at), 8);
  bytes.copy(buf, at);
  return buf;
}

/**
 * Bindings whose NtQueryInformationProcess answers "too small" until the
 * buffer reaches `needed` bytes, then writes `text` the way the kernel does.
 */
function fakeBindings(text: string, needed: number, opts: { openFails?: boolean; status?: number } = {}) {
  const sizes: number[] = [];
  const closed = vi.fn(() => 1);
  const addresses = new Map<Buffer, bigint>();
  const unused = () => { throw new Error('not used here'); };
  const b = {
    OpenProcess: () => (opts.openFails ? 0n : 99n),
    CloseHandle: closed,
    NtQueryInformationProcess: (_h: unknown, infoClass: number, info: Buffer, length: number, returned: Buffer) => {
      expect(infoClass).toBe(60);
      expect(length).toBe(info.length);
      sizes.push(length);
      if (sizes.length > 50) throw new Error('runaway growth');
      if (opts.status !== undefined) return opts.status;
      if (length < needed) {
        returned.writeUInt32LE(needed, 0);
        return STATUS_INFO_LENGTH_MISMATCH;
      }
      const base = 0x20000n + BigInt(sizes.length) * 0x100000n;
      addresses.set(info, base);
      commandLineBuffer(text, length, 16, base).copy(info);
      return 0;
    },
    addressOf: (buf: Buffer) => addresses.get(buf) ?? 0n,
    GetLastError: () => 0,
    CreateToolhelp32Snapshot: unused,
    Process32FirstW: unused,
    Process32NextW: unused,
    GetExtendedTcpTable: unused,
    GetProcessTimes: unused,
    QueryFullProcessImageNameW: unused,
    TerminateProcess: unused,
    WaitForSingleObject: unused,
    GetSystemTimeAsFileTime: unused,
    GetExitCodeProcess: unused,
  } as unknown as NativeBindings;
  return { b, sizes, closed };
}

afterEach(() => setNativeBindingsForTests(undefined));

describe('decodeCommandLine', () => {
  it('reads the characters the header points at', () => {
    const text = '"C:\\Program Files\\wmux\\wmux.exe" "C:\\wmux\\daemon-bundle\\index.js"';
    expect(decodeCommandLine(commandLineBuffer(text, 512), BASE)).toBe(text);
    // Not necessarily right after the header: the pointer decides.
    expect(decodeCommandLine(commandLineBuffer('node x.js', 512, 64), BASE)).toBe('node x.js');
  });

  it('refuses a string that does not lie inside the buffer', () => {
    // Pointer into the header, before the buffer, or running past its end.
    const intoHeader = Buffer.alloc(512);
    intoHeader.writeUInt16LE(8, 0);
    intoHeader.writeBigUInt64LE(BASE + 8n, 8);
    expect(decodeCommandLine(intoHeader, BASE)).toBeNull();
    expect(decodeCommandLine(commandLineBuffer('node', 512, 16, BASE + 32n), BASE + 64n)).toBeNull();
    const pastEnd = commandLineBuffer('node', 64, 16);
    pastEnd.writeUInt16LE(200, 0);
    expect(decodeCommandLine(pastEnd, BASE)).toBeNull();
  });

  it('reads an empty, odd-length or truncated result as nothing', () => {
    expect(decodeCommandLine(commandLineBuffer('', 64), BASE)).toBeNull();
    const odd = commandLineBuffer('node', 64);
    odd.writeUInt16LE(7, 0);
    expect(decodeCommandLine(odd, BASE)).toBeNull();
    expect(decodeCommandLine(Buffer.alloc(8), BASE)).toBeNull();
  });
});

describe('readProcessCommandLine', () => {
  it('grows the buffer to the reported size, then decodes it and closes the handle', () => {
    const text = `"C:\\wmux\\wmux.exe" ${'x'.repeat(2000)}`;
    const { b, sizes, closed } = fakeBindings(text, 4100);
    setNativeBindingsForTests(b);
    expect(readProcessCommandLine(1234)).toBe(text);
    // 512 is too small; the reported 4100 rounds up to 4104.
    expect(sizes).toEqual([512, 4104]);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('doubles the buffer when the reported size is no help', () => {
    const { b, sizes } = fakeBindings('node x.js', 1500);
    setNativeBindingsForTests({
      ...b,
      NtQueryInformationProcess: (h, c, info, length, returned) => {
        const status = b.NtQueryInformationProcess(h, c, info, length, returned);
        returned.writeUInt32LE(0, 0);
        return status;
      },
    });
    expect(readProcessCommandLine(1234)).toBe('node x.js');
    expect(sizes).toEqual([512, 1024, 2048]);
  });

  it('is null for a failed query, an unopenable process or a bad pid', () => {
    const denied = fakeBindings('node', 0, { status: STATUS_ACCESS_DENIED });
    setNativeBindingsForTests(denied.b);
    expect(readProcessCommandLine(1234)).toBeNull();
    expect(denied.sizes).toEqual([512]);
    expect(denied.closed).toHaveBeenCalledTimes(1);

    const gone = fakeBindings('node', 0, { openFails: true });
    setNativeBindingsForTests(gone.b);
    expect(readProcessCommandLine(1234)).toBeNull();
    expect(gone.sizes).toEqual([]);

    expect(readProcessCommandLine(0)).toBeNull();
  });

  it('stops growing at the cap', () => {
    const { b, sizes } = fakeBindings('node', 0xffffffff);
    setNativeBindingsForTests(b);
    expect(readProcessCommandLine(1234)).toBeNull();
    expect(sizes).toEqual([512, 1 << 20]);
  });
});
