/**
 * The screen `/api/stream` opens with when the ring holds more than the
 * snapshot window (#2125).
 *
 * The raw window (snapshotWindow.ts) cannot paint a fullscreen TUI correctly
 * once its first full draw has scrolled out: Claude Code's renderer repaints by
 * cell diff and skips a cell that already holds the right character, so the
 * window's later frames assume characters it no longer carries (a picker's
 * hint read `Esc to  ancel`). Here the whole ring is parsed by a headless
 * terminal, each stretch at the size it was written at, and the resulting
 * screen is serialized back to plain terminal bytes. The client replays them
 * exactly as it replays the window, so the wire does not change.
 *
 * Cost: one parse of the ring on the shared concurrency-1 snapshot queue (the
 * slot the desktop's attach snapshot and the daemon's screen reads use), under
 * a time budget. Every failure returns the reason instead of a screen, and the
 * caller paints the raw window as before.
 */

import { enqueueSnapshotJob, generateSnapshotUnqueued } from '../HeadlessSnapshot';
import type { RingBuffer } from '../RingBuffer';
import { readRingWithModesAndGeometry } from '../sessionTextReplay';
import type { OutputModeTracker } from '../util/outputModeTracker';

/**
 * Wall-clock budget for the parse, and for the wait for the queue slot. A full
 * 8 MB ring of fullscreen frames parsed in ~140 ms when measured, so this is
 * headroom, and it bounds how long a phone waits for its first paint.
 */
export const STREAM_SCREEN_BUDGET_MS = 2000;

/**
 * Scrollback rows serialized above the screen. About what the 256 KB window
 * carried: 2000 rows of 120-column output serialize to roughly 240 KB.
 */
export const STREAM_SCREEN_SCROLLBACK = 2000;

export interface StreamScreenPane {
  ringBuffer: Pick<RingBuffer, 'readAllWithGeometry'>;
  outputModes: Pick<OutputModeTracker, 'preamble'> | null;
  cols: number;
  rows: number;
}

export type StreamScreen =
  | {
      ok: true;
      /** Plain terminal bytes that paint the screen and its scrollback. */
      payload: Buffer;
      /** The ring's lifetime byte count when it was read: live bytes continue from here. */
      writtenAt: number;
      cols: number;
      rows: number;
    }
  | { ok: false; reason: string };

/**
 * Render the pane's current screen from its whole ring. `gone()` is checked
 * when the slot comes, so a client that left while queued costs no parse.
 * Never rejects.
 */
export function renderStreamScreen(pane: StreamScreenPane, gone: () => boolean): Promise<StreamScreen> {
  const queuedAt = Date.now();
  return enqueueSnapshotJob(async (): Promise<StreamScreen> => {
    if (gone()) return { ok: false, reason: 'gone' };
    if (Date.now() - queuedAt > STREAM_SCREEN_BUDGET_MS) return { ok: false, reason: 'queue-wait' };
    // Read inside the slot: a ring copy taken before queueing would stay
    // pinned for the whole wait.
    const { cols, rows } = pane;
    const { replay, geometry, writtenAt } = readRingWithModesAndGeometry(pane.ringBuffer, pane.outputModes);
    const outcome = await generateSnapshotUnqueued({
      cols,
      rows,
      initial: replay,
      geometry,
      scrollback: STREAM_SCREEN_SCROLLBACK,
      budgetMs: STREAM_SCREEN_BUDGET_MS,
    });
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    return { ok: true, payload: outcome.payload, writtenAt, cols, rows };
  }).catch((err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }));
}
