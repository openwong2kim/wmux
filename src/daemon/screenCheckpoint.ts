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
  /** The most bytes the ring holds before it drops its oldest. */
  readonly totalCapacity: number;
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
  /** Shared by the checkpoints chained from one rebuilt from a wrapped ring: whether that chain asked for a redraw yet. */
  lineage: ScreenRepairLineage;
}

/** A chain of checkpoints from one rebuild: it asks for at most one redraw. */
export interface ScreenRepairLineage {
  nudged: boolean;
}

/** A checkpoint larger than this is not kept (a 200×60 Claude screen is far below it). */
export const SCREEN_CHECKPOINT_MAX_BYTES = 512 * 1024;
/** A new checkpoint once this share of the ring was written since the last one: a busy snapshot queue or a
 *  failed job then has three quarters of the ring before the ring drops the bytes the last one covers. */
const REFRESH_SHARE = 0.25;
/** After a checkpoint that failed or was not kept, the next try waits for this share of the ring, and tries go on
 *  until one is kept: while the last checkpoint's offset is still in the ring, a try still chains from it. */
const RETRY_SHARE = 1 / 16;
/** Failures no later try of the same bytes can avoid (a parse the serializer refuses): back off, doubling from the
 *  refresh interval up to a whole ring, instead of re-parsing the ring every RETRY_SHARE on the shared queue. */
const STRUCTURAL_FAILURES: ReadonlySet<string> = new Set(['margins', 'partial-tail-overflow']);
/** A checkpoint job's parse budget. It holds the shared snapshot slot pane reveals wait on, and a job that
 *  runs out is retried later, so it is kept short (a 4 MiB stretch measured ~25 ms on Rust, ~75 ms on xterm). */
const CHECKPOINT_BUDGET_MS = 1000;

const checkpoints = new WeakMap<CheckpointRing, ScreenCheckpoint>();

/** Daemon-wide counts (memory diagnostics): never terminal contents. */
const counters = {
  /** Checkpoints kept. */
  taken: 0,
  /** Of those, rebuilt from a ring that had dropped bytes no checkpoint covered: their unseen cells stay unknown. */
  rebuiltFromWrappedRing: 0,
  /** Jobs that kept nothing (a parse that failed or ran out of time, an oversized grid, a size or screen change). */
  failed: 0,
  /** Redraws asked of a pane whose rebuilt checkpoint still left part of its composer unseen (screenCheckpointRepair.ts). */
  repairNudges: 0,
};

export function screenCheckpointCounters(): { taken: number; rebuiltFromWrappedRing: number; failed: number; repairNudges: number } {
  return { ...counters };
}

/** Count a redraw asked by the repair. */
export function noteScreenRepairNudge(): void {
  counters.repairNudges++;
}

/** The last try per ring: where, and how much more of the ring the next one waits for. */
const attempts = new WeakMap<CheckpointRing, { at: number; share: number }>();
/** Structural failures in a row, per ring (STRUCTURAL_FAILURES). */
const structural = new WeakMap<CheckpointRing, number>();
const running = new WeakSet<CheckpointRing>();
/** Rings whose checkpoints wait while a repair resizes the pane and back. */
const paused = new WeakSet<CheckpointRing>();

/** Hold (or resume) a ring's checkpoints: a repair's interim size is not the pane's. */
export function pauseScreenCheckpoints(ring: CheckpointRing, pause: boolean): void {
  if (pause) paused.add(ring);
  else paused.delete(ring);
}

type UnseenHandler = (ring: CheckpointRing, lineage: ScreenRepairLineage) => void;
/** Chains the handler was told about. */
const notified = new WeakSet<ScreenRepairLineage>();
let unseenHandler: UnseenHandler | null = null;

/** A repair that gave up (the pane never came to rest): the chain's next checkpoint tells the handler again. */
export function releaseScreenRepairLineage(lineage: ScreenRepairLineage): void {
  notified.delete(lineage);
}

/** Who is told when a kept checkpoint still has unseen cells and its chain has not asked for a redraw (the daemon's repair). */
export function onUnseenScreenCheckpoint(handler: UnseenHandler | null): void {
  unseenHandler = handler;
}

/** The replay of a screen read, and the ring's byte count at the read. */
export interface ScreenReplay {
  replay: Buffer;
  geometry: ReplayGeometry | undefined;
  writtenAt: number;
  /** Cells no byte of the replay wrote carry UNKNOWN_CELL. */
  marked: boolean;
  /** Not from the checkpoint: the ring alone, which had dropped bytes (its first cells are unknown). */
  rebuilt: boolean;
}

/**
 * The bytes that rebuild the visible grid: the checkpoint and the ring's bytes
 * after it when the checkpoint still applies (the ring holds its offset and
 * was not cleared since, the screen is still alternate, no size change at or
 * after its offset: a shrink and a grow back at that very byte leave the same
 * size but drop rows), else the ring led by its
 * mode preamble. `markUnknown`: cells no byte wrote carry UNKNOWN_CELL (a
 * checkpoint's own unknown cells carry it either way). `geometry: false`: the
 * caller parses everything at `size`, so no recorded geometry is returned.
 */
