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

/** The native input queue takes a write whole or not at all, against its 8 MiB limit
 *  (core/wmux-term/src/native_transport.rs), so held input reaches it in smaller pieces. */
const INPUT_CHUNK_BYTES = 256 * 1024;
/** Small writes held during a stall share one entry, so a burst is a few entries, not millions. */
const INPUT_COALESCE_BYTES = 4 * 1024;
/** Input the adapter holds while the native queue is full. A write is taken whole while less
 *  than this is held, so the bound is this plus the one write that crosses it: a 64 MiB paste
 *  in local mode is held whole, as node-pty never splits a write. Reaching it means the program
 *  has left 16 MiB unread (SessionPipe stops writing at 6 MiB pending; the other writers send
 *  small payloads). From then on every write is dropped whole, logged once, until the held
 *  queue empties, so the program never gets a later write without an earlier one. */
const INPUT_QUEUE_LIMIT = 8 * 1024 * 1024;

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
  /** Input the native queue refused, oldest first; flushed on the writer thread's wakes. */
  private readonly queued: Buffer[] = [];
  private queuedBytes = 0;
  private inputClosed = false;
  /** Set by the first dropped write; held until the queue empties. */
  private dropping = false;
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
  get pendingInputBytes(): number { return this.transport.pendingInputBytes + this.queuedBytes; }
  /** Never throws, as node-pty's write never does: input after exit goes nowhere, and input
   *  the native queue refuses waits here, in order, until the writer thread drains it. */
  write(data: string | Buffer): void {
    if (this.ended) return;
    if (this.handleFlowControl && data === (this.options.flowControlPause ?? '\x13')) { this.pause(); return; }
    if (this.handleFlowControl && data === (this.options.flowControlResume ?? '\x11')) { this.resume(); return; }
    const bytes = typeof data === 'string' ? Buffer.from(data) : data;
    if (this.inputClosed || !bytes.length) return;
    // Take what the writer drained since the last wake before deciding on this write.
    if (this.queued.length) this.flushInput();
    // Behind held input, never ahead of it.
    if (!this.queued.length && bytes.length <= INPUT_CHUNK_BYTES && this.sendInput(bytes)) return;
    if (this.dropping || this.queuedBytes >= INPUT_QUEUE_LIMIT) {
      if (!this.dropping) console.error(`[terminal-core] PTY input: ${INPUT_QUEUE_LIMIT} bytes held unread by the program; dropping input until it reads them`);
      this.dropping = true;
      return;
    }
    // Copied: a caller may reuse its buffer once write returns.
    for (let offset = 0; offset < bytes.length; offset += INPUT_CHUNK_BYTES) {
      const piece = bytes.subarray(offset, offset + INPUT_CHUNK_BYTES);
      const last = this.queued.length - 1;
      if (last >= 0 && this.queued[last].length + piece.length <= INPUT_COALESCE_BYTES) this.queued[last] = Buffer.concat([this.queued[last], piece]);
      else this.queued.push(Buffer.from(piece));
    }
    this.queuedBytes += bytes.length;
    this.flushInput();
  }
  /** False only when the native queue is full. A closed or failed input side drops the
   *  bytes and everything held, as node-pty's write queue does on a non-EAGAIN error. */
  private sendInput(bytes: Buffer): boolean {
    try { this.transport.write(bytes); return true; }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('PTY_BACKPRESSURE')) return false;
      this.inputClosed = true; this.releaseInput();
      if (!message.startsWith('PTY_CLOSED')) console.error('[terminal-core] PTY input failed; dropping input:', message);
      return true;
    }
  }
  private flushInput(): void {
    while (this.queued.length) {
      const head = this.queued[0];
      if (!this.sendInput(head) || this.inputClosed) return;
      this.queued.shift(); this.queuedBytes -= head.length;
    }
    this.dropping = false;
  }
  private releaseInput(): void { this.queued.length = 0; this.queuedBytes = 0; }
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
    this.ended = true; this.releaseInput(); this.transport.close();
    this.data.clear(); this.nativeData.clear(); this.exit.clear(); this.drain.clear();
  }
  private pump(): void {
    if (this.ended) return;
    // The writer thread wakes after every chunk it writes: the drain signal for held input.
    this.flushInput();
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
      if (result.pendingInputBytes + this.queuedBytes < 4 * 1024 * 1024) for (const listener of this.drain) listener();
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
      this.releaseInput();
      this.transport.close();
      for (const listener of this.exit) listener({ exitCode: result.exitCode, ...(result.signal != null ? { signal: result.signal } : {}) });
      this.data.clear(); this.nativeData.clear(); this.exit.clear(); this.drain.clear();
    }
  }
  private fail(): void {
    if (this.ended) return;
    this.ended = true; this.releaseInput();
    console.error('[terminal-core] PTY transport failed; terminating the affected session');
    try { this.transport.close(); } catch { /* A second native exception must not replay the command. */ }
    for (const listener of this.exit) listener({ exitCode: 1 });
    this.data.clear(); this.nativeData.clear(); this.exit.clear(); this.drain.clear();
  }
}
