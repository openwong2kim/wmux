import { performance } from 'node:perf_hooks';
import type { TailReadCounters } from '../shared/memoryDiagnostics';
import type { TextSnapshotOutcome, TextSnapshotRow } from './HeadlessSnapshot';
import type { RingBuffer } from './RingBuffer';
import { UNKNOWN_CELL, readRingWithModes, tailCut, withUnknownCells } from './sessionTextReplay';
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
 */

export const TAIL_BYTES = 256 * 1024;
/** How far past the byte budget's edge a tail still looks for a line start. */
const TAIL_LINE_WITHIN = 16 * 1024;
/** The real-data check compares a served answer with the whole ring's at most this often per pane, */
export const TAIL_CHECK_INTERVAL_MS = 10 * 60_000;
/** and at most this often across panes, so a daemon start doesn't stack one extra whole-ring parse per pane. */
export const TAIL_CHECK_SPACING_MS = 10_000;

export type TailSite = 'fleet' | 'stallwatch';
export type TailFallbackReason = TailHazard | 'no-modes' | 'unknown-visible' | 'tail-failed';
/** `via` says which replay answered: the tail, or the whole ring. */
export type TailOutcome = TextSnapshotOutcome & { via: 'tail' | 'full' };
/** A site's decision inputs, compared by the real-data check. Values never leave this module. */
export type TailInputs = (rows: readonly string[]) => Readonly<Record<string, boolean | string | undefined>>;

export interface GuardedTailSession {
  meta: { cols: number; rows: number };
  ringBuffer: Pick<RingBuffer, 'readAll' | 'totalBytesWritten'>;
  bridge: { readonly outputModes: Pick<OutputModeTracker, 'preamble'> | null };
}

export interface GuardedTailOptions {
  site: TailSite;
  /** The caller's parse: the same request the whole-ring read makes, given its bytes. */
  parse: (initial: Buffer) => Promise<TextSnapshotOutcome>;
  inputs?: TailInputs;
}

const scans = new WeakMap<GuardedTailSession, TailHazardScan>();
const lastCheck = new WeakMap<GuardedTailSession, number>();
let lastAnyCheck = Number.NEGATIVE_INFINITY;
const counters = new Map<TailSite, TailReadCounters>();

function siteCounters(site: TailSite): TailReadCounters {
  let c = counters.get(site);
  if (!c) {
    counters.set(site, (c = {
      reads: 0, served: 0, whole: 0, fallbacks: {}, tailMsTotal: 0, tailMsMax: 0, fallbackMsTotal: 0, fallbackMsMax: 0,
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
  // The whole-ring read's own bytes and preamble, so a fallback is its answer.
  const { raw: data, replay: full } = readRingWithModes(session.ringBuffer, modes);
  const writtenAt = session.ringBuffer.totalBytesWritten;
  const ringStart = writtenAt - data.length;
  time(c, 'ringCopyMs', performance.now() - started);
  // Dims backstop as the whole-ring reads have: a recovered session may not have real dims yet.
  const cols = session.meta.cols ?? 80;
  const rows = session.meta.rows ?? 24;

  const fallback = async (reason: TailFallbackReason): Promise<TailOutcome> => {
    bump(c.fallbacks, reason);
    time(c, 'tailMs', performance.now() - started);
    const at = performance.now();
    const answer = await options.parse(full);
    time(c, 'fallbackMs', performance.now() - at);
    return { ...answer, via: 'full' };
  };

  // A TUI that repaints by position writes few line feeds: one far past the
  // edge would leave almost nothing to replay, so start at an escape instead.
  const cut = tailCut(data, TAIL_BYTES, TAIL_LINE_WITHIN);
  if (cut === 0) {
    // The whole ring fits: the tail is the whole replay.
    const answer = await options.parse(full);
    c.whole++;
    time(c, 'tailMs', performance.now() - started);
    return { ...answer, via: 'tail' };
  }
  if (!modes) return fallback('no-modes');

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
  if (tail.rows.some((row) => row.text.includes(UNKNOWN_CELL))) return fallback('unknown-visible');
  c.served++;
  time(c, 'tailMs', performance.now() - started);

  const now = Date.now();
  const checkedAt = lastCheck.get(session);
  if ((checkedAt === undefined || now - checkedAt >= TAIL_CHECK_INTERVAL_MS) && now - lastAnyCheck >= TAIL_CHECK_SPACING_MS) {
    lastCheck.set(session, now);
    lastAnyCheck = now;
    c.checks++;
    // The check never changes the answer: a failure is counted, not thrown.
    try { compare(c, tail, await options.parse(full), rows, options.inputs); } catch { bump(c.mismatches, 'check-failed'); }
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
