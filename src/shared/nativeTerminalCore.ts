/** Native code is loaded for an explicit backend selection, a Settings availability probe,
 *  or the daemon's Windows process table (src/daemon/nativeProcessTable.ts). */
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { ReplayGeometry } from '../daemon/RingBuffer';

export interface NativeRingStorage {
  readonly size: number;
  readonly allocatedBytes: number;
  readonly totalBytesWritten: number;
  readonly hasGeometryChanges: boolean;
  write(data: Uint8Array): void;
  writeChunk?(chunk: NativeOutputChunk): void;
  clear(): void;
  readAll(): Buffer;
  noteGeometry(cols: number, rows: number): void;
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
  /** Windows only (`process-table-v1`). */
  processTable?(withCommandLines: boolean): Promise<Array<{ pid: number; ppid: number; name: string; created?: number | null; cmdline?: string | null }>>;
}
export interface NativeOscBatch { codes: Float64Array; data: string[] }
export interface NativeOutputInterpreter {
  feed(text: string, streamEndOffset: number, includeOsc: boolean): NativeOscBatch | null;
  feedChunk(chunk: NativeOutputChunk, streamEndOffset: number): NativeOscBatch | null;
  isSet(mode: number): boolean;
  readonly altScreen: boolean;
  preamble(windowStartOffset: number): string;
  reset(): void;
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

export function nativeCorePath(): string {
  const override = process.env.WMUX_TERMINAL_CORE_MODULE ?? process.env.WMUX_RUST_SNAPSHOT_MODULE;
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('Native terminal module path must be absolute');
    return override;
  }
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    ...(resources ? [path.join(resources, 'wmux-native/index.cjs')] : []),
    path.join(__dirname, '../wmux-native/index.cjs'),
    path.join(__dirname, 'wmux-native/index.cjs'),
    path.resolve('core/wmux-term/dist/native-core/index.cjs'),
  ];
  return candidates.find(p => fs.existsSync(p)) ?? candidates[0];
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
