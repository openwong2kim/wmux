import { performance } from 'node:perf_hooks';
import type { TailReadCounters } from '../shared/memoryDiagnostics';
import type { TextSnapshotOutcome, TextSnapshotRow } from './HeadlessSnapshot';
import type { RingBuffer } from './RingBuffer';
import { UNKNOWN_CELL, readRingWithModes, tailCut, withUnknownCells } from './sessionTextReplay';
import { screenCheckpointBytes, screenReplay, takeScreenCheckpoint, type CheckpointRing } from './screenCheckpoint';
import { enqueueSnapshotJob } from './HeadlessSnapshot';
import { TailHazardScan, type TailHazard } from './tailHazards';
import type { OutputModeTracker } from './util/outputModeTracker';

/**
 * A screen read from the ring's newest bytes only, served when nothing says
 * it differs from the whole ring's replay, else answered by that replay.
 *
 * Replaying a pane's whole 8 MiB ring costs ~90 ms; its newest 256 KiB, ~2 ms.
 * The tail is guarded two ways. Before parsing, a hazard the tail cannot see
 * (tailHazards.ts: a screen switch inside it, margins or a character set left
 * on before it, ...) sends the read to the whole ring. After parsing, any cell
 * no byte of the tail wrote (withUnknownCells) in the rows the caller gets
 * does too. A fallback replays the same ring copy, in the same queue job, so
 * it is the answer the whole-ring read would have given at the same fence.
 *
 * For readers that only display or estimate (Fleet's preview, StallWatch).
 * Safety gates keep reading the whole ring: the caller picks a separate read
 * kind, so a tail answer is never cached or joined under a whole-ring kind.
 *
 * A read of the visible screen only (variant 'screen') falls back to the
 * screen read queuedScreenText makes instead: the ring's screen checkpoint
 * and the bytes after it when one applies (screenCheckpoint.ts), else the
 * whole ring. A Claude Code pane misses the tail on every read, and parsing
 * its whole 8 MiB ring each StallWatch cycle kept a box daemon's memory up;
 * the checkpoint bounds that parse to its grid and at most a quarter of the
 * ring, and holds no history the screen does not show.
 */

export const TAIL_BYTES = 256 * 1024;
/** How far past the byte budget's edge a tail still looks for a line start. */
const TAIL_LINE_WITHIN = 16 * 1024;
/** The real-data check compares a served answer with the whole ring's at most this often per pane, */
export const TAIL_CHECK_INTERVAL_MS = 10 * 60_000;
/** and at most this often across panes, so a daemon start doesn't stack one extra whole-ring parse per pane. */
export const TAIL_CHECK_SPACING_MS = 10_000;

/**
 * After this many tail misses in a row on a session (a tail parse that left a
 * visible cell unknown), that reader stops trying the tail there. A failed
 * parse (a budget timeout under load) is not a miss: it says nothing about the pane.
 * A Claude Code pane repaints its static rows by position, so they sit before
 * the cut and every tail read misses: each read paid the tail parse and then
 * the whole ring's. A stopgap until each reader asks for only the rows it needs.
 */
export const TAIL_MISS_CAP = 3;
/** A capped reader tries the tail once more when output resumes after this long without any: the app may have redrawn. */
export const TAIL_QUIET_RETRY_MS = 60_000;

export type TailSite = 'fleet' | 'stallwatch';
export type TailFallbackReason = TailHazard | 'no-modes' | 'unknown-visible' | 'tail-failed';
/** `via` says which replay answered: the tail, or the whole ring. */
export type TailOutcome = TextSnapshotOutcome & { via: 'tail' | 'full' };
/** A site's decision inputs, compared by the real-data check. Values never leave this module. */
export type TailInputs = (rows: readonly string[]) => Readonly<Record<string, boolean | string | undefined>>;

export interface GuardedTailSession {
  meta: { cols: number; rows: number };
  /** A whole RingBuffer (a CheckpointRing too) lets a screen read fall back to its checkpoint. */
  ringBuffer: Pick<RingBuffer, 'readAll' | 'totalBytesWritten'> & Partial<CheckpointRing>;
  bridge: { readonly outputModes: (Pick<OutputModeTracker, 'preamble'> & { readonly altScreen?: boolean }) | null };
}

/** The variant that reads the visible screen only (no scrollback): its fallback is the checkpoint-backed screen read. */
const SCREEN_VARIANT = 'screen';

function checkpointRing(ring: GuardedTailSession['ringBuffer']): CheckpointRing | null {
  return typeof ring.readAllWithGeometry === 'function' && typeof ring.clearGeneration === 'number' && typeof ring.totalCapacity === 'number'
    ? (ring as CheckpointRing)
    : null;
}

