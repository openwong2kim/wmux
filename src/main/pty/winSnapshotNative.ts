/**
 * In-process Windows process/socket enumeration via koffi FFI (issue #1051).
 *
 * The previous implementation shelled out to Windows PowerShell every 10 s
 * to enumerate every process and every listening socket. From an unsigned
 * executable, that periodic machine-wide sweep through a shell one-liner is
 * a textbook recon-malware behavioral signature — Windows Defender
 * quarantined the whole app over it (the reporter's quarantine log
 * byte-matched our exact command line). Same failure
 * class as GHSA-8fj2-47w9-jxq3 (Norton flagging the old ACL PowerShell path),
 * same fix: remove the spawn entirely rather than soften it.
 *
 * These are the same user-mode APIs the old cmdlets wrapped:
 *  - `GetExtendedTcpTable(TCP_TABLE_OWNER_PID_LISTENER)` for AF_INET and
 *    AF_INET6 — listening sockets with their owning PID.
 *  - `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)` + `Process32First/NextW`
 *    — the pid → ppid table (all `Win32_Process` gave us).
 * Both work unprivileged, in-process, with no child process and no command
 * line for AV heuristics to scan.
 *
 * Failure policy mirrors the port watcher's "quiet absence" contract: any
 * failure returns null and the sidebar simply shows no ports. The two failure
 * kinds are deliberately NOT treated alike:
 *   - A LOAD failure (non-Windows, 32-bit, koffi missing or blocked) cannot
 *     resolve itself, so the path is disabled for the process lifetime.
 *   - A CALL failure is transient by nature (a table churning under load, an
 *     AV briefly interposing), so it is never permanent — pacing retries is
 *     the caller's job (PortWatcher backs off after consecutive failures).
 *     A long-lived daemon must not lose the feature until restart over a
 *     momentary hiccup.
 * There is deliberately NO PowerShell fallback — shipping the old command
 * string would keep the exact bytes Defender signature-matched in our bundles.
 *
 * Cost: the whole snapshot is synchronous, but it is cheap — measured on a
 * 287-process machine at median 5.7 ms / p95 7.3 ms per call, i.e. ~0.06 % of
 * a 10 s tick. That is far below the old path, which forked a PowerShell
 * process costing 1.8–2.3 s of machine time per first spawn (PR #861). If a
 * future caller needs a tighter budget, move the call to a worker thread
 * rather than reintroducing a subprocess.
 *
 * Struct layouts below are the 64-bit ones (ULONG_PTR = 8 bytes). wmux ships
 * x64-only and arm64 shares the layout; on a 32-bit Node this module disables
 * itself instead of reading garbage offsets.
 */

export interface NativeProcRow {
  pid: number;
  ppid: number;
}

export interface NativeConnRow {
  /** Local TCP port (host byte order). */
  port: number;
  /** Owning process id. */
  pid: number;
}

export interface NativeSnapshot {
  procs: NativeProcRow[];
  conns: NativeConnRow[];
}

const AF_INET = 2;
const AF_INET6 = 23;
/** TCP_TABLE_CLASS — listeners only, with owning PID. */
const TCP_TABLE_OWNER_PID_LISTENER = 3;
const ERROR_INSUFFICIENT_BUFFER = 122;
const TH32CS_SNAPPROCESS = 0x00000002;
/** Refuse to allocate a listener table larger than this (see readTcpTable). */
const MAX_TCP_TABLE_BYTES = 64 * 1024 * 1024;

/**
 * sizeof(PROCESSENTRY32W) on 64-bit: 9 DWORD/LONG fields with 4 bytes of
 * padding before the 8-byte th32DefaultHeapID, then WCHAR szExeFile[260],
 * rounded up to 8-byte alignment → 568.
 */
export const PROCESSENTRY32W_SIZE = 568;
const PE32_PID_OFFSET = 8; // th32ProcessID
const PE32_PPID_OFFSET = 32; // th32ParentProcessID

/** MIB_TCPROW_OWNER_PID: 6 DWORDs. Port is the low word, network byte order. */
export const TCP_ROW4_SIZE = 24;
const ROW4_PORT_OFFSET = 8; // dwLocalPort
const ROW4_PID_OFFSET = 20; // dwOwningPid

/**
 * MIB_TCP6ROW_OWNER_PID: ucLocalAddr[16], dwLocalScopeId, dwLocalPort,
 * ucRemoteAddr[16], dwRemoteScopeId, dwRemotePort, dwState, dwOwningPid → 56.
 */
export const TCP_ROW6_SIZE = 56;
const ROW6_PORT_OFFSET = 20; // dwLocalPort
const ROW6_PID_OFFSET = 52; // dwOwningPid