export function screenReplay(
  ring: CheckpointRing,
  modes: CheckpointModes | null,
  size: { cols: number; rows: number },
  opts: { markUnknown?: boolean; geometry?: boolean } = {},
): ScreenReplay {
  const { data, geometry, writtenAt } = ring.readAllWithGeometry();
  const start = writtenAt - data.length;
  const checkpoint = checkpoints.get(ring);
  if (checkpoint && modes?.altScreen && checkpoint.generation === ring.clearGeneration && checkpoint.offset >= start && checkpoint.offset <= writtenAt
    && checkpoint.cols === size.cols && checkpoint.rows === size.rows
    && !(geometry?.changes ?? []).some((change) => start + change.offset >= checkpoint.offset)) {
    // The payload enters the alternate screen and sets its modes itself: no preamble before it.
    const replay = Buffer.concat([checkpoint.payload, data.subarray(checkpoint.offset - start)]);
    return { replay, geometry: undefined, writtenAt, marked: checkpoint.payload.includes(UNKNOWN_CELL), rebuilt: false };
  }
  const preamble = modes?.preamble(start) ?? '';
  const lead = Buffer.from(preamble, 'utf8');
  const read = {
    raw: data,
    replay: lead.length ? Buffer.concat([lead, data]) : data,
    geometry: geometry && { start: geometry.start, changes: geometry.changes.map((c) => ({ ...c, offset: c.offset + lead.length })) },
    writtenAt,
  };
  if (opts.geometry === false) read.geometry = undefined;
  if (!opts.markUnknown) return { replay: read.replay, geometry: read.geometry, writtenAt, marked: false, rebuilt: start > 0 };
  // The fill is drawn at the size the first stretch is parsed at: its recorded one, or `size` without geometry.
  const marked = withUnknownCells(read, size);
  return { replay: marked.replay, geometry: marked.geometry, writtenAt, marked: marked.marked, rebuilt: marked.marked };
}

/**
 * After a ring write: queue a checkpoint when the ring is about to drop bytes
 * the current one does not cover. Off the alternate screen there is none.
 * Cheap: a few comparisons, and one queued job at a time per ring.
 */
export function noteScreenOutput(ring: CheckpointRing, modes: CheckpointModes | null, size: () => { cols: number; rows: number } | null): void {
  if (paused.has(ring)) return;
  if (!modes?.altScreen) {
    checkpoints.delete(ring);
    return;
  }
  const total = ring.totalBytesWritten;
  let current = checkpoints.get(ring);
  // A checkpoint at another size covers nothing (screenReplay will not use it): replace it now.
  const now = size();
  if (current && (!now || now.cols !== current.cols || now.rows !== current.rows || current.generation !== ring.clearGeneration)) {
    checkpoints.delete(ring);
    current = undefined;
  }
  const covered = current?.offset ?? 0;
  const capacity = ring.totalCapacity;
  if (total - covered <= capacity * REFRESH_SHARE || running.has(ring)) return;
  const tried = attempts.get(ring);
  if (tried !== undefined && tried.at > covered && total - tried.at < capacity * tried.share) return;
  attempts.set(ring, { at: total, share: RETRY_SHARE });
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
  const chainedFrom = checkpoints.get(ring);
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
  const now = size();
  // Left the alternate screen or resized while it parsed: the grid no longer applies.
  if (!outcome.ok || outcome.payload.length > SCREEN_CHECKPOINT_MAX_BYTES
    || !modes.altScreen || !now || now.cols !== at.cols || now.rows !== at.rows || ring.clearGeneration !== generation) {
    counters.failed++;
    if (!outcome.ok && STRUCTURAL_FAILURES.has(outcome.reason)) {
      const inARow = (structural.get(ring) ?? 0) + 1;
      structural.set(ring, inARow);
      attempts.set(ring, { at: ring.totalBytesWritten, share: Math.min(1, REFRESH_SHARE * 2 ** (inARow - 1)) });
    }
    return false;
  }
  structural.delete(ring);
  // A checkpoint chained from the last one keeps its chain; one rebuilt from the ring starts a new chain.
  const lineage = !read.rebuilt && chainedFrom && read.marked ? chainedFrom.lineage : { nudged: false };
  checkpoints.set(ring, { offset: read.writtenAt, generation, cols: at.cols, rows: at.rows, payload: outcome.payload, lineage });
  counters.taken++;
  if (read.rebuilt) counters.rebuiltFromWrappedRing++;
  // Once per chain: the handler waits for the pane to come to rest itself.
  if (outcome.payload.includes(UNKNOWN_CELL) && !lineage.nudged && !notified.has(lineage)) {
    notified.add(lineage);
    unseenHandler?.(ring, lineage);
  }
  return true;
}

/** The ring's checkpoint size in bytes, or 0 (diagnostics and tests). */
export function screenCheckpointBytes(ring: CheckpointRing): number {
  return checkpoints.get(ring)?.payload.length ?? 0;
}
