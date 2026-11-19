/** Native code is loaded for an explicit backend selection, a Settings availability probe,
 *  the daemon's Windows process table (src/daemon/nativeProcessTable.ts), or
 *  PortWatcher's process walk and listening sockets on macOS and Linux (src/main/pty/portWatch.ts). */
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { ReplayGeometry } from '../daemon/RingBuffer';

export interface NativeRingStorage {
  readonly size: number;
  readonly allocatedBytes: number;
  readonly totalBytesWritten: number;
  readonly hasGeometryChanges: boolean;
  /** Whether the newest geometry mark is provisional (see RingBuffer.noteGeometry). Absent on an older core. */
  readonly geometryTailProvisional?: boolean;
  write(data: Uint8Array): void;
  writeChunk?(chunk: NativeOutputChunk): void;
  clear(): void;
  readAll(): Buffer;
  noteGeometry(cols: number, rows: number, applied?: boolean): void;
  /** Absent on an older core. */
  settleGeometry?(): void;
  readAllWithGeometry(): { data: Buffer; writtenAt: number; geometry?: ReplayGeometry | null };
  dispose(): void;
  freeze(): NativeFrozenRing;
}
/** Synchronous delivery only; the owner disposes the chunk after listeners return. */
export interface NativeOutputChunk {
  readonly text: string;
  readonly byteLength: number;
  readBytes(): Buffer;
  dispose(): void;
}
export interface NativeFrozenRing {
  readonly size: number;
  readonly writtenAt: number;
  readonly geometry?: ReplayGeometry | null;
  readAll(): Buffer;
  dispose(): void;
}
export interface NativeTerminalCore {
  nativeTransportWorkerCount(): number;
  nativeCoreAbiVersion(): number;
  nativeCoreCapabilities(): string[];
  NativeRing: new (capacity: number) => NativeRingStorage;
  NativeOutputDecoder?: new () => { feed(bytes: Uint8Array, finish: boolean): NativeOutputChunk };
  NativeOutputInterpreter?: new () => NativeOutputInterpreter;
  NativeTransport: new (command: string, args: string[], cwd: string, env: Record<string, string>, cols: number, rows: number, wake: () => void, conptyDll?: string, parentWindow?: Uint8Array) => NativeTransport;
  /** Windows, macOS and Linux (`process-table-v1`); macOS and Linux read the walk only (no created/cmdline). */
  processTable?(withCommandLines: boolean): Promise<Array<{ pid: number; ppid: number; name: string; created?: number | null; cmdline?: string | null }>>;
  /** macOS and Linux (`listen-sockets-v1`): the process walk and every listening TCP socket this user can read
   *  (one row per socket), from one walk. */
  portSnapshot?(): Promise<{
    processes: Array<{ pid: number; ppid: number; name: string }>;
    sockets: Array<{ pid: number; port: number; address: string; family: number }>;
  }>;
}
export interface NativeOscBatch { codes: Float64Array; data: string[] }
export interface NativeOutputInterpreter {
  feed(text: string, streamEndOffset: number, includeOsc: boolean): NativeOscBatch | null;
  feedChunk(chunk: NativeOutputChunk, streamEndOffset: number): NativeOscBatch | null;
  isSet(mode: number): boolean;
  readonly altScreen: boolean;
  preamble(windowStartOffset: number): string;
  reset(): void;
  /** Drops a half-open OSC (only the OSC state; never allocates). Absent on a module built before it. */
  clearOsc?(): void;
  dispose(): void;
}
export interface NativeTransport {
  readonly pid: number;
  readonly pendingInputBytes: number;
  read(paused?: boolean): { data: Buffer; eof: boolean; childExited: boolean; exitCode?: number | null; signal?: number | null; error?: string | null; pendingInputBytes: number };
  readChunk?(paused?: boolean): Omit<ReturnType<NativeTransport['read']>, 'data'> & { chunk: NativeOutputChunk; bytesRead: number };
  write(data: Uint8Array): void;
  clear(): void;
  /** Absent on a module built before it (see shared/conptyParentWindow.ts). */
  setParentWindow?(handle: Uint8Array): boolean;
  resize(cols: number, rows: number): void;
  kill(signal?: number): void;
  close(): void;
}
const requireNative = createRequire(path.join(process.cwd(), 'wmux-core-loader.cjs'));
let cached: { file: string; module: NativeTerminalCore } | undefined;
const failures = new Set<string>();

/**
 * The module named by WMUX_TERMINAL_CORE_MODULE (absolute), else the first one
 * found where wmux installs it: the packaged app's resources, or beside the
 * bundle (the server runtime, and `npm run build:terminal-core`'s
 * dist/wmux-native for dist bundles). Nothing is looked up from the working
 * directory; a checkout's own build is named with the variable.
 */
export function nativeCorePath(): string {
  const override = process.env.WMUX_TERMINAL_CORE_MODULE ?? process.env.WMUX_RUST_SNAPSHOT_MODULE;
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('Native terminal module path must be absolute');
    return override;
  }
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = nativeCoreCandidates(__dirname, resources);
  return candidates.find(p => fs.existsSync(p)) ?? candidates[0];
}

