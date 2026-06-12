/**
 * Boot-phase span computation — shared single source of truth for the
 * mark-pair table used by both `scripts/perf-bench.mjs` (cold-start
 * breakdown) and `wmux doctor` (the phase table section).
 *
 * Why this exists: perf-bench is a `.mjs` script and cannot be imported from
 * the TypeScript CLI. The mark-pair definitions (which two boot marks bound
 * each named phase) were duplicated there inline (perf-bench.mjs:958-977).
 * `wmux doctor` needs the identical phase decomposition so its output matches
 * the bench. This module owns the canonical pair table; perf-bench can be
 * migrated onto it in a follow-up, but for now the two MUST agree on the
 * phase *spans* (the from→to deltas) or the doctor table would silently
 * disagree with the bench. The pair labels and mark names here are copied
 * verbatim from perf-bench's console lines.
 *
 * What "agree" does and does NOT cover: spans are origin-invariant — a phase's
 * duration is `to − from`, so any shared timeline origin yields the same span.
 * That is the guarantee. The ABSOLUTE anchor values are NOT guaranteed equal,
 * because the two callers rebase the daemon's epoch marks against different
 * origins: perf-bench rebases against the app-side spawn time `inst.t0` (its
 * daemon anchor row reads "ms since spawn", so `main-start` is the non-zero
 * spawn→main-start gap), whereas doctor rebases against the daemon's own
 * `bootTrace.jsStartEpochMs` (so its `main-start` clamps to ~0). The daemon
 * anchor rows therefore differ row-for-row by a constant spawn-overhead offset
 * even though every span between two daemon marks matches.
 *
 * Mark-coordinate contract: `span(marks, a, b)` treats marks as numbers on a
 * single monotonic timeline (any common origin works — the caller normalizes).
 *  - Main marks come from the `[boot-trace] summary=` log line, where every
 *    mark is already a delta in ms from `js-start` (see
 *    src/main/util/bootTrace.ts `marksAsDeltas`). `js-start` is therefore 0.
 *  - Daemon marks come from `daemon.ping` `bootTrace.marks`, which are absolute
 *    epoch ms; the caller rebases them against `bootTrace.jsStartEpochMs`
 *    first so `main-start` is ~0.
 * The sentinel mark name `'spawn'` resolves to 0 (mirrors perf-bench), letting
 * a phase anchor at process spawn when the caller's origin is spawn time.
 */

/** A named boot phase bounded by two marks. `from`/`to` are mark names; the
 *  special name 'spawn' resolves to 0. `indent` controls table nesting depth
 *  (0 = top-level phase, 1 = sub-phase) so the renderer can indent without
 *  re-deriving the hierarchy. */
export interface PhaseDef {
  label: string;
  from: string;
  to: string;
  indent: 0 | 1 | 2;
}

/**
 * Compute the duration (ms) of the span between mark `a` and mark `b`.
 * Returns null when either endpoint is missing (mark never fired, e.g. the
 * daemon-reuse path skips spawn marks) so callers render "n/a" / "—" rather
 * than a misleading 0 or NaN. The name 'spawn' is the zero origin.
 *
 * Mirrors `scripts/perf-bench.mjs`'s inline `span()` exactly so the doctor
 * table and the bench table never diverge.
 */
export function span(
  marks: Record<string, number>,
  a: string,
  b: string,
): number | null {
  const va = a === 'spawn' ? 0 : marks[a];
  const vb = b === 'spawn' ? 0 : marks[b];
  return typeof va === 'number' && typeof vb === 'number'
    ? Math.round(vb - va)
    : null;
}

/**
 * Main-process boot phases. Labels + mark names lifted verbatim from
 * perf-bench.mjs:958-971. Operates on the main `[boot-trace] summary` marks
 * (deltas from js-start). The 'spawn'→'js-start' pre-JS span is intentionally
 * NOT here because the summary stores pre-JS separately (`preJsMs`); the
 * doctor renders it from that field directly.
 */