/**
 * A screen read whose checkpoint is followed by more than this many bytes
 * asks for a newer checkpoint, so the next read parses its grid and little
 * more. The ring's own refresh waits for a quarter of the ring (2 MiB of an
 * 8 MiB one), which a spinner that writes a few KB a second takes many
 * minutes to reach, and every read in between parses all of it again.
 */
export const SCREEN_REFRESH_BYTES = TAIL_BYTES;
/** Per ring: a refresh queued or running, where the last one was asked, and the output the next one waits for. */
const refreshing = new WeakSet<CheckpointRing>();
const refreshes = new WeakMap<CheckpointRing, { at: number; gap: number }>();

export type CheckpointModesOf = Parameters<typeof takeScreenCheckpoint>[1];

/**
 * After a screen read from the checkpoint with more than SCREEN_REFRESH_BYTES
 * after its grid: queue a newer checkpoint behind the read. One per ring at a
 * time; a refresh that keeps nothing doubles the output the next one waits
 * for, up to the whole ring, so a grid that cannot be kept is not re-parsed
 * on every read.
 */
export function refreshScreenCheckpoint(
  ring: CheckpointRing,
  modes: CheckpointModesOf,
  size: () => { cols: number; rows: number } | null,
  read: { replayBytes: number; writtenAt: number; rebuilt: boolean },
): void {
  const grid = screenCheckpointBytes(ring);
  // From a checkpoint (not rebuilt from the ring), with more than a refresh's worth after its grid.
  if (read.rebuilt || grid === 0 || read.replayBytes - grid <= SCREEN_REFRESH_BYTES || refreshing.has(ring)) return;
  const last = refreshes.get(ring);
  if (last && read.writtenAt - last.at < last.gap) return;
  refreshing.add(ring);
  const gap = last?.gap ?? SCREEN_REFRESH_BYTES;
  void enqueueSnapshotJob(() => takeScreenCheckpoint(ring, modes, size))
    .catch(() => false)
    .then((kept) => refreshes.set(ring, { at: read.writtenAt, gap: kept ? SCREEN_REFRESH_BYTES : Math.min(ring.totalCapacity, gap * 2) }))
    .finally(() => refreshing.delete(ring));
}

/** An unknown cell as every plain screen reader sees one (queuedScreenText): a blank, trailing spaces trimmed. */
function blankUnknown(outcome: TextSnapshotOutcome): TextSnapshotOutcome {
  if (!outcome.ok) return outcome;
  const blank = (text: string): string => (text.includes(UNKNOWN_CELL) ? text.split(UNKNOWN_CELL).join(' ').replace(/ +$/, '') : text);
  return { ...outcome, rows: outcome.rows.map((row) => ({ ...row, text: blank(row.text), ...(row.undimmed !== undefined ? { undimmed: blank(row.undimmed) } : {}) })) };
}

export interface GuardedTailOptions {
  site: TailSite;
  /** Which request of the site this is (its scrollback): misses are counted per site and variant. */
  variant?: string;
  /** The caller's parse: the same request the whole-ring read makes, given its bytes. */
  parse: (initial: Buffer) => Promise<TextSnapshotOutcome>;
  inputs?: TailInputs;
}

const scans = new WeakMap<GuardedTailSession, TailHazardScan>();
/**
 * Per session, site and variant: misses in a row, the pane at the last miss,
 * and when its output last moved as the reads saw it.
 */
interface MissRun { misses: number; cols: number; rows: number; writtenAt: number; seenWrittenAt: number; seenMovedAt: number }
const missRuns = new WeakMap<GuardedTailSession, Map<string, MissRun>>();
const runKey = (options: GuardedTailOptions) => `${options.site}:${options.variant ?? ''}`;

function noteMiss(session: GuardedTailSession, key: string, cols: number, rows: number, writtenAt: number): void {
  let runs = missRuns.get(session);
  if (!runs) missRuns.set(session, (runs = new Map()));
  const run = runs.get(key);
  runs.set(key, { misses: (run?.misses ?? 0) + 1, cols, rows, writtenAt, seenWrittenAt: writtenAt, seenMovedAt: Date.now() });
}

/**
 * Whether a capped reader tries the tail again: the pane was resized, the tail
 * window has turned over (a whole tail's worth of new bytes), or output moved
 * again after a long stretch without any. Reading a pane that is still quiet
 * would only miss again.
 */
