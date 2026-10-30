import { terminalCoreSelection } from '../shared/terminalCoreSettings';
/** Opt-in native snapshot candidate. Text and ANSI have separate delivery
 * gates; unsupported requests retain the reference path. */
import path from 'node:path';
import { createRequire } from 'node:module';
import { nativeCorePath, type NativeFrozenRing } from '../shared/nativeTerminalCore';
import type { SnapshotRequest, SnapshotOutcome, TextSnapshotOutcome } from './HeadlessSnapshot';
import { incompleteUtf8SuffixLength } from './util/ansiStreamScan';

interface NativeTerminal {
  feed(bytes: Uint8Array): void;
  /** ANSI feed; true once the snapshot is refused (stop feeding). */
  feedXterm(bytes: Uint8Array, requestedScrollback: number): boolean;
  feedFrozen(source: NativeFrozenRing, start: number, end: number): void;
  resize(cols: number, rows: number): void;
  textSnapshot(undimmed: boolean): Omit<Extract<TextSnapshotOutcome, { ok: true }>, 'ok' | 'bytesIn' | 'durationMs'>;
  /** Payload with modes, cursor visibility and pending input tail; throws
   * `margins`, `partial-tail-overflow` or an `unsupported-*` refusal. */
  ansiSnapshot(requestedScrollback?: number): Buffer;
  dispose(): void;
}
interface NativeModule {
  nativeCoreAbiVersion(): number;
  nativeCoreCapabilities?(): string[];
  NativeTerminal: new (cols: number, rows: number, scrollback: number) => NativeTerminal;
}
let cached: { file: string; module: NativeModule } | undefined;
const requireNative = createRequire(path.join(process.cwd(), 'wmux-native-loader.cjs'));
function load(): NativeModule {
  const file = terminalCoreSelection() === 'rust' ? nativeCorePath() : process.env.WMUX_RUST_SNAPSHOT_MODULE;
  if (!file || !path.isAbsolute(file)) throw new Error('WMUX_RUST_SNAPSHOT_MODULE must name an absolute native module path');
  if (cached?.file !== file) {
    const module = requireNative(file) as NativeModule;
    if (typeof module.nativeCoreAbiVersion !== 'function' || module.nativeCoreAbiVersion() !== 1 || typeof module.NativeTerminal !== 'function') {
      throw new Error('Native snapshot ABI mismatch; rebuild the native-core module');
    }
    cached = { file, module };
  }
  return cached.module;
}

/** NativeTerminal refuses a grid above four million cells, history included. */
const NATIVE_CELL_LIMIT = 4_000_000;
/** The most history rows the native grid can hold at every size the request replays. */
export function ansiScrollbackCap(req: Pick<SnapshotRequest, 'cols' | 'rows' | 'geometry'>): number {
  const sizes = [req, ...(req.geometry ? [req.geometry.start, ...req.geometry.changes] : [])];
  return Math.min(...sizes.map(({ cols, rows }) => Math.floor(NATIVE_CELL_LIMIT / Math.max(1, cols)) - rows));
}

