/**
 * Boot-phase timing trace for the main process.
 *
 * Why this exists: cold start (spawn → first PTY data) was a single opaque
 * number — the bench (scripts/perf-bench.mjs) could see WHEN the app became
 * ready but not WHERE the time went (module eval vs app-ready wait vs plugin
 * scan vs daemon bootstrap). This module emits one cheap, always-on stderr
 * line per boot milestone so the bench (and a future `wmux doctor`) can
 * attribute every millisecond of the boot critical path.
 *
 * Design constraints:
 *  - ZERO imports. This module must be the FIRST import of src/main/index.ts
 *    so its module body evaluates before every other LOCAL module body
 *    (Vite/Rollup ESM import hoisting means import order == evaluation
 *    order). Importing anything here would evaluate that dependency first
 *    and skew `js-start`. Note: Rollup hoists EXTERNAL `require()` calls
 *    (electron, node-pty, …) above all module bodies in the flattened
 *    bundle, so `js-start` means "external native modules loaded, first
 *    local code running" — external load cost lands in the pre-JS span
 *    (procCreate → js-start), by design.
 *  - Raw process.stderr.write, never logLine(): marks fire before the log
 *    sink exists. The sink tees stderr to the daily log file once installed,
 *    so post-ready marks land on disk automatically; `emitBootSummary()`
 *    re-emits the full picture after the sink is up so the early marks are
 *    durably captured too.
 *  - Zero telemetry: stderr + local log file only, nothing leaves the machine.
 *
 * Line format (parsed by scripts/perf-bench.mjs — keep stable):
 *   [boot-trace] mark=<name> epoch=<Date.now() ms>
 *   [boot-trace] summary=<json>
 */

/** Process creation time (ms epoch) — Electron extends `process` with this.
 *  `js-start` minus this value = pre-JS tax: exe mapping, Chromium early
 *  init, and any AV scan of the binary before our first line runs. */
const PROC_CREATE_EPOCH_MS: number | null =
  typeof (process as NodeJS.Process & { getCreationTime?: () => number | null })
    .getCreationTime === 'function'
    ? (process as NodeJS.Process & { getCreationTime: () => number | null }).getCreationTime()
    : null;

const JS_START_EPOCH_MS = Date.now();

/** First-occurrence-wins mark store. Respawn paths re-enter ensureDaemon()
 *  long after boot; the trace must describe the BOOT, not the latest retry. */
const marks: Record<string, number> = {};

function emitLine(line: string): void {
  try {
    process.stderr.write(line + '\n');
  } catch {
    /* never break boot for tracing */
  }
}

/**
 * Record a boot milestone and emit it immediately. Idempotent per name —
 * only the first call sticks (and only the first call emits a line).
 * `epochOverride` lets a mark carry a timestamp captured earlier than the
 * call itself (used for js-start, whose moment is the module-level
 * JS_START_EPOCH_MS capture, not the markBoot call at the end of this file).
 */
export function markBoot(name: string, epochOverride?: number): void {
  if (name in marks) return;
  const epoch = epochOverride ?? Date.now();
  marks[name] = epoch;
  emitLine(`[boot-trace] mark=${name} epoch=${epoch}`);
}

/** Marks as deltas (ms) from js-start — the human-readable view. */
function marksAsDeltas(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, epoch] of Object.entries(marks)) {
    out[name] = epoch - JS_START_EPOCH_MS;
  }
  return out;
}

/**
 * Emit the one-line JSON summary. Call at ready-handler end: the log sink
 * tee is installed by then, so this line (unlike the early per-mark lines)
 * lands in %APPDATA%\wmux\logs\main-YYYY-MM-DD.log for postmortems.
 */
export function emitBootSummary(): void {
  try {
    const summary = {
      procCreateEpochMs: PROC_CREATE_EPOCH_MS,
      jsStartEpochMs: JS_START_EPOCH_MS,
      preJsMs: PROC_CREATE_EPOCH_MS != null ? JS_START_EPOCH_MS - PROC_CREATE_EPOCH_MS : null,
      marks: marksAsDeltas(),
    };
    emitLine(`[boot-trace] summary=${JSON.stringify(summary)}`);
  } catch {
    /* never break boot for tracing */
  }
}

/** Accessor for future surfaces (`wmux doctor`, diagnostics RPC). */
export function getBootTrace(): {
  procCreateEpochMs: number | null;
  jsStartEpochMs: number;
  marks: Record<string, number>;
} {
  return {
    procCreateEpochMs: PROC_CREATE_EPOCH_MS,
    jsStartEpochMs: JS_START_EPOCH_MS,
    marks: { ...marks },
  };
}

// Record js-start as a mark too so the bench's mark parser sees the anchor
// without special-casing the summary line. The epoch is the module-level
// JS_START_EPOCH_MS capture (the first JS the main process runs — this module
// is index.ts's first import), not this call's own Date.now().
markBoot('js-start', JS_START_EPOCH_MS);
