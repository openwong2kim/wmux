/**
 * One screen checkpoint per output ring, for the screen reads that rebuild a
 * pane's visible grid from its ring (queuedScreenText).
 *
 * A fullscreen TUI (Claude Code) repaints by cell diff: a cell that already
 * holds the right character is never written again. Once the ring drops the
 * bytes that last wrote such a cell, a replay of the ring cannot know it, and
 * it reads blank (outputModeTracker's preamble, "accepted limitation"). The
 * composer's closing rule was one such cell row, and deliveries were refused.
 *
 * Before the ring drops bytes the checkpoint does not cover, the grid is
 * replayed once more (the previous checkpoint and the bytes after it) and
 * serialized as ANSI. A read then replays the checkpoint and only the bytes
 * after it. No parser stays alive between checkpoints: each one is a short
 * job on the shared snapshot queue, and only its serialized grid is kept.
 *
 * A cell the checkpoint cannot vouch for (a first checkpoint taken from a ring
 * that had already dropped bytes) keeps UNKNOWN_CELL, so it stays unknown in
 * every later checkpoint until the TUI writes it.
 *
 * Only on the alternate screen: a shell's normal screen keeps its rows in
 * scrollback, and its reads keep replaying the ring as before.
 */

import type { ReplayGeometry } from './RingBuffer';
import type { OutputModes } from './OutputInterpreter';
import { enqueueSnapshotJob, generateSnapshotUnqueued } from './HeadlessSnapshot';
import { UNKNOWN_CELL, withUnknownCells } from './sessionTextReplay';

/** What a checkpoint needs of a ring (RingBuffer). */
export interface CheckpointRing {
  readAllWithGeometry(): { data: Buffer; geometry: ReplayGeometry | undefined; writtenAt: number };
  readonly totalBytesWritten: number;
  readonly capacityBytes: number;
  /** Bumps on every clear(): the bytes before it are gone though the counter did not move. */
  readonly clearGeneration: number;
  readonly isHibernated?: boolean;
}

type CheckpointModes = Pick<OutputModes, 'altScreen' | 'preamble'>;

interface ScreenCheckpoint {
  /** The ring's lifetime byte count the grid describes. */
  offset: number;
  /** The ring's clear generation at that count: a clear since leaves a hole the replay cannot cross. */
  generation: number;
  cols: number;
  rows: number;
  /** The grid as ANSI (its modes, its alternate screen, its cursor). */
  payload: Buffer;
}

/** A checkpoint larger than this is not kept (a 200×60 Claude screen is far below it). */
export const SCREEN_CHECKPOINT_MAX_BYTES = 512 * 1024;
/** A new checkpoint once this share of the ring was written since the last one: well before the ring drops what it covers. */
const REFRESH_SHARE = 0.5;
/** After a checkpoint that failed or was not kept, the next try waits for this share of the ring. */
const RETRY_SHARE = 0.125;
/** A checkpoint job's parse budget. It holds the shared snapshot slot pane reveals wait on, and a job that
 *  runs out is retried later, so it is kept short (a 4 MiB stretch measured ~25 ms on Rust, ~75 ms on xterm). */
const CHECKPOINT_BUDGET_MS = 1000;

const checkpoints = new WeakMap<CheckpointRing, ScreenCheckpoint>();
const attempts = new WeakMap<CheckpointRing, number>();
const running = new WeakSet<CheckpointRing>();

/** The replay of a screen read, and the ring's byte count at the read. */
export interface ScreenReplay {
  replay: Buffer;
  geometry: ReplayGeometry | undefined;
  writtenAt: number;
  /** Cells no byte of the replay wrote carry UNKNOWN_CELL. */
  marked: boolean;
}

/**
 * The bytes that rebuild the visible grid: the checkpoint and the ring's bytes
 * after it when the checkpoint still applies (the ring holds its offset and
 * was not cleared since, the screen is still alternate, no size change at or
 * after its offset: a shrink and a grow back at that very byte leave the same
 * size but drop rows), else the ring led by its
 * mode preamble. `markUnknown`: cells no byte wrote carry UNKNOWN_CELL (a
 * checkpoint's own unknown cells carry it either way).
 */
