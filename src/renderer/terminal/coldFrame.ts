import type { Terminal } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import { IncompleteEscapeSplitter } from '../../shared/incompleteEscape';

// Cold-park reveal: paint the last-seen screen at once, then swap in the
// daemon's screen without an empty frame in between.
//
// Cold-park (useColdParkSweep) unmounts a workspace that stayed hidden for
// minutes, which disposes its xterm. Showing that workspace again mounts a
// fresh, empty xterm and reattaches it to the daemon, and the daemon has to
// re-parse the session's whole ring in a headless terminal before it can ship
// a snapshot (0.2-2 s measured, on a concurrency-1 queue shared by every
// pane). Until then the pane was only its theme background.
//
// Two pieces close that gap:
//
//  1. A bounded cache of the viewport each disposed terminal last showed,
//     keyed by ptyId. It is serialized with @xterm/addon-serialize (plain
//     SGR/cursor-positioning text, no modes) when the terminal is really
//     disposed, and written into the fresh terminal of the next mount on that
//     ptyId before the reattach starts. The frame is cosmetic: it is replaced
//     wholesale by the daemon's replay and never fed back to anything.
//
//  2. The swap. The replay is written as RIS + DEC 2026 BEGIN in front of its
//     first chunk, and DEC 2026 END after the flush marker. RIS throws the
//     cached frame away and leaves the terminal exactly as a fresh one, and
//     because RIS and BEGIN are parsed in the same parse call there is no
//     frame in which the reset screen is visible: xterm 6 checks the mode
//     again when the debounced render fires and buffers the rows instead, so
//     the next thing painted is the completed replay (the wmux xterm patch
//     paints it synchronously at END). xterm's own 1 s 2026 timeout, and the
//     output scheduler's shorter safety deadline for a held frame, both bound
//     a lost END.

export interface ColdFrame {
  /** Serialized viewport: SGR + cursor positioning + text, no modes. */
  frame: string;
  cols: number;
  rows: number;
}

/** One entry per recently disposed pane. Cold-park disposes a workspace at a
 *  time, so this covers several parked workspaces of a large fleet. */
export const COLD_FRAME_MAX_ENTRIES = 32;
/** A viewport is a few KB; anything far larger is not worth holding. */
export const COLD_FRAME_MAX_CHARS = 64 * 1024;

/** RIS, then open a synchronized-output frame. Both in one string on purpose:
 *  one parse call, so no render can land between the reset and the hold. */
export const REPAINT_BEGIN = '\x1bc\x1b[?2026h';
/** Close the synchronized-output frame opened by REPAINT_BEGIN. */
export const REPAINT_END = '\x1b[?2026l';
/** Bare RIS: drops a cached frame when the daemon had nothing to replay. */
export const FULL_RESET = '\x1bc';

/**
 * Split a run of payloads before the escape sequence their stream ends
 * inside, so REPAINT_END can be written before it. A daemon snapshot ends with
 * whatever sequence its ring was still inside (HeadlessSnapshot's partial
 * tail) for the next live bytes to finish; END written after it would abort
 * the sequence with its ESC, and those live bytes would print as text.
 * `pending` keeps the last payload's other fields.
 */
export function splitTrailingEscape<T extends { data: string }>(payloads: readonly T[]): { complete: T[]; pending: T | null } {
  const complete: T[] = [];
  const splitter = new IncompleteEscapeSplitter();
  let last: T | null = null;
  for (const payload of payloads) {
    const data = splitter.push(payload.data);
    last = payload;
    if (data) complete.push(data === payload.data ? payload : { ...payload, data });
  }
  const held = splitter.take();
  return { complete, pending: held && last ? { ...last, data: held } : null };
}

// Insertion order is recency: an entry is consumed on read, and a recapture
// deletes before it sets, so the first key is always the least recent.
const frames = new Map<string, ColdFrame>();

export function rememberColdFrame(ptyId: string, entry: ColdFrame): void {
  if (!ptyId) return;
  frames.delete(ptyId);
  if (entry.frame.length === 0 || entry.frame.length > COLD_FRAME_MAX_CHARS) return;
  frames.set(ptyId, entry);
  while (frames.size > COLD_FRAME_MAX_ENTRIES) {
    const oldest = frames.keys().next().value;
    if (oldest === undefined) break;
    frames.delete(oldest);
  }
}

/** Claim the cached frame for this ptyId. Single use: the mount that paints it
 *  owns the screen from here, and its own dispose captures a newer one. */
export function takeColdFrame(ptyId: string): ColdFrame | null {
  const entry = frames.get(ptyId);
  if (!entry) return null;
  frames.delete(ptyId);
  return entry;
}

