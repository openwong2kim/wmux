import { SNAPSHOT_MAX_SCROLLBACK } from '../../shared/terminal/attachSnapshot';

/**
 * The renderer's terminal scrollback (Settings › Terminal › scrollback lines)
 * as main last saw it, in a session load or save.
 *
 * The daemon's attach flush rebuilds a pane's screen with this many history
 * rows. Without it, the daemon asks for its 100k-row ceiling, because it can't
 * know the renderer's setting. That ceiling usually exceeds the native
 * snapshot's grid cap, so the snapshot is refused and the whole ring is
 * parsed again by @xterm/headless: about half a second per pane on every
 * reattach. The renderer keeps only its own scrollback anyway, so asking for
 * exactly that loses nothing.
 */
let lines: number | undefined;

export function noteRendererScrollback(data: { scrollbackLines?: unknown } | null | undefined): void {
  const n = data?.scrollbackLines;
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) lines = Math.floor(n);
}

/** Rows of history an attach or its replacing re-flush asks for: the
 * renderer's setting, or the ceiling before main has seen a session. */
export function attachScrollback(): number {
  return lines ?? SNAPSHOT_MAX_SCROLLBACK;
}

/** Tests only. */
export function resetRendererScrollback(): void {
  lines = undefined;
}