export function screenReplay(
  ring: CheckpointRing,
  modes: CheckpointModes | null,
  size: { cols: number; rows: number },
  opts: { markUnknown?: boolean } = {},
): ScreenReplay {
  const { data, geometry, writtenAt } = ring.readAllWithGeometry();
  const start = writtenAt - data.length;
  const checkpoint = checkpoints.get(ring);
  if (checkpoint && modes?.altScreen && checkpoint.generation === ring.clearGeneration && checkpoint.offset >= start && checkpoint.offset <= writtenAt
    && checkpoint.cols === size.cols && checkpoint.rows === size.rows
    && !(geometry?.changes ?? []).some((change) => start + change.offset >= checkpoint.offset)) {
    // The payload enters the alternate screen and sets its modes itself: no preamble before it.
    const replay = Buffer.concat([checkpoint.payload, data.subarray(checkpoint.offset - start)]);
    return { replay, geometry: undefined, writtenAt, marked: checkpoint.payload.includes(UNKNOWN_CELL) };
  }
  const preamble = modes?.preamble(start) ?? '';
  const lead = Buffer.from(preamble, 'utf8');
  const read = {
    raw: data,
    replay: lead.length ? Buffer.concat([lead, data]) : data,
    geometry: geometry && { start: geometry.start, changes: geometry.changes.map((c) => ({ ...c, offset: c.offset + lead.length })) },
    writtenAt,
  };
  if (!opts.markUnknown) return { replay: read.replay, geometry: read.geometry, writtenAt, marked: false };
  const marked = withUnknownCells(read, size);
  return { replay: marked.replay, geometry: marked.geometry, writtenAt, marked: marked.marked };
}

/**
 * After a ring write: queue a checkpoint when the ring is about to drop bytes
 * the current one does not cover. Off the alternate screen there is none.
 * Cheap: a few comparisons, and one queued job at a time per ring.
 */
export function noteScreenOutput(ring: CheckpointRing, modes: CheckpointModes | null, size: () => { cols: number; rows: number } | null): void {
  if (!modes?.altScreen) {
    checkpoints.delete(ring);
    return;
  }
  const total = ring.totalBytesWritten;
  const current = checkpoints.get(ring);
  const covered = current && current.generation === ring.clearGeneration ? current.offset : 0;
  if (total - covered <= ring.capacityBytes * REFRESH_SHARE || running.has(ring)) return;
  const tried = attempts.get(ring);
  if (tried !== undefined && tried > covered && total - tried < ring.capacityBytes * RETRY_SHARE) return;
  attempts.set(ring, total);
  running.add(ring);
  void enqueueSnapshotJob(() => takeScreenCheckpoint(ring, modes, size))
    .catch(() => undefined)
    .finally(() => running.delete(ring));
}

/** Replay the grid and keep it as the ring's checkpoint. True when one was kept. */
export async function takeScreenCheckpoint(
  ring: CheckpointRing,
  modes: CheckpointModes,
  size: () => { cols: number; rows: number } | null,
): Promise<boolean> {
  const at = size();
  if (!at || !modes.altScreen) return false;
  // Read (and copied) before the first await: `writtenAt` names exactly these bytes.
  const generation = ring.clearGeneration;
  const read = screenReplay(ring, modes, at, { markUnknown: true });
  // A ring that failed to wake read only its newest bytes.
  if (ring.isHibernated) return false;
  const outcome = await generateSnapshotUnqueued({
    cols: at.cols,
    rows: at.rows,
    scrollback: 0,
    initial: read.replay,
    geometry: read.geometry,
    budgetMs: CHECKPOINT_BUDGET_MS,
  });
  if (!outcome.ok || outcome.payload.length > SCREEN_CHECKPOINT_MAX_BYTES) return false;
  const now = size();
  // Left the alternate screen or resized while it parsed: the grid no longer applies.
  if (!modes.altScreen || !now || now.cols !== at.cols || now.rows !== at.rows || ring.clearGeneration !== generation) return false;
  checkpoints.set(ring, { offset: read.writtenAt, generation, cols: at.cols, rows: at.rows, payload: outcome.payload });
  return true;
}

/** The ring's checkpoint size in bytes, or 0 (diagnostics and tests). */
export function screenCheckpointBytes(ring: CheckpointRing): number {
  return checkpoints.get(ring)?.payload.length ?? 0;
}