export const MAIN_PHASES: readonly PhaseDef[] = [
  { label: 'module imports', from: 'js-start', to: 'imports-done', indent: 0 },
  { label: 'app init', from: 'imports-done', to: 'module-eval-end', indent: 0 },
  { label: 'pty managers', from: 'construction-start', to: 'pre-pipe-server-ctor', indent: 1 },
  { label: 'PipeServer ctor / token ACL', from: 'pre-pipe-server-ctor', to: 'pipe-server-ctor-done', indent: 1 },
  { label: 'handler registration', from: 'pipe-server-ctor-done', to: 'module-eval-end', indent: 1 },
  { label: 'ready wait', from: 'module-eval-end', to: 'ready-fired', indent: 0 },
  { label: 'plugin load', from: 'ready-fired', to: 'plugins-loaded', indent: 0 },
  { label: 'window create', from: 'plugins-loaded', to: 'window-created', indent: 0 },
  { label: 'daemon bootstrap', from: 'daemon-bootstrap-start', to: 'daemon-bootstrap-end', indent: 0 },
  { label: 'spawn call', from: 'daemon-ensure-start', to: 'daemon-spawned', indent: 1 },
  { label: 'daemon boot', from: 'daemon-spawned', to: 'daemon-pipe-file-seen', indent: 1 },
  { label: 'ping latency', from: 'daemon-pipe-file-seen', to: 'daemon-first-ping-ok', indent: 1 },
  { label: 'ready tail', from: 'renderer-load-triggered', to: 'ready-end', indent: 0 },
] as const;

/**
 * Daemon-internal boot phases. Mirrors perf-bench.mjs:975-977 — the daemon's
 * own mark timeline (main-start … ready). Operates on `daemon.ping`
 * bootTrace.marks AFTER the caller rebases them against jsStartEpochMs.
 */
export const DAEMON_PHASES: readonly PhaseDef[] = [
  { label: 'lock acquire', from: 'main-start', to: 'lock-acquired', indent: 0 },
  { label: 'boot id', from: 'lock-acquired', to: 'bootid-done', indent: 0 },
  { label: 'config load', from: 'bootid-done', to: 'config-loaded', indent: 0 },
  { label: 'recovery', from: 'config-loaded', to: 'recovery-done', indent: 0 },
  { label: 'pipe start / token ACL', from: 'pre-pipe-start', to: 'pipe-listening', indent: 0 },
] as const;

/**
 * Ordered list of daemon mark names for the compact "ms since start" line —
 * matches perf-bench.mjs:975. Exposed so the doctor prints the same anchor row.
 */
export const DAEMON_MARK_ORDER: readonly string[] = [
  'main-start',
  'lock-acquired',
  'bootid-done',
  'config-loaded',
  'recovery-done',
  'pre-pipe-start',
  'pipe-listening',
  'ready',
] as const;

/** Shape of the JSON carried by a `[boot-trace] summary=<json>` log line.
 *  See src/main/util/bootTrace.ts `emitBootSummary`. */
export interface BootSummary {
  procCreateEpochMs: number | null;
  jsStartEpochMs: number;
  preJsMs: number | null;
  /** Each value is a delta in ms from js-start. */
  marks: Record<string, number>;
}

/**
 * Parse the LAST `[boot-trace] summary=<json>` line out of a main log file's
 * text. Returns null when no summary line is present (the app may have logged
 * per-mark lines but never reached `emitBootSummary`, or the file predates the
 * instrumentation) — callers render this as SKIP, not FAIL.
 *
 * Scans bottom-up so the freshest boot wins when a log file spans multiple
 * launches in one day. Malformed JSON on the latest matching line falls
 * through to the next-newest candidate rather than throwing.
 */
export function parseBootSummary(logText: string): BootSummary | null {
  const marker = '[boot-trace] summary=';
  const lines = logText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const idx = line.indexOf(marker);
    if (idx === -1) continue;
    const json = line.slice(idx + marker.length).trim();
    try {
      const parsed = JSON.parse(json) as Partial<BootSummary>;
      // Minimal shape validation: jsStartEpochMs + marks must be present and
      // the right types, else this isn't a usable summary.
      if (
        typeof parsed.jsStartEpochMs === 'number' &&
        parsed.marks !== null &&
        typeof parsed.marks === 'object'
      ) {
        return {
          procCreateEpochMs:
            typeof parsed.procCreateEpochMs === 'number' ? parsed.procCreateEpochMs : null,
          jsStartEpochMs: parsed.jsStartEpochMs,
          preJsMs: typeof parsed.preJsMs === 'number' ? parsed.preJsMs : null,
          marks: parsed.marks as Record<string, number>,
        };
      }
    } catch {
      // Truncated/corrupt line — keep scanning older lines.
    }
  }
  return null;
}

/**
 * Rebase absolute-epoch daemon marks (from `daemon.ping` bootTrace.marks)
 * to deltas from the daemon's js-start. Marks at or before jsStart clamp to 0.
 */
export function rebaseDaemonMarks(
  marks: Record<string, number>,
  jsStartEpochMs: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, epoch] of Object.entries(marks)) {
    if (typeof epoch === 'number') out[name] = Math.round(epoch - jsStartEpochMs);
  }
  return out;
}