function retriesTail(run: MissRun, cols: number, rows: number, writtenAt: number): boolean {
  if (cols !== run.cols || rows !== run.rows) return true;
  if (writtenAt - run.writtenAt >= TAIL_BYTES) return true;
  if (writtenAt === run.seenWrittenAt) return false;
  const now = Date.now();
  const resumed = now - run.seenMovedAt >= TAIL_QUIET_RETRY_MS;
  run.seenWrittenAt = writtenAt;
  run.seenMovedAt = now;
  return resumed;
}
const lastCheck = new WeakMap<GuardedTailSession, number>();
let lastAnyCheck = Number.NEGATIVE_INFINITY;
const counters = new Map<TailSite, TailReadCounters>();

function siteCounters(site: TailSite): TailReadCounters {
  let c = counters.get(site);
  if (!c) {
    counters.set(site, (c = {
      reads: 0, served: 0, whole: 0, fallbacks: {}, skipped: 0, tailMsTotal: 0, tailMsMax: 0, fallbackMsTotal: 0, fallbackMsMax: 0,
      ringCopyMsTotal: 0, ringCopyMsMax: 0, scanMsTotal: 0, scanMsMax: 0, scanBytes: 0, checks: 0, mismatches: {},
    }));
  }
  return c;
}

type TimedKey = 'tailMs' | 'fallbackMs' | 'ringCopyMs' | 'scanMs';
function time(c: TailReadCounters, key: TimedKey, ms: number): void {
  c[`${key}Total`] += ms;
  c[`${key}Max`] = Math.max(c[`${key}Max`], ms);
}