/**
 * Decode a MIB_TCPTABLE_OWNER_PID / MIB_TCP6TABLE_OWNER_PID buffer:
 * DWORD dwNumEntries followed by fixed-size rows. dwLocalPort holds the port
 * in network byte order in its low word, so it is read big-endian. Rows that
 * would run past the buffer are dropped (the table can shrink between the
 * size probe and the fill call).
 */
function decodeTcpTable(
  buf: Buffer,
  rowSize: number,
  portOffset: number,
  pidOffset: number,
): NativeConnRow[] {
  if (buf.length < 4) return [];
  const count = buf.readUInt32LE(0);
  const rows: NativeConnRow[] = [];
  for (let i = 0; i < count; i++) {
    const off = 4 + i * rowSize;
    if (off + rowSize > buf.length) break;
    rows.push({
      port: buf.readUInt16BE(off + portOffset),
      pid: buf.readUInt32LE(off + pidOffset),
    });
  }
  return rows;
}

export function decodeTcpTableV4(buf: Buffer): NativeConnRow[] {
  return decodeTcpTable(buf, TCP_ROW4_SIZE, ROW4_PORT_OFFSET, ROW4_PID_OFFSET);
}

export function decodeTcpTableV6(buf: Buffer): NativeConnRow[] {
  return decodeTcpTable(buf, TCP_ROW6_SIZE, ROW6_PORT_OFFSET, ROW6_PID_OFFSET);
}

/** Decode one PROCESSENTRY32W buffer (64-bit layout). */
export function decodeProcessEntry(buf: Buffer): NativeProcRow {
  return {
    pid: buf.readUInt32LE(PE32_PID_OFFSET),
    ppid: buf.readUInt32LE(PE32_PPID_OFFSET),
  };
}

type Handle = number | bigint;

interface NativeBindings {
  GetExtendedTcpTable: (
    table: Buffer | null,
    size: Buffer,
    order: number,
    af: number,
    tableClass: number,
    reserved: number,
  ) => number;
  CreateToolhelp32Snapshot: (flags: number, pid: number) => Handle;
  Process32FirstW: (snapshot: Handle, entry: Buffer) => number;
  Process32NextW: (snapshot: Handle, entry: Buffer) => number;
  CloseHandle: (handle: Handle) => number;
}

/** undefined = load not attempted yet; null = attempted and unavailable. */
let bindings: NativeBindings | null | undefined;
/** Set only for an unrecoverable LOAD failure — never for a call failure. */
let loadFailed = false;
let consecutiveCallFailures = 0;
/** Stop logging call failures after this many in a row (retries continue). */
const CALL_FAILURE_LOG_LIMIT = 3;
let warnedV6 = false;

function warn(message: string): void {
  // Reaches the daemon's stdout/stderr capture and the dev console alike, so
  // dogfood logs reveal which snapshot path is live.
  console.warn(`[winSnapshotNative] ${message}`);
}

function loadBindings(): NativeBindings | null {
  if (bindings !== undefined) return bindings;
  bindings = null;
  if (process.platform !== 'win32') return null;
  if (process.arch !== 'x64' && process.arch !== 'arm64') {
    warn(`unsupported arch '${process.arch}' — native snapshot disabled`);
    return null;
  }
  try {
    // Runtime require: koffi ships prebuilt Node-API binaries (no compile
    // step) and must stay external to every bundle, resolved from
    // node_modules on disk — same shipping model as node-pty.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi') as {
      load(name: string): {
        func(name: string, result: string, args: string[]): unknown;
      };
    };
    const iphlpapi = koffi.load('iphlpapi.dll');
    const kernel32 = koffi.load('kernel32.dll');
    bindings = {
      GetExtendedTcpTable: iphlpapi.func('GetExtendedTcpTable', 'uint32', [
        'void *', 'void *', 'int', 'uint32', 'uint32', 'uint32',
      ]) as NativeBindings['GetExtendedTcpTable'],
      CreateToolhelp32Snapshot: kernel32.func('CreateToolhelp32Snapshot', 'int64', [
        'uint32', 'uint32',
      ]) as NativeBindings['CreateToolhelp32Snapshot'],
      Process32FirstW: kernel32.func('Process32FirstW', 'int', [
        'int64', 'void *',
      ]) as NativeBindings['Process32FirstW'],
      Process32NextW: kernel32.func('Process32NextW', 'int', [
        'int64', 'void *',
      ]) as NativeBindings['Process32NextW'],
      CloseHandle: kernel32.func('CloseHandle', 'int', ['int64']) as NativeBindings['CloseHandle'],
    };
  } catch (err) {
    warn(`koffi load failed — native snapshot disabled: ${err instanceof Error ? err.message : String(err)}`);
    bindings = null;
  }
  return bindings;
}

/**
 * Read one listener table. The size-probe call (null buffer) reports the
 * required byte count via ERROR_INSUFFICIENT_BUFFER; retry with slack because
 * sockets can appear between the probe and the fill.
 */
