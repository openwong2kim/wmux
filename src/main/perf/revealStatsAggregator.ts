/**
 * revealStatsAggregator — main-side aggregation of the renderer's
 * `[wmux:reveal]` console diagnostics (P0-5c, `wmux doctor --performance`).
 *
 * The renderer logs one structured line per hidden-pane reveal
 * (src/renderer/hooks/useTerminal.ts), e.g.:
 *
 *   [wmux:reveal] ptyId=abc mechanism=dirty-snapshot recoveredBytes=1234 buffered=0 chunks=0
 *
 * Known mechanisms: retained-catchup | dirty-snapshot | dirty-raw-fallback |
 * dead-snapshot | resync-degraded (the counter keys are whatever the line
 * carries, so new mechanisms surface without a code change here).
 *
 * Main already receives EVERY renderer console line through the webContents
 * 'console-message' relay in src/main/index.ts, so aggregating here needs
 * zero renderer/preload changes. This module is pure logic — no Electron
 * imports — so it stays unit-testable; the exported singleton is what the
 * console relay and the `perf.status` RPC handler share.
 */

/** Console-line prefix the renderer stamps on every reveal diagnostic. */
export const REVEAL_PREFIX = '[wmux:reveal]';

/** Rolling-counter window surfaced as `last5m` (pruned on ingest AND read). */
export const REVEAL_WINDOW_MS = 5 * 60 * 1000;

/** Hard cap on retained window entries — a reveal storm (or a clock that
 *  never advances in a pathological embedder) must stay memory-bounded. */
const MAX_WINDOW_EVENTS = 5000;

/** Cap on the stored raw line so a malformed giant console line can't pin RAM. */
const MAX_RAW_LENGTH = 400;

export interface RevealEvent {
  /** Epoch ms when the line was ingested (main-side clock). */
  at: number;
  ptyId: string | null;
  mechanism: string;
  /** All `key=value` pairs parsed from the line (mechanism/ptyId included). */
  fields: Record<string, string>;
  /** The raw console line, truncated to MAX_RAW_LENGTH. */
  raw: string;
}

export interface RevealStats {
  /** The most recent reveal event, or null if none was seen since boot. */
  last: (RevealEvent & { ageMs: number }) | null;
  /** Per-mechanism counts within the trailing REVEAL_WINDOW_MS. */
  last5m: Record<string, number>;
  /** Per-mechanism counts since main-process boot. */
  sinceBoot: Record<string, number>;
}

/**
 * Parse the `key=value` tokens of a reveal line. Values stop at whitespace or
 * a closing paren so free-text suffixes like `(cooldown, trigger=snapshot)`
 * contribute `trigger=snapshot` without swallowing the `)`.
 */
function parseFields(message: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const re = /([A-Za-z0-9_-]+)=([^\s)]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    fields[m[1]] = m[2];
  }
  return fields;
}

export class RevealStatsAggregator {
  private readonly now: () => number;
  /** Trailing-window entries, oldest first. */
  private window: Array<{ at: number; mechanism: string }> = [];
  private readonly totals = new Map<string, number>();
  private last: RevealEvent | null = null;

  /** `now` is injectable for tests; production uses the wall clock. */
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * Feed one raw renderer console line. Non-reveal lines return false
   * immediately (a cheap startsWith — this runs for every console message).
   */
  ingest(message: string): boolean {
    if (typeof message !== 'string' || !message.startsWith(REVEAL_PREFIX)) return false;
    const fields = parseFields(message.slice(REVEAL_PREFIX.length));
    const mechanism = fields['mechanism'];
    if (!mechanism) return false; // defensive: every emitter carries mechanism=

    const at = this.now();
    this.totals.set(mechanism, (this.totals.get(mechanism) ?? 0) + 1);
    this.window.push({ at, mechanism });
    this.prune(at);
    if (this.window.length > MAX_WINDOW_EVENTS) {
      this.window.splice(0, this.window.length - MAX_WINDOW_EVENTS);
    }
    this.last = {
      at,
      ptyId: fields['ptyId'] ?? null,
      mechanism,
      fields,
      raw: message.length > MAX_RAW_LENGTH ? `${message.slice(0, MAX_RAW_LENGTH)}…` : message,
    };
    return true;
  }

  /** Snapshot the counters. Prunes the rolling window as a side effect. */
  getStats(): RevealStats {
    const now = this.now();
    this.prune(now);

    const last5m: Record<string, number> = {};
    for (const e of this.window) {
      last5m[e.mechanism] = (last5m[e.mechanism] ?? 0) + 1;
    }
    const sinceBoot: Record<string, number> = {};
    for (const [mechanism, count] of this.totals) {
      sinceBoot[mechanism] = count;
    }
    return {
      last: this.last ? { ...this.last, ageMs: Math.max(0, now - this.last.at) } : null,
      last5m,
      sinceBoot,
    };
  }

  /** Drop window entries older than REVEAL_WINDOW_MS relative to `now`. */
  private prune(now: number): void {
    const cutoff = now - REVEAL_WINDOW_MS;
    let firstKept = 0;
    while (firstKept < this.window.length && this.window[firstKept].at <= cutoff) {
      firstKept++;
    }
    if (firstKept > 0) this.window.splice(0, firstKept);
  }
}

/** Process-wide instance shared by the console-message relay and perf.rpc. */
export const revealStatsAggregator = new RevealStatsAggregator();
