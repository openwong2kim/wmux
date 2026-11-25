/**
 * One redraw for a pane whose screen checkpoint was rebuilt from a ring that
 * had already dropped bytes (screenCheckpoint.ts). Cells written before that
 * stay unknown until the TUI writes them again, and Claude Code never
 * rewrites a cell that already holds the right character: the blank rest of
 * its prompt row, the ends of its hint and status rows. Every composer reader
 * then refuses the pane, and nothing the person can type clears it.
 *
 * A resize makes Claude repaint its whole frame. So once the pane is at rest
 * (no turn running, no key typed lately, nothing wmux pasted waiting in it),
 * and its composer is what holds the unseen cells, the pane is resized one
 * column wider and straight back, and a fresh checkpoint is taken from the
 * repaint. One redraw per rebuilt chain: a repaint that still leaves cells
 * unseen is not asked again.
 */

import type { ScreenRepairLineage } from './screenCheckpoint';

export interface ScreenRepairDeps {
  /** The pane is at rest: its agent is Claude, no turn runs, no key was typed lately, no paste of wmux's waits in it. */
  atRest(): boolean;
  /** The composer on screen now holds cells the read could not see (claudeComposerUnseen). */
  composerUnseen(): Promise<boolean>;
  /** The pane's size, as the daemon keeps it (its meta), or null when it is gone. */
  size(): { cols: number; rows: number } | null;
  /** Resize the PTY only (no recorded geometry: the size comes back to where it was). */
  resizePty(cols: number, rows: number): void;
  /** Hold the ring's checkpoints while the PTY is at the interim size, or resume them. */
  pause(paused: boolean): void;
  /** Take a fresh checkpoint now. */
  refresh(): Promise<boolean>;
  delay(ms: number): Promise<void>;
  /** Counted in memory diagnostics (screenCheckpoints.repairNudges). */
  noteNudge(): void;
  log(line: string): void;
}

/** How long the pane stays one column wider: long enough for the TUI to read the size change. */
export const REPAIR_NUDGE_MS = 150;
/** After the size comes back, how long Claude gets to repaint before the fresh checkpoint. */
export const REPAIR_SETTLE_MS = 1000;
/** While the pane is busy, how often it is looked at again, and for how long. */
export const REPAIR_REST_POLL_MS = 30_000;
export const REPAIR_REST_POLLS = 20;

export type ScreenRepairOutcome = 'nudged' | 'not-needed' | 'gave-up';

export async function repairUnseenScreen(lineage: ScreenRepairLineage, deps: ScreenRepairDeps): Promise<ScreenRepairOutcome> {
  for (let poll = 0; poll < REPAIR_REST_POLLS; poll++) {
    if (lineage.nudged) return 'not-needed';
    if (deps.atRest()) {
      if (!(await deps.composerUnseen())) return 'not-needed';
      // The read waited in the snapshot queue: the pane may have moved meanwhile.
      const size = deps.size();
      if (size && deps.atRest() && !lineage.nudged) {
        lineage.nudged = true;
        deps.noteNudge();
        deps.log(`[screen-checkpoint] part of the composer was not seen since the ring was rebuilt: redrawing once (${size.cols + 1}x${size.rows} and back)`);
        deps.pause(true);
        try {
          deps.resizePty(size.cols + 1, size.rows);
          await deps.delay(REPAIR_NUDGE_MS);
        } finally {
          // Back to the size the daemon keeps now (a person may have resized meanwhile), and checkpoints resume.
          const back = deps.size();
          if (back) deps.resizePty(back.cols, back.rows);
          deps.pause(false);
        }
        await deps.delay(REPAIR_SETTLE_MS);
        await deps.refresh().catch(() => false);
        return 'nudged';
      }
    }
    await deps.delay(REPAIR_REST_POLL_MS);
  }
  return 'gave-up';
}
