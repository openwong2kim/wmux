import { terminalCoreSelection } from '../shared/terminalCoreSettings';
/** Experimental text selection, independent of the separately gated ANSI path. */
import type { SnapshotRequest, TextSnapshotOutcome } from './HeadlessSnapshot';
import { generateRustSnapshot } from './RustSnapshot';
import { withSnapshotShadow } from './SnapshotShadow';
import { countReason, refusalFamily, type SnapshotReasons } from './snapshotBackendReasons';

type Reference = (req: SnapshotRequest) => Promise<TextSnapshotOutcome>;
type Reason = 'native' | 'error' | 'budget' | 'live-drain' | 'limits' | 'circuit-open';
interface Diagnostics {
  native: number;
  fallbacks: number;
  skipped: number;
  /** Each fallback and skip, by reason (a native refusal by its `unsupported-*` family). */
  reasons: SnapshotReasons;
  last?: { backend: 'rust' | 'xterm'; reason: Reason };
}
const diagnostics: Diagnostics = { native: 0, fallbacks: 0, skipped: 0, reasons: {} };
let failedModule: { path: string | undefined } | undefined;

export function getTextSnapshotBackendDiagnostics(): Diagnostics & { circuitOpen: boolean } {
  return { ...diagnostics, reasons: { ...diagnostics.reasons }, last: diagnostics.last && { ...diagnostics.last },
    circuitOpen: !!failedModule && failedModule.path === (process.env.WMUX_TERMINAL_CORE_MODULE ?? process.env.WMUX_RUST_SNAPSHOT_MODULE) };
}

export function nativeSnapshotEligible(req: SnapshotRequest): boolean {
  const scrollback = req.scrollback ?? 5000;
  if (inputLength(req) > 8 * 1024 * 1024 || !Number.isInteger(scrollback) || scrollback < 0 || scrollback > 100000) return false;
  return [req, ...(req.geometry ? [req.geometry.start, ...req.geometry.changes] : [])].every(({ cols, rows }) =>
    Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && cols <= 1000 && rows >= 1 && rows <= 1000 && cols * (rows + scrollback) <= 1_000_000);
}

function validText(out: Extract<TextSnapshotOutcome, { ok: true }>, req: SnapshotRequest): boolean {
  return (out.bufferType === 'normal' || out.bufferType === 'alternate') &&
    out.bytesIn === inputLength(req) && Number.isInteger(out.rowsBelowCursor) && out.rowsBelowCursor >= 0 &&
    Array.isArray(out.rows) && out.rows.length <= (req.scrollback ?? 5000) + req.rows &&
    out.rowsBelowCursor <= out.rows.length && out.rows.every(row => row && typeof row.text === 'string' &&
      typeof row.wrapped === 'boolean' && (!req.undimmed || typeof row.undimmed === 'string'));
}

const inputLength = (req: SnapshotRequest) => req.initial.length + (req.nativeSource?.size ?? 0);
function materialize(req: SnapshotRequest): SnapshotRequest {
  if (!req.nativeSource) return req;
  const prefix = req.initial.length;
  return { ...req, nativeSource: undefined, initial: Buffer.concat([req.initial, req.nativeSource.readAll()]),
    geometry: req.geometry && { start: req.geometry.start, changes: req.geometry.changes.map(change => ({ ...change, offset: change.offset + prefix })) } };
}
export async function selectTextSnapshot(req: SnapshotRequest, xterm: Reference): Promise<TextSnapshotOutcome> {
  const reference: Reference = request => xterm(materialize(request));
  const mode = process.env.WMUX_RUST_SNAPSHOT ?? (terminalCoreSelection() === 'rust' ? 'text' : undefined);
  if (mode !== 'text' && mode !== 'all') return withSnapshotShadow(materialize(req), 'text', reference);
  const modulePath = process.env.WMUX_TERMINAL_CORE_MODULE ?? process.env.WMUX_RUST_SNAPSHOT_MODULE;
  if (failedModule && failedModule.path !== modulePath) failedModule = undefined;
  // A failed candidate must not consume the caller's live tee. Read-only ring
  // requests are immutable and can be replayed without retaining a second copy.
  const skip = req.drainQueue ? 'live-drain' : !nativeSnapshotEligible(req) ? 'limits' : failedModule ? 'circuit-open' : undefined;
  if (skip) {
    diagnostics.skipped++;
    countReason(diagnostics.reasons, skip);
    diagnostics.last = { backend: 'xterm', reason: skip };
    return reference(req);
  }
  const started = performance.now();
  const budget = req.budgetMs ?? 4000;
  if (!Number.isFinite(budget) || budget < 0) return reference(req);
  if (budget === 0) return { ok: false, reason: 'budget' };
  let failure: 'error' | 'budget' = 'error';
  let refusal: string | undefined;
  try {
    // Reserve half of the caller's total budget for fallback. Neither retry
    // restarts the original deadline; the shared snapshot queue stays held.
    const native = await generateRustSnapshot({ ...req, budgetMs: budget / 2 }, 'text');
    if (native.ok && validText(native, req)) {
      if (performance.now() - started > budget) return { ok: false, reason: 'budget' };
      diagnostics.native++;
      diagnostics.last = { backend: 'rust', reason: 'native' };
      return { ...native, durationMs: performance.now() - started };
    }
    if (!native.ok && native.reason === 'budget') failure = 'budget';
    if (!native.ok) refusal = native.detail;
  } catch { /* Module or disposal errors also use the intact xterm input. */ }
  if (failure === 'error') failedModule = { path: modulePath };
  diagnostics.fallbacks++;
  countReason(diagnostics.reasons, failure === 'budget' ? failure : refusalFamily(refusal, failure));
  diagnostics.last = { backend: 'xterm', reason: failure };
  const remaining = budget - (performance.now() - started);
  if (remaining <= 0) return { ok: false, reason: 'budget' };
  const result = await reference({ ...req, budgetMs: remaining });
  return result.ok ? { ...result, durationMs: performance.now() - started } : result;
}
