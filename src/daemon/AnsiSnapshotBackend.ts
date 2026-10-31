import { terminalCoreSelection } from '../shared/terminalCoreSettings';
import type { SnapshotOutcome, SnapshotRequest } from './HeadlessSnapshot';
import { generateRustSnapshot } from './RustSnapshot';
import { withSnapshotShadow } from './SnapshotShadow';

type Reference = (req: SnapshotRequest) => Promise<SnapshotOutcome>;
type Reason = 'native' | 'error' | 'budget' | 'unsupported' | 'limits' | 'state' | 'circuit-open';
interface Diagnostics {
  native: number;
  fallbacks: number;
  skipped: number;
  last?: { backend: 'rust' | 'xterm'; reason: Reason };
}
const diagnostics: Diagnostics = { native: 0, fallbacks: 0, skipped: 0 };
let failedModule: { path: string | undefined } | undefined;

export function getAnsiSnapshotBackendDiagnostics(): Diagnostics & { circuitOpen: boolean } {
  return { ...diagnostics, last: diagnostics.last && { ...diagnostics.last },
    circuitOpen: !!failedModule && failedModule.path === (process.env.WMUX_TERMINAL_CORE_MODULE ?? process.env.WMUX_RUST_SNAPSHOT_MODULE) };
}

/** A full default (8 MiB) ring plus its mode preamble. */
const MAX_INPUT_BYTES = 8 * 1024 * 1024 + 64 * 1024;

/** Sizes the native grid accepts. Its history is capped by RustSnapshot at the
 * grid's cell limit, so the attach's 100k-row scrollback is eligible too. */
function eligible(req: SnapshotRequest): boolean {
  const scrollback = req.scrollback ?? 5000;
  if (req.initial.length > MAX_INPUT_BYTES || !Number.isInteger(scrollback) || scrollback < 0 || scrollback > 100000) return false;
  return [req, ...(req.geometry ? [req.geometry.start, ...req.geometry.changes] : [])].every(({ cols, rows }) =>
    Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && cols <= 1000 && rows >= 1 && rows <= 1000);
}

/** Both backends replay the frozen native history as plain bytes. */
function materialize(req: SnapshotRequest): SnapshotRequest {
  if (!req.nativeSource) return req;
  const prefix = req.initial.length;
  return { ...req, nativeSource: undefined, initial: Buffer.concat([req.initial, req.nativeSource.readAll()]),
    geometry: req.geometry && { start: req.geometry.start, changes: req.geometry.changes.map(change => ({ ...change, offset: change.offset + prefix })) } };
}

/**
 * Rust is the ANSI backend when the terminal engine is rust (or with an
 * explicit WMUX_RUST_SNAPSHOT=ansi|all); `off` keeps xterm. Any refusal,
 * error, invalid result or spent half-budget falls back to xterm on the same
 * bytes, a live tee's drained chunks included.
 */
export async function selectAnsiSnapshot(req: SnapshotRequest, xterm: Reference): Promise<SnapshotOutcome> {
  const input = materialize(req);
  const mode = process.env.WMUX_RUST_SNAPSHOT ?? (terminalCoreSelection() === 'rust' ? 'ansi' : undefined);
  if (mode !== 'ansi' && mode !== 'all') return withSnapshotShadow(input, 'ansi', xterm);
  const modulePath = process.env.WMUX_TERMINAL_CORE_MODULE ?? process.env.WMUX_RUST_SNAPSHOT_MODULE;
  if (failedModule && failedModule.path !== modulePath) failedModule = undefined;
  const skip = !eligible(input) ? 'limits' : failedModule ? 'circuit-open' : undefined;
  if (skip) {
    diagnostics.skipped++;
    diagnostics.last = { backend: 'xterm', reason: skip };
    return xterm(input);
  }
  const budget = input.budgetMs ?? 4000;
  // xterm's own budget check reports where an exhausted parse stopped.
  if (!Number.isFinite(budget) || budget <= 0) return xterm(input);
  const started = performance.now();
  const overBudget = (): SnapshotOutcome =>
    ({ ok: false, reason: 'budget', detail: `backend=rust elapsedMs=${Math.round(performance.now() - started)}` });
  // The tee's drain is destructive. Keep what the candidate takes so a
  // fallback replays exactly those chunks before draining the tee further.
  const source = input.drainQueue;
  const drained: Buffer[] = [];
  let drainedBytes = 0;
  const record = source && ((): Buffer[] => {
    const chunks = source();
    for (const chunk of chunks) { drained.push(chunk); drainedBytes += chunk.length; }
    return chunks;
  });
  let failure: Reason = 'error';
  try {
    // Half of the caller's total budget stays reserved for the fallback.
    const native = await generateRustSnapshot({ ...input, drainQueue: record, budgetMs: budget / 2 }, 'ansi');
    if (native.ok && Buffer.isBuffer(native.payload) && native.bytesIn === input.initial.length + drainedBytes) {
      if (performance.now() - started > budget) return overBudget();
      diagnostics.native++;
      diagnostics.last = { backend: 'rust', reason: 'native' };
      return { ...native, durationMs: performance.now() - started };
    } else if (!native.ok) {
      // Both backends run the same stream trackers on the same bytes, so
      // margins and an oversized partial tail fail the reference identically.
      if (native.reason === 'margins' || native.reason === 'partial-tail-overflow') {
        diagnostics.fallbacks++;
        diagnostics.last = { backend: 'rust', reason: 'unsupported' };
        return native;
      }
      if (native.reason === 'budget') failure = 'budget';
      // The native terminal refuses a stream or grid it cannot replay as
      // xterm would (a divergent control, a reflow, the history cap): the
      // module is sound.
      else if (native.detail?.startsWith('unsupported-state')) failure = 'state';
      else if (native.detail?.startsWith('unsupported-')) failure = 'unsupported';
    }
  } catch { /* Module or disposal errors also use the intact xterm input. */ }
  if (failure === 'error') failedModule = { path: modulePath };
  diagnostics.fallbacks++;
  diagnostics.last = { backend: 'xterm', reason: failure };
  const remaining = budget - (performance.now() - started);
  if (remaining <= 0) return overBudget();
  let replayed = false;
  const replay = source && ((): Buffer[] => {
    if (!replayed) { replayed = true; if (drained.length) return drained; }
    return source();
  });
  const fallback = await xterm({ ...input, drainQueue: replay, budgetMs: remaining });
  return fallback.ok ? { ...fallback, durationMs: performance.now() - started } : fallback;
}
