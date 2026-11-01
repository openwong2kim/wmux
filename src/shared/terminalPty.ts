import { terminalCoreSelection } from './terminalCoreSettings';
import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty';
import { StringDecoder } from 'node:string_decoder';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadNativeTerminalCore, reportNativeFallback, type NativeTransport, type NativeOutputChunk } from './nativeTerminalCore';

export interface TerminalPty extends IPty {
  readonly backend?: 'node' | 'rust';
  readonly pendingInputBytes?: number;
  onInputDrain?: (listener: () => void) => { dispose(): void };
  onNativeData?: (listener: (chunk: NativeOutputChunk) => void) => { dispose(): void };
  dispose?: () => void;
}
const backends = new WeakMap<IPty, 'node' | 'rust'>();
export const ptyBackend = (pty: IPty): 'node' | 'rust' => backends.get(pty) ?? 'node';
type SpawnOptions = IPtyForkOptions & IWindowsPtyForkOptions & {
  /** The console window's owner, applied before the shell starts (Rust core only). */
  parentWindow?: Buffer;
};

/** Win32 cannot open Electron's virtual ASAR paths. Forge unpacks these assets. */
export function bundledConptyPath(packageFile: string, arch: string): string {
  return path.join(path.dirname(packageFile), 'prebuilds', `win32-${arch}`, 'conpty', 'conpty.dll')
    .replace(/\.asar([\\/])/g, '.asar.unpacked$1');
}

/** Only loader failures are eligible for automatic fallback. Once spawn is
 * attempted, never replay a potentially side-effectful command in node-pty. */
export function spawnTerminalPty(command: string, args: string[], options: SpawnOptions,
  nodeSpawn: (command: string, args: string[], options: SpawnOptions) => IPty): IPty {
  if (terminalCoreSelection() !== 'rust') return nodeSpawn(command, args, options);
  let native;
  try { native = loadNativeTerminalCore('pty-v1'); }
  catch { reportNativeFallback('pty'); return nodeSpawn(command, args, options); }
  const result = new RustPty(command, args, options, native.NativeTransport);
  backends.set(result, 'rust');
  return result;
}