function readTcpTable(
  b: NativeBindings,
  family: number,
  decode: (buf: Buffer) => NativeConnRow[],
): NativeConnRow[] {
  const sizeBuf = Buffer.alloc(4);
  let rc = b.GetExtendedTcpTable(null, sizeBuf, 0, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
  for (let attempt = 0; attempt < 4 && rc === ERROR_INSUFFICIENT_BUFFER; attempt++) {
    const needed = sizeBuf.readUInt32LE(0);
    // Sanity-cap before allocating: this length comes from an out-param, and
    // a bogus value (a failed write leaving 0xFFFFFFFF) would otherwise ask
    // for ~4 GB inside the process that relays PTY output. The real listener
    // table is a few KB; the cap is orders of magnitude above any real one.
    if (needed > MAX_TCP_TABLE_BYTES) {
      throw new Error(`GetExtendedTcpTable(af=${family}) reported an implausible size: ${needed}`);
    }
    const table = Buffer.alloc(needed + 4096);
    sizeBuf.writeUInt32LE(table.length, 0);
    rc = b.GetExtendedTcpTable(table, sizeBuf, 0, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
    if (rc === 0) return decode(table);
  }
  throw new Error(`GetExtendedTcpTable(af=${family}) failed: ${rc}`);
}

function readProcessTable(b: NativeBindings): NativeProcRow[] {
  const raw = b.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  const handle = typeof raw === 'bigint' ? raw : BigInt(raw);
  // INVALID_HANDLE_VALUE is -1 read as a signed 64-bit value.
  if (handle === -1n || handle === 0n) {
    throw new Error('CreateToolhelp32Snapshot failed');
  }
  try {
    const entry = Buffer.alloc(PROCESSENTRY32W_SIZE);
    entry.writeUInt32LE(PROCESSENTRY32W_SIZE, 0); // dwSize — required in-param
    const procs: NativeProcRow[] = [];
    let ok = b.Process32FirstW(raw, entry);
    // A zero return here is a FAILURE, not an empty machine — treating it as
    // end-of-list would hand back an empty pid→ppid table that reads as a
    // successful snapshot, and every session's ports would resolve to none.
    if (!ok) throw new Error('Process32FirstW failed — no process table');
    while (ok) {
      procs.push(decodeProcessEntry(entry));
      ok = b.Process32NextW(raw, entry);
    }
    // Self-check: we are always in our own snapshot. This is the cheapest
    // guard that catches a truncated walk AND any future struct-offset drift
    // at runtime rather than only in tests — a wrong pid offset makes this
    // fail loudly instead of silently mis-attributing every port.
    if (!procs.some((p) => p.pid === process.pid)) {
      throw new Error(`process table omits our own pid (${process.pid}) — walk is unreliable`);
    }
    return procs;
  } finally {
    b.CloseHandle(raw);
  }
}

/**
 * Take an in-process snapshot of the machine's pid→ppid table and listening
 * TCP sockets. Returns null when the native path is unavailable (non-Windows,
 * 32-bit, koffi missing/blocked, or repeated call failures) — callers treat
 * that as an empty observation, never as an error.
 */
export function tryNativeSnapshot(): NativeSnapshot | null {
  if (loadFailed) return null;
  const b = loadBindings();
  if (!b) {
    loadFailed = true;
    return null;
  }
  try {
    const conns = readTcpTable(b, AF_INET, decodeTcpTableV4);
    // IPv6 can be administratively disabled; degrade to v4-only rather than
    // failing the whole snapshot. Read INSIDE the try, append OUTSIDE it, so
    // an append-time error can never be misreported as "IPv6 unavailable"
    // and demote the process to v4-only for good.
    let v6: NativeConnRow[] = [];
    try {
      v6 = readTcpTable(b, AF_INET6, decodeTcpTableV6);
    } catch (err) {
      if (!warnedV6) {
        warnedV6 = true;
        warn(`IPv6 listener table unavailable — v4 only: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Not `push(...v6)`: spreading a large table can blow the argument-count
    // limit and throw RangeError.
    for (const row of v6) conns.push(row);
    const procs = readProcessTable(b);
    consecutiveCallFailures = 0;
    return { procs, conns };
  } catch (err) {
    // Transient by assumption — the next tick tries again. Only the log is
    // rate-limited, so a permanently broken call cannot spam the daemon log
    // while still recovering on its own if the condition clears.
    consecutiveCallFailures++;
    if (consecutiveCallFailures <= CALL_FAILURE_LOG_LIMIT) {
      warn(
        `snapshot call failed (${consecutiveCallFailures}): ${err instanceof Error ? err.message : String(err)}` +
        (consecutiveCallFailures === CALL_FAILURE_LOG_LIMIT ? ' — silencing further call-failure logs' : ''),
      );
    }
    return null;
  }
}
