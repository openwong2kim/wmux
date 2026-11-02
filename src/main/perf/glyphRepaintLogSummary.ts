/**
 * glyphRepaintLogSummary — keeps the renderer's per-repaint
 * `[wmux:glyph-repaint]` diagnostic from flooding the persistent log (#3005).
 *
 * The renderer writes one console.debug line per glyph repaint
 * (src/renderer/hooks/useTerminal.ts). The 'console-message' relay in
 * src/main/index.ts writes every renderer line to the log at info, so a few
 * streaming panes wrote about 22k of them an hour. The repaints that follow
 * output (`burst`, and the `settle-verify` that ends each burst) are counted
 * here instead and written as one info line per interval; each one stays a
 * debug line in the renderer's own console. `focus` and `visible` repaints
 * follow a user action, stay rare, and are still logged one by one.
 *
 * Pure logic, no Electron imports: the timer is injectable for tests.
 */

/** Console-line prefix the renderer stamps on every repaint diagnostic. */
export const GLYPH_REPAINT_PREFIX = '[wmux:glyph-repaint]';

/** How long counted repaints accumulate before their one summary line. */
export const GLYPH_REPAINT_SUMMARY_MS = 60_000;

/** The repaint reasons driven by output, counted rather than logged. */
const COUNTED_REASONS: ReadonlySet<string> = new Set(['burst', 'settle-verify']);

export interface GlyphRepaintLogSummary {
  /** True when `message` was counted, so the caller must not log it itself. */
  consume(message: string): boolean;
}

export function createGlyphRepaintLogSummary(
  write: (line: string) => void,
  intervalMs: number = GLYPH_REPAINT_SUMMARY_MS,
  schedule: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms).unref?.(); },
): GlyphRepaintLogSummary {
  // Counts since the first counted line of the open interval; null when none is open.
  let counts: Map<string, number> | null = null;
  const flush = (): void => {
    const open = counts;
    counts = null;
    if (!open) return;
    let total = 0;
    for (const n of open.values()) total += n;
    const byReason = [...open].map(([reason, n]) => `${reason} ${n}`).join(', ');
    write(`${GLYPH_REPAINT_PREFIX} summary: ${total} in ${Math.round(intervalMs / 1000)} s (${byReason})`);
  };
  return {
    consume(message) {
      if (!message.startsWith(GLYPH_REPAINT_PREFIX)) return false;
      const reason = message.slice(GLYPH_REPAINT_PREFIX.length).trim();
      if (!COUNTED_REASONS.has(reason)) return false;
      if (!counts) {
        counts = new Map();
        schedule(flush, intervalMs);
      }
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
      return true;
    },
  };
}