class RustPty implements TerminalPty {
  readonly backend = 'rust';
  readonly pid: number;
  readonly process: string;
  cols: number;
  rows: number;
  handleFlowControl: boolean;
  private readonly transport: NativeTransport;
  private readonly decoder = new StringDecoder('utf8');
  private readonly data = new Set<(data: string) => void>();
  private readonly nativeData = new Set<(chunk: NativeOutputChunk) => void>();
  readonly onNativeData?: TerminalPty['onNativeData'];
  private readonly exit = new Set<(event: { exitCode: number; signal?: number }) => void>();
  private readonly drain = new Set<() => void>();
  private scheduled = false;
  private paused = false;
  private ended = false;
  private readonly wake = () => {
    if (this.scheduled || this.ended) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; this.pump(); });
  };
  readonly onData = (listener: (data: string) => void) => {
    this.data.add(listener); this.wake(); return { dispose: () => { this.data.delete(listener); } };
  };
  readonly onExit = (listener: (event: { exitCode: number; signal?: number }) => void) => {
    this.exit.add(listener); return { dispose: () => { this.exit.delete(listener); } };
  };
  readonly onInputDrain = (listener: () => void) => {
    this.drain.add(listener); return { dispose: () => { this.drain.delete(listener); } };
  };
  constructor(command: string, args: string[], private readonly options: SpawnOptions,
    Constructor: new (command: string, args: string[], cwd: string, env: Record<string, string>, cols: number, rows: number, wake: () => void, conptyDll?: string, parentWindow?: Uint8Array) => NativeTransport) {
    this.cols = options.cols ?? 80; this.rows = options.rows ?? 24;
    this.process = path.basename(command); this.handleFlowControl = options.handleFlowControl ?? false;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env ?? globalThis.process.env)) if (value !== undefined) env[key] = value;
    env.TERM = options.name ?? 'xterm-256color';
    let conptyDll: string | undefined;
    if (globalThis.process.platform === 'win32' && options.useConptyDll) {
      const require = createRequire(path.join(__dirname, 'wmux-pty-assets.cjs'));
      conptyDll = bundledConptyPath(require.resolve('node-pty/package.json'), globalThis.process.arch);
    }
    try { this.transport = new Constructor(command, args, options.cwd ?? globalThis.process.cwd(), env, this.cols, this.rows, this.wake, conptyDll, options.parentWindow); }
    catch (error) { this.ended = true; throw error; }
    this.pid = this.transport.pid;
    // Optional capability keeps older ABI-1 native modules usable.
    if (this.transport.readChunk) this.onNativeData = (listener) => {
      this.nativeData.add(listener); this.wake();
      return { dispose: () => { this.nativeData.delete(listener); } };
    };
  }
  get pendingInputBytes(): number { return this.transport.pendingInputBytes; }
  write(data: string | Buffer): void {
    if (this.ended) throw new Error('PTY_CLOSED');
    if (this.handleFlowControl && data === (this.options.flowControlPause ?? '\x13')) { this.pause(); return; }
    if (this.handleFlowControl && data === (this.options.flowControlResume ?? '\x11')) { this.resume(); return; }
    this.transport.write(typeof data === 'string' ? Buffer.from(data) : data);
  }
  resize(cols: number, rows: number): void {
    this.transport.resize(cols, rows); this.cols = cols; this.rows = rows;
  }
  clear(): void { this.transport.clear(); }
  // The console-window owner, as node-pty's setParentWindow (shared/conptyParentWindow.ts).
  // An older native module without the call reports false.
  setParentWindow(handle: Buffer): boolean {
    if (this.ended) return false;
    return this.transport.setParentWindow?.(handle) ?? false;
  }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; this.wake(); }
  kill(signal?: string): void {
    if (this.ended) return;
    const number = signal === undefined ? undefined : os.constants.signals[signal as keyof typeof os.constants.signals];
    if (signal !== undefined && number === undefined) throw new Error(`Unknown signal: ${signal}`);
    this.transport.kill(number);
  }
  dispose(): void {
    this.ended = true; this.transport.close();
    this.data.clear(); this.nativeData.clear(); this.exit.clear(); this.drain.clear();
  }
  private pump(): void {
    if (this.ended) return;
    let result: Omit<ReturnType<NativeTransport['read']>, 'data'> & { data?: Buffer };
    let chunk: NativeOutputChunk | undefined;
    let bytesRead = 0;
    try {
      if (this.transport.readChunk) {
        const read = this.transport.readChunk(this.paused);
        chunk = read.chunk; bytesRead = read.bytesRead;
        result = read;
      } else result = this.transport.read(this.paused);
    }
    catch { this.fail(); return; }
    try {
      if (result.pendingInputBytes < 4 * 1024 * 1024) for (const listener of this.drain) listener();
      if (chunk) {
        if (chunk.byteLength) {
          for (const listener of this.nativeData) listener(chunk);
          if (this.data.size) { const text = chunk.text; for (const listener of this.data) listener(text); }
        }
        // An incomplete UTF-8 read still consumed a queue entry; keep draining.
        if (bytesRead) this.wake();
      } else if (result.data?.length) {
        const text = this.decoder.write(result.data);
        if (text) for (const listener of this.data) listener(text);
        this.wake();
      }
    } finally { chunk?.dispose(); }
    if (result.error) {
      try { this.transport.kill(globalThis.process.platform === 'win32' ? undefined : os.constants.signals.SIGKILL); }
      catch { this.fail(); return; }
    }
    if (result.childExited && this.paused) { this.paused = false; this.wake(); }
    if (result.exitCode != null) {
      const tail = this.decoder.end();
      if (tail) for (const listener of this.data) listener(tail);
      this.ended = true;
      this.transport.close();
      for (const listener of this.exit) listener({ exitCode: result.exitCode, ...(result.signal != null ? { signal: result.signal } : {}) });
      this.data.clear(); this.nativeData.clear(); this.exit.clear(); this.drain.clear();
    }
  }
  private fail(): void {
    if (this.ended) return;
    this.ended = true;
    console.error('[terminal-core] PTY transport failed; terminating the affected session');
    try { this.transport.close(); } catch { /* A second native exception must not replay the command. */ }
    for (const listener of this.exit) listener({ exitCode: 1 });
    this.data.clear(); this.nativeData.clear(); this.exit.clear(); this.drain.clear();
  }
}