export function generateRustSnapshot(req: SnapshotRequest, kind: 'ansi'): Promise<SnapshotOutcome>;
export function generateRustSnapshot(req: SnapshotRequest, kind: 'text'): Promise<TextSnapshotOutcome>;
export async function generateRustSnapshot(req: SnapshotRequest, kind: 'ansi' | 'text'): Promise<SnapshotOutcome | TextSnapshotOutcome> {
  const started = performance.now();
  let term: NativeTerminal | undefined;
  try {
    const requested = Number.isFinite(req.scrollback ?? 5000) ? Math.max(0, Math.min(100000, Math.floor(req.scrollback ?? 5000))) : 0;
    let cols = req.geometry?.start.cols ?? req.cols;
    let rows = req.geometry?.start.rows ?? req.rows;
    // An attach asks for 100k rows of history. The native grid allocates rows
    // only as output fills them, so cap it at the grid's cell limit for every
    // recorded size; the snapshot refuses a history that reached the cap.
    const scrollback = kind === 'ansi' ? Math.min(requested, ansiScrollbackCap(req)) : requested;
    const native = load();
    if (kind === 'ansi' && !native.nativeCoreCapabilities?.().includes('ansi-v3')) {
      throw new Error('Native ANSI capability missing; rebuild the native-core module');
    }
    const nativeTerminal = new native.NativeTerminal(cols, rows, scrollback);
    term = nativeTerminal;
    let carry = Buffer.alloc(0);
    let bytesIn = 0;
    // Set once the native terminal refuses the ANSI snapshot: parsing on
    // would only delay the xterm fallback.
    let refused = false;
    const feed = async (raw: Buffer): Promise<boolean> => {
      bytesIn += raw.length;
      if (refused) return true;
      const data = carry.length ? Buffer.concat([carry, raw]) : raw;
      carry = Buffer.alloc(0);
      for (let offset = 0; offset < data.length;) {
        const end = Math.min(offset + 256 * 1024, data.length);
        const pending = incompleteUtf8SuffixLength(data.subarray(offset, end));
        const bytes = data.subarray(offset, end - pending);
        if (end === data.length) { carry = Buffer.from(data.subarray(end - pending)); offset = end; }
        else offset = end - pending;
        if (bytes.length) {
          // The ANSI feed also tracks margins, cursor visibility and the
          // pending tail natively, as ansiStreamScan does for xterm.
          if (kind !== 'ansi') nativeTerminal.feed(bytes);
          else if (nativeTerminal.feedXterm(bytes, requested)) { refused = true; return true; }
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        if (performance.now() - started > (req.budgetMs ?? 4000)) return false;
      }
      return true;
    };
    const resize = (c: number, r: number) => {
      c = Math.max(1, Math.floor(c)); r = Math.max(1, Math.floor(r));
      if (cols !== c || rows !== r) { nativeTerminal.resize(c, r); cols = c; rows = r; }
    };
    if (req.nativeSource) {
      if (kind !== 'text' || req.drainQueue) throw new Error('Native ring replay requires a read-only text request');
      nativeTerminal.feed(req.initial);
      const source = req.nativeSource;
      let position = 0;
      const advance = async (end: number) => {
        while (position < end) {
          const next = Math.min(position + 256 * 1024, end);
          nativeTerminal.feedFrozen(source, position, next);
          position = next;
          await new Promise<void>(resolve => setImmediate(resolve));
          if (performance.now() - started > (req.budgetMs ?? 4000)) return false;
        }
        return true;
      };
      for (const change of req.geometry?.changes ?? []) {
        if (!(await advance(change.offset))) return { ok: false, reason: 'budget' };
        resize(change.cols, change.rows);
      }
      if (!(await advance(source.size))) return { ok: false, reason: 'budget' };
      resize(req.cols, req.rows);
      return { ok: true, ...term.textSnapshot(req.undimmed ?? false), bytesIn: source.size + req.initial.length, durationMs: performance.now() - started };
    }
    let offset = 0;
    for (const change of req.geometry?.changes ?? []) {
      const at = Number.isFinite(change.offset) ? Math.max(offset, Math.min(req.initial.length, Math.floor(change.offset))) : offset;
      if (at > offset && !(await feed(req.initial.subarray(offset, at)))) return { ok: false, reason: 'budget' };
      offset = at; resize(change.cols, change.rows);
    }
    if (offset < req.initial.length && !(await feed(req.initial.subarray(offset)))) return { ok: false, reason: 'budget' };
    resize(req.cols, req.rows);
    for (;;) {
      const chunks = req.drainQueue?.() ?? [];
      if (!chunks.length) break;
      for (const chunk of chunks) if (!(await feed(chunk))) return { ok: false, reason: 'budget' };
    }
    if (kind === 'text') return { ok: true, ...term.textSnapshot(req.undimmed ?? false), bytesIn, durationMs: performance.now() - started };
    let core: Buffer;
    try {
      core = term.ansiSnapshot(requested); // A refusal set while feeding throws here.
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (detail === 'margins' || detail === 'partial-tail-overflow') return { ok: false, reason: detail };
      throw err;
    }
    // An incomplete UTF-8 character at the end goes out raw, as on xterm.
    return { ok: true, payload: Buffer.concat([core, carry]), bytesIn, durationMs: performance.now() - started };
  } catch (err) {
    return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
  } finally { term?.dispose(); }
}