function bump(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

/** Run inside the snapshot slot. Copies the ring before its first await, like the whole-ring reads. */
export async function guardedTailRead(session: GuardedTailSession, options: GuardedTailOptions): Promise<TailOutcome> {
  const c = siteCounters(options.site);
  c.reads++;
  const started = performance.now();
  const modes = session.bridge.outputModes;
  // Dims backstop as the whole-ring reads have: a recovered session may not have real dims yet.
  const cols = session.meta.cols ?? 80;
  const rows = session.meta.rows ?? 24;
  const ring = options.variant === SCREEN_VARIANT ? checkpointRing(session.ringBuffer) : null;
  // The fallback's bytes, read in this same step as the tail's: a screen read's from its checkpoint
  // (queuedScreenText's own read, parsed at the current size), any other read's the whole ring and its preamble.
  // The modes are read live: a checkpoint job checks the screen again once it has parsed.
  const screenModes: CheckpointModesOf | null = modes ? { get altScreen() { return modes.altScreen === true; }, preamble: (at) => modes.preamble(at) } : null;
  const screen = ring ? screenReplay(ring, screenModes, { cols, rows }, { geometry: false }) : null;
  const data = session.ringBuffer.readAll();
  const writtenAt = session.ringBuffer.totalBytesWritten;
  const ringStart = writtenAt - data.length;
  const full = screen ? null : readRingWithModes({ readAll: () => data, totalBytesWritten: writtenAt }, modes).replay;
  const wholeReplay = (): Buffer => full ?? readRingWithModes({ readAll: () => data, totalBytesWritten: writtenAt }, modes).replay;
  time(c, 'ringCopyMs', performance.now() - started);
  /** The fallback's answer: the screen read's (its unknown cells blanked), or the whole ring's. */
  const parseFallback = async (): Promise<TextSnapshotOutcome> => {
    if (!screen) return options.parse(wholeReplay());
    const answer = await options.parse(screen.replay);
    if (ring && screenModes) {
      // At the size the screen reads use (the pane's recorded one), as the daemon's repair refreshes it.
      refreshScreenCheckpoint(ring, screenModes, () => (session.meta.cols > 0 && session.meta.rows > 0 ? { cols: session.meta.cols, rows: session.meta.rows } : null),
        { replayBytes: screen.replay.length, writtenAt: screen.writtenAt, rebuilt: screen.rebuilt });
    }
    return screen.marked ? blankUnknown(answer) : answer;
  };

  /** The whole ring's answer: after a fallback for `reason`, or (none) a capped reader's skip. */
  const fallback = async (reason: TailFallbackReason | null): Promise<TailOutcome> => {
    // A skip tried no tail: its time stays out of the tail average, whose
    // count leaves skips out too.
    if (reason) {
      bump(c.fallbacks, reason);
      time(c, 'tailMs', performance.now() - started);
    } else {
      c.skipped = (c.skipped ?? 0) + 1;
    }
    const at = performance.now();
    const answer = await parseFallback();
    time(c, 'fallbackMs', performance.now() - at);
    return { ...answer, via: 'full' };
  };

  // A TUI that repaints by position writes few line feeds: one far past the
  // edge would leave almost nothing to replay, so start at an escape instead.
  const cut = tailCut(data, TAIL_BYTES, TAIL_LINE_WITHIN);
  if (cut === 0) {
    // The whole ring fits: the tail is the whole replay.
    const answer = await options.parse(wholeReplay());
    c.whole++;
    time(c, 'tailMs', performance.now() - started);
    return { ...answer, via: 'tail' };
  }
  if (!modes) return fallback('no-modes');

  const key = runKey(options);
  const run = missRuns.get(session)?.get(key);
  // Capped: straight to the whole ring, without the scan or the tail parse.
  if (run && run.misses >= TAIL_MISS_CAP && !retriesTail(run, cols, rows, writtenAt)) return fallback(null);

  const scanStarted = performance.now();
  let scan = scans.get(session);
  if (!scan) scans.set(session, (scan = new TailHazardScan()));
  const { hazard, scanned } = scan.check(data, writtenAt, ringStart + cut, rows);
  c.scanBytes += scanned;
  time(c, 'scanMs', performance.now() - scanStarted);
  if (hazard) return fallback(hazard);

  const raw = data.subarray(cut);
  const lead = modes.preamble(ringStart + cut);
  const { replay } = withUnknownCells(
    { raw, replay: lead ? Buffer.concat([Buffer.from(lead, 'utf8'), raw]) : raw, geometry: undefined, writtenAt },
    { cols, rows },
  );
  const tail = await options.parse(replay);
  if (!tail.ok) return fallback('tail-failed');
  if (tail.rows.some((row) => row.text.includes(UNKNOWN_CELL))) {
    noteMiss(session, key, cols, rows, writtenAt);
    return fallback('unknown-visible');
  }
  missRuns.get(session)?.delete(key);
  c.served++;
  time(c, 'tailMs', performance.now() - started);

  const now = Date.now();
  const checkedAt = lastCheck.get(session);
  if ((checkedAt === undefined || now - checkedAt >= TAIL_CHECK_INTERVAL_MS) && now - lastAnyCheck >= TAIL_CHECK_SPACING_MS) {
    lastCheck.set(session, now);
    lastAnyCheck = now;
    c.checks++;
    // The check never changes the answer: a failure is counted, not thrown.
    try { compare(c, tail, await parseFallback(), rows, options.inputs); } catch { bump(c.mismatches, 'check-failed'); }
  }
  return { ...tail, via: 'tail' };
}

function differ(a: readonly TextSnapshotRow[], b: readonly TextSnapshotRow[]): boolean {
  return a.length !== b.length || a.some((row, i) => row.text !== b[i].text || row.wrapped !== b[i].wrapped);
}

/** Counts what differs between a served tail answer and the whole ring's. Never keeps any text. */
function compare(
  c: TailReadCounters,
  tail: Extract<TextSnapshotOutcome, { ok: true }>,
  full: TextSnapshotOutcome,
  rows: number,
  inputs: TailInputs | undefined,
): void {
  if (!full.ok) { bump(c.mismatches, 'full-failed'); return; }
  let mismatched = false;
  const note = (key: string) => { bump(c.mismatches, key); mismatched = true; };
  const split = (all: readonly TextSnapshotRow[]) => [all.slice(0, Math.max(0, all.length - rows)), all.slice(-rows)];
  const [tailHistory, tailViewport] = split(tail.rows);
  const [fullHistory, fullViewport] = split(full.rows);
  if (differ(tailViewport, fullViewport)) note('viewport');
  const depth = Math.min(tailHistory.length, fullHistory.length);
  if (differ(tailHistory.slice(tailHistory.length - depth), fullHistory.slice(fullHistory.length - depth))) note('history');
  if (tailHistory.length !== fullHistory.length) note('history-depth');
  if (tail.rowsBelowCursor !== full.rowsBelowCursor) note('cursor');
  if (tail.bufferType !== full.bufferType) note('buffer');
  if (inputs) {
    const fromTail = inputs(tail.rows.map((r) => r.text));
    const fromFull = inputs(full.rows.map((r) => r.text));
    for (const key of Object.keys(fromFull)) {
      const t = fromTail[key];
      const f = fromFull[key];
      if (t === f) continue;
      if (typeof f === 'boolean' || typeof t === 'boolean') note(`${key}:${f ? 'full-only' : 'tail-only'}`);
      else note(`${key}:${f === undefined ? 'tail-only' : t === undefined ? 'full-only' : 'differ'}`);
    }
  }
  if (mismatched) bump(c.mismatches, 'any');
}

/** Copies of the counters by site, for the daemon's diagnostics. */
export function tailReadCounters(): Record<string, TailReadCounters> {
  return Object.fromEntries([...counters].map(([site, c]) => [site, { ...c, fallbacks: { ...c.fallbacks }, mismatches: { ...c.mismatches } }]));
}

/** Tests only. */
export function resetTailReadCounters(): void {
  counters.clear();
  lastAnyCheck = Number.NEGATIVE_INFINITY;
}
