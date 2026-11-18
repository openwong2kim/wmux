import { terminalCoreSelection } from '../shared/terminalCoreSettings';
import type { SnapshotOutcome, SnapshotRequest } from './HeadlessSnapshot';
import { generateRustSnapshot } from './RustSnapshot';
import { snapshotModeOverride } from './snapshotMode';
import { countReason, refusalFamily, type SnapshotReasons } from './snapshotBackendReasons';
import { NATIVE_SNAPSHOT_MAX_INPUT_BYTES, nativeSizesAccepted } from './nativeSnapshotLimits';

type Reference = (req: SnapshotRequest) => Promise<SnapshotOutcome>;
type Reason = 'native' | 'error' | 'budget' | 'unsupported' | 'limits' | 'state' | 'circuit-open';
interface Diagnostics {
  native: number;
  fallbacks: number;
  skipped: number;
  /** Each fallback and skip, by reason (a native refusal by its `unsupported-*` family). */
  reasons: SnapshotReasons;
  /** Per native refusal, every family its stream holds (RustSnapshot's `families`). */
  reasonsSeen: SnapshotReasons;
  last?: { backend: 'rust' | 'xterm'; reason: Reason };
}
const diagnostics: Diagnostics = { native: 0, fallbacks: 0, skipped: 0, reasons: {}, reasonsSeen: {} };
let failedModule: { path: string | undefined } | undefined;

export function getAnsiSnapshotBackendDiagnostics(): Diagnostics & { circuitOpen: boolean } {
  return { ...diagnostics, reasons: { ...diagnostics.reasons }, reasonsSeen: { ...diagnostics.reasonsSeen }, last: diagnostics.last && { ...diagnostics.last },
    circuitOpen: !!failedModule && failedModule.path === (process.env.WMUX_TERMINAL_CORE_MODULE ?? process.env.WMUX_RUST_SNAPSHOT_MODULE) };
}

/** Sizes the native grid accepts, and any ring the daemon allows. Its history
 * is capped by RustSnapshot at the grid's cell limit, so the attach's 100k-row
 * scrollback is eligible too. */
function eligible(req: SnapshotRequest): boolean {
  const scrollback = req.scrollback ?? 5000;
  if (req.initial.length > NATIVE_SNAPSHOT_MAX_INPUT_BYTES || !Number.isInteger(scrollback) || scrollback < 0 || scrollback > 100000) return false;
  return nativeSizesAccepted(req);
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
 * error or invalid result falls back to xterm on the same bytes, a live tee's
 * drained chunks included, with what is left of the budget. Native gets the
 * whole budget: one that spends it ends the snapshot with `budget`.
 */
export async function selectAnsiSnapshot(req: SnapshotRequest, xterm: Reference): Promise<SnapshotOutcome> {
  const input = materialize(req);
  const mode = snapshotModeOverride() ?? (terminalCoreSelection() === 'rust' ? 'ansi' : undefined);
  if (mode !== 'ansi' && mode !== 'all') return xterm(input);
  const modulePath = process.env.WMUX_TERMINAL_CORE_MODULE ?? process.env.WMUX_RUST_SNAPSHOT_MODULE;
  if (failedModule && failedModule.path !== modulePath) failedModule = undefined;
  const skip = !eligible(input) ? 'limits' : failedModule ? 'circuit-open' : undefined;
  if (skip) {
    diagnostics.skipped++;
    countReason(diagnostics.reasons, skip);
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
  let refusal: string | undefined;
  let families: string[] | undefined;
  try {
    // The whole budget: the native path is the one that delivers (R2 b), and
    // a refusal still hands the fallback whatever time is left.
    const native = await generateRustSnapshot({ ...input, drainQueue: record, budgetMs: budget }, 'ansi');
    if (native.ok && Buffer.isBuffer(native.payload) && native.bytesIn === input.initial.length + drainedBytes) {
      // A complete snapshot is delivered even when its serialization (which
      // runs after the last budget check) ends past the deadline: the time is
      // spent either way, and the alternative is no snapshot.
      diagnostics.native++;
      diagnostics.last = { backend: 'rust', reason: 'native' };
      return { ...native, durationMs: performance.now() - started };
    } else if (!native.ok) {
      // Both backends run the same stream trackers on the same bytes, so
      // margins and an oversized partial tail fail the reference identically.
      if (native.reason === 'margins' || native.reason === 'partial-tail-overflow') {
        diagnostics.fallbacks++;
        countReason(diagnostics.reasons, native.reason);
        diagnostics.last = { backend: 'rust', reason: 'unsupported' };
        return native;
      }
      refusal = native.detail;
      families = native.families;
      if (native.reason === 'budget') failure = 'budget';
      // The native terminal refuses a stream or grid it cannot replay as
      // xterm would (a divergent control, a reflow, the history cap): the
      // module is sound.
      else if (native.detail?.startsWith('unsupported-state')) failure = 'state';
      else if (native.detail?.startsWith('unsupported-')) failure = 'unsupported';
    }
  } catch { /* Module or disposal errors also use the intact xterm input. */ }
  if (failure === 'error') failedModule = { path: modulePath };
  const counted = failure === 'state' || failure === 'unsupported' ? refusalFamily(refusal, failure) : failure;
  countReason(diagnostics.reasons, counted);
  // The native list is already families, the reported one first; a module
  // built before it gives none, and the counted family stands alone.
  if (counted.startsWith('unsupported-')) {
    for (const family of new Set([counted, ...(families ?? [])])) countReason(diagnostics.reasonsSeen, family);
  }
  const remaining = budget - (performance.now() - started);
  // Native spent the whole budget, or refused at its very end: no fallback runs.
  if (remaining <= 0) {
    diagnostics.last = { backend: 'rust', reason: failure };
    return overBudget();
  }
  diagnostics.fallbacks++;
  diagnostics.last = { backend: 'xterm', reason: failure };
  let replayed = false;
  const replay = source && ((): Buffer[] => {
    if (!replayed) { replayed = true; if (drained.length) return drained; }
    return source();
  });
  const fallback = await xterm({ ...input, drainQueue: replay, budgetMs: remaining });
  return fallback.ok ? { ...fallback, durationMs: performance.now() - started } : fallback;
}