/** Where nativeCorePath looks, in order, for a loader in `dirname`. */
export function nativeCoreCandidates(dirname: string, resources: string | undefined): string[] {
  const parent = path.dirname(dirname);
  return [
    ...(resources ? [path.join(resources, 'wmux-native/index.cjs')] : []),
    path.join(dirname, '../wmux-native/index.cjs'),
    path.join(dirname, 'wmux-native/index.cjs'),
    // `npm start`: main runs from .vite/build, and the core is staged in
    // dist/wmux-native (as for the dev daemon bundle). Only for that bundle:
    // another one never reaches for a dist folder two levels up.
    ...(path.basename(dirname) === 'build' && path.basename(parent) === '.vite'
      ? [path.join(dirname, '../../dist/wmux-native/index.cjs')] : []),
    // The dev MCP broker (dist/mcp/mcp/broker.js, tsc output): this loader
    // runs from dist/mcp/shared, and the core is staged in dist/wmux-native.
    ...(path.basename(dirname) === 'shared' && path.basename(parent) === 'mcp' && path.basename(path.dirname(parent)) === 'dist'
      ? [path.join(dirname, '../../wmux-native/index.cjs')] : []),
  ];
}

export function loadNativeTerminalCore(capability: string): NativeTerminalCore {
  const file = nativeCorePath();
  if (cached?.file !== file) {
    const module = requireNative(file) as NativeTerminalCore;
    if (typeof module.nativeCoreAbiVersion !== 'function' || module.nativeCoreAbiVersion() !== 1 ||
        typeof module.nativeCoreCapabilities !== 'function') throw new Error('Native terminal core ABI mismatch');
    cached = { file, module };
  }
  if (!cached.module.nativeCoreCapabilities().includes(capability)) throw new Error(`Native terminal core lacks ${capability}`);
  if (capability === 'pty-v1' && (typeof cached.module.NativeTransport !== 'function' || typeof cached.module.NativeRing !== 'function' ||
      !cached.module.nativeCoreCapabilities().includes('ring-v1'))) throw new Error('Native terminal core lacks the combined PTY/ring contract');
  if (capability === 'ring-v1' && typeof cached.module.NativeRing !== 'function') throw new Error('Native terminal core lacks ring storage');
  if (capability === 'output-interpreter-v1' && typeof cached.module.NativeOutputInterpreter !== 'function') throw new Error('Native terminal core lacks output interpretation');
  return cached.module;
}

export function reportNativeFallback(component: string): void {
  if (failures.has(component)) return;
  failures.add(component);
  console.warn(`[terminal-core] ${component}: native module unavailable; using node backend`);
}

/** The `code` a refused native allocation is thrown (or rejected) with (one call, one session). */
export const NATIVE_ALLOC_FAILED_CODE = 'ALLOC_FAILED';

/**
 * The native core refused an allocation for one call: the error carries
 * `code === 'ALLOC_FAILED'`. Only the code decides; the message is diagnostic
 * ("could not allocate <N> bytes for <what>") and may be empty, and a message
 * that merely reads like one is no refusal. Nothing else in the daemon is
 * affected. A ring, transport, decoder or interpreter is left as it was; a
 * NativeTerminal whose grid was refused is unusable afterwards (later calls
 * fail with "unsupported-alloc"), so its owner disposes it.
 */
export function isNativeAllocFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === NATIVE_ALLOC_FAILED_CODE;
}

/** A native error for a log line or a snapshot detail: its message, or its code when the message is empty. */
export function describeNativeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.message) return error.message;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code ? code : error.name;
}

/** At most one line per reporter in this window; the lines in between are counted. */
export const NATIVE_ALLOC_LOG_INTERVAL_MS = 60_000;

/**
 * A rate-limited log line for refused native allocations, one per owner (a
 * session's ring or interpreter). The first refusal logs at once; later ones
 * log at most once per interval, with the count suppressed since. Refusals
 * suppressed inside a window are reported when it ends, even when none
 * follows: one unref'd timer per reporter, armed only while a count is held.
 */
export function createNativeAllocReporter(component: string, label: () => string | undefined,
  log: (line: string) => void = (line) => console.error(line), now: () => number = Date.now): (error: unknown, detail?: string) => void {
  let lastAt = Number.NEGATIVE_INFINITY;
  let suppressed = 0;
  let lastSuppressed = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const describe = (error: unknown, detail: string | undefined): string =>
    `${describeNativeError(error)}${detail ? `; ${detail}` : ''}`;
  const line = (text: string): void => {
    log(`[terminal-core] ${component} session=${label() ?? 'unknown'}: ${text}`);
  };
  const disarm = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const flushSuppressed = (): void => {
    timer = null;
    if (suppressed === 0) return;
    const count = suppressed;
    lastAt = now();
    suppressed = 0;
    line(`${count} more refused since the last line, the last: ${lastSuppressed}`);
  };
  return (error, detail) => {
    const at = now();
    if (at - lastAt < NATIVE_ALLOC_LOG_INTERVAL_MS) {
      suppressed++;
      lastSuppressed = describe(error, detail);
      if (!timer) {
        timer = setTimeout(flushSuppressed, Math.max(0, lastAt + NATIVE_ALLOC_LOG_INTERVAL_MS - at));
        timer.unref?.();
      }
      return;
    }
    const more = suppressed > 0 ? ` (+${suppressed} more since the last line)` : '';
    disarm();
    lastAt = at;
    suppressed = 0;
    line(`${describe(error, detail)}${more}`);
  };
}