/** Forget a pane's frame (its PTY exited, so nothing will reattach to it). */
export function dropColdFrame(ptyId: string): void {
  frames.delete(ptyId);
}

/**
 * Serialize the screen a terminal is showing into the cache. Only the
 * viewport (`scrollback: 0`); on the alternate screen that is the normal
 * screen's last rows followed by the alternate screen, which is what was on
 * display. Modes are excluded: mouse tracking or application cursor keys set
 * by a cosmetic frame would change what the user's keys and pointer send
 * before the real replay arrives. Never throws: this is cosmetic, and it runs
 * on the dispose path.
 */
export function captureColdFrame(ptyId: string, terminal: Terminal): void {
  if (!ptyId) return;
  try {
    const addon = new SerializeAddon();
    terminal.loadAddon(addon);
    try {
      const frame = addon.serialize({ scrollback: 0, excludeModes: true });
      rememberColdFrame(ptyId, { frame, cols: terminal.cols, rows: terminal.rows });
    } finally {
      addon.dispose();
    }
  } catch {
    // A terminal too far into teardown to read just leaves no frame behind;
    // the next mount shows what it showed before this cache existed.
  }
}

/**
 * Whether a cached frame can be painted into a terminal of this size. The
 * column count must match: every full-width row of a narrower terminal would
 * wrap, and the alternate screen (where a TUI agent lives) is not reflowed on
 * a later resize, so the frame would stay garbled until the replay. A row
 * difference is harmless: a shorter terminal scrolls the frame's top rows
 * away, a taller one leaves blank rows at the bottom, and both are gone at
 * the swap.
 */
export function coldFrameFits(entry: ColdFrame, cols: number): boolean {
  return entry.cols === cols;
}

/**
 * Per-mount swap state for a painted cold frame.
 *
 *   idle --painted()--> warm --first payload--> open --flush--> idle
 *
 * `warm`: the cached frame is on screen and nothing has replaced it yet.
 * `open`: REPAINT_BEGIN went out in front of the first payload; REPAINT_END is
 * owed after the flush marker. While open, an escape sequence a payload ends
 * inside is held back and goes out after REPAINT_END (or in front of the next
 * payload), so END never lands inside it (see splitTrailingEscape).
 */
export class WarmFrameSwap {
  private _phase: 'idle' | 'warm' | 'open' = 'idle';
  /** The flush marker arrived while still warm, with replay bytes reported:
   *  those bytes are held by the mount (scrollback-load race) and will be
   *  delivered later, so END is owed right after that delivery. */
  private _flushSeen = false;
  /** Holds back the unfinished escape sequence a payload ends inside while open. */
  private readonly _tail = new IncompleteEscapeSplitter();

  get phase(): 'idle' | 'warm' | 'open' {
    return this._phase;
  }

  /** The cached frame was just written. */
  painted(): void {
    this._phase = 'warm';
    this._flushSeen = false;
    this._tail.take();
  }

  /** Rewrite one payload on its way to xterm. The first payload after a paint
   *  is the daemon replay's first chunk: prefix RIS + BEGIN. */
  onData(data: string): string {
    if (this._phase === 'idle') return data;
    if (this._phase === 'warm') {
      this._phase = 'open';
      data = REPAINT_BEGIN + data;
    }
    return this._tail.push(data);
  }

  /** Close an open frame now: REPAINT_END, then any held-back sequence.
   *  Null when no frame is open. */
  close(): string | null {
    if (this._phase !== 'open') return null;
    const bytes = REPAINT_END + this._tail.take();
    this.cancel();
    return bytes;
  }

  /** The flush marker arrived. Returns bytes to write in stream order, or
   *  null when nothing is owed yet. */
  onFlush(recoveredBytes: number): string | null {
    if (this._phase === 'open') return this.close();
    if (this._phase === 'warm') {
      if (recoveredBytes > 0) {
        this._flushSeen = true;
        return null;
      }
      // The daemon replayed nothing: the cached frame must not pass for the
      // session's screen. A fresh mount showed an empty pane here; so do we.
      this._phase = 'idle';
      return FULL_RESET;
    }
    return null;
  }

  /** Held payloads were just delivered. Closes the frame when the flush
   *  marker overtook them (see `_flushSeen`). */
  settleHeld(): string | null {
    if (!this._flushSeen) return null;
    return this.close();
  }

  /** Something else repainted the screen from scratch (a resync settled, the
   *  mount went away): nothing is owed any more. */
  cancel(): void {
    this._phase = 'idle';
    this._flushSeen = false;
    this._tail.take();
  }
}

/** Test seam. */
export function __resetColdFrames(): void {
  frames.clear();
}

/** Test seam: cached ptyIds, least recent first. */
export function __coldFrameKeys(): string[] {
  return [...frames.keys()];
}
