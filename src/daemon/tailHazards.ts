/**
 * What a replay of only a ring's newest bytes (a "tail") cannot know: the
 * terminal state the bytes before the cut left behind that changes how the
 * tail's own bytes land, and that no unknown cell would reveal.
 *
 * A tail replay starts from a fresh terminal led by the mode preamble
 * (OutputModeTracker / the native interpreter). Neither tracker restores any
 * of the state below, so the whole-ring replay starts it at its defaults too,
 * at the ring's oldest byte (pinned by test). Two kinds of hazard follow:
 *
 * State on at the cut. Scroll margins, origin mode, left/right margin mode, a
 * designated or shifted character set, changed tab stops, insert mode and
 * new-line mode start at their defaults in the tail. When the whole-ring
 * replay has one on at the cut, the tail's bytes land differently: a scroll
 * moves the whole screen instead of the region, a position lands relative to
 * the wrong origin, box-drawing reads as letters. Every cell is still written,
 * so the screen is wrong with no unknown cell to show it.
 *
 * Changes inside the tail whose state at the cut is lost. A screen switch
 * (the other screen starts blank in the tail), an autowrap change (the
 * preamble leaves a mode to the tail when the tail changes it, so the tail
 * starts it at its default), and a saved-cursor restore before any save in the
 * tail (the tail restores home and default charsets).
 *
 * Scanned at read time, so the PTY's write path pays nothing: each read scans
 * the ring bytes new since that session's last read, keeping a state
 * checkpoint every 64 KiB of the stream, then scans from the checkpoint before the cut to
 * the cut, and the tail itself for its own changes. The scan starts at the
 * ring's oldest byte with defaults; state carried from bytes the ring has
 * since dropped can only report a hazard the replay no longer has (a
 * fallback, never a wrong answer), and a blocked read rescans from the ring's
 * start once 1 MiB has dropped since the scan began.
 *
 * Conservative where the two engines differ: DECSTR (`CSI ! p`) resets margins
 * in xterm.js but is unhandled by vte, so it resets nothing here; only RIS
 * (`ESC c`), which both handle, returns everything to default.
 */

export type TailHazard =
  | 'screen-switch'
  | 'autowrap'
  | 'saved-cursor'
  | 'margins'
  | 'origin'
  | 'lr-margins'
  | 'charset'
  | 'tabs'
  | 'insert'
  | 'newline';

interface HazardState {
  /** DECSTBM as sent: 0 is "not given". */
  readonly top: number;
  readonly bottom: number;
  readonly origin: boolean;
  readonly lrMargins: boolean;
  readonly insert: boolean;
  readonly newline: boolean;
  /** HTS or TBC since the last RIS. */
  readonly tabs: boolean;
  /** G0..G3 designations ('B' is ASCII, '?' anything else) and the set invoked into GL. */
  readonly sets: string;
  readonly gl: number;
}

const DEFAULT_STATE: HazardState = {
  top: 0, bottom: 0, origin: false, lrMargins: false, insert: false, newline: false, tabs: false, sets: 'BBBB', gl: 0,
};

/**
 * The sequences that change hazard state. Matched on a latin1 view of the
 * ring's bytes, so a match index is a byte offset: every sequence here is
 * ASCII, and ESC/SO/SI never occur inside a UTF-8 character. A DEC private
 * mode list matches only when it names ?6 or ?69, so the ?2026 pair a TUI
 * sends every frame is not even a match.
 *   1-2: CSI ? ...6|69... h|l      3-4: CSI Ps;... h|l|r|g
 *   5-6: ESC (|)|*|+|-|.|/ <final> 7:   ESC c|H|n|o      8: SO / SI
 */
// eslint-disable-next-line no-control-regex
const STATE_RE = /\x1b(?:\[\?((?:\d*;)*(?:6|69)(?:;\d*)*)([hl])|\[([0-9;]*)([hlrg])|([()*+\-./])([\x20-\x2f]*[\x30-\x7e])|([cHno]))|([\x0e\x0f])/g;

/**
 * Inside the tail: DEC private mode lists (screen switches, autowrap, ?1048),
 * SCOSC/SCORC (`CSI s` / `CSI u`, exactly: `CSI > 1 u` is the kitty keyboard
 * protocol), DECSC/DECRC (`ESC 7` / `ESC 8`).
 */
// eslint-disable-next-line no-control-regex
const TAIL_RE = /\x1b(?:\[\?([0-9;]*)([hl])|\[([su])|([78]))/g;

/** State checkpoints are kept this far apart. */
const CHECKPOINT_BYTES = 64 * 1024;
/** Bytes re-read before an incremental scan's start, so a sequence cut by the previous read's end still matches. */
const OVERLAP_BYTES = 64;
/** A blocked read rescans from the ring's start once this much has dropped since the scan began. */
const REBASE_BYTES = 1024 * 1024;

const SET_INDEX: Readonly<Record<string, number>> = { '(': 0, ')': 1, '*': 2, '+': 3, '-': 1, '.': 2, '/': 3 };

function hazardOf(state: HazardState, rows: number): TailHazard | null {
  if (state.top > 1 || (state.bottom > 0 && state.bottom < rows)) return 'margins';
  if (state.origin) return 'origin';
  if (state.lrMargins) return 'lr-margins';
  if (state.sets !== 'BBBB' || state.gl !== 0) return 'charset';
  if (state.tabs) return 'tabs';
  if (state.insert) return 'insert';
  if (state.newline) return 'newline';
  return null;
}

/** The state after the sequence `m`. */
function applied(s: HazardState, m: RegExpExecArray): HazardState {
  if (m[2] !== undefined) {
    let next = s;
    for (const p of m[1].split(';')) {
      if (p === '6') next = { ...next, origin: m[2] === 'h' };
      else if (p === '69') next = { ...next, lrMargins: m[2] === 'h' };
    }
    return next;
  }
  if (m[4] !== undefined) {
    const params = m[3].split(';').map((p) => (p === '' ? 0 : Number(p)));
    if (m[4] === 'r') return { ...s, top: params[0] ?? 0, bottom: params[1] ?? 0 };
    if (m[4] === 'g') return { ...s, tabs: true };
    let next = s;
    for (const p of params) {
      if (p === 4) next = { ...next, insert: m[4] === 'h' };
      else if (p === 20) next = { ...next, newline: m[4] === 'h' };
    }
    return next;
  }
  if (m[5] !== undefined) {
    const index = SET_INDEX[m[5]];
    return { ...s, sets: s.sets.slice(0, index) + (m[6] === 'B' ? 'B' : '?') + s.sets.slice(index + 1) };
  }
  if (m[7] !== undefined) {
    if (m[7] === 'c') return DEFAULT_STATE;
    if (m[7] === 'H') return { ...s, tabs: true };
    return { ...s, gl: m[7] === 'n' ? 2 : 3 };
  }
  return { ...s, gl: m[8] === '\x0e' ? 1 : 0 };
}

/** The first change inside the tail (`text`) whose state at the cut the tail cannot know, or null. */
function tailChange(text: string): TailHazard | null {
  let saved = false;
  TAIL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAIL_RE.exec(text)) !== null) {
    if (m[1] !== undefined) {
      for (const raw of m[1].split(';')) {
        const p = Number(raw);
        if (p === 47 || p === 1047 || p === 1049) return 'screen-switch';
        if (p === 7) return 'autowrap';
        if (p === 1048) {
          if (m[2] === 'h') saved = true;
          else if (!saved) return 'saved-cursor';
        }
      }
    } else if (m[3] === 's' || m[4] === '7') saved = true;
    else if (!saved) return 'saved-cursor';
  }
  return null;
}

export class TailHazardScan {
  /** Lifetime offset the scan began at, with every hazard at its default. */
  private origin = -1;
  /** Lifetime offset read up to, and the state after every sequence starting before it. */
  private scannedTo = -1;
  private state: HazardState = DEFAULT_STATE;
  /** In order: the state after every sequence starting before `at`. The first is the origin. */
  private checkpoints: Array<{ at: number; state: HazardState }> = [];

  /**
   * What a tail replay of `data` (a copy of the whole ring, whose last byte is
   * the stream's byte `writtenAt - 1`) starting at lifetime offset `cut`, `rows`
   * tall, would get wrong, or null. Returns the bytes scanned as well.
   */
  check(data: Buffer, writtenAt: number, cut: number, rows: number): { hazard: TailHazard | null; scanned: number } {
    const ringStart = writtenAt - data.length;
    let scanned = 0;
    // A read of a ring that failed to wake sees only its newest bytes; the
    // next read sees older ones again, so a start that moved back restarts.
    if (this.origin < 0 || ringStart < this.origin || this.scannedTo < ringStart || this.scannedTo > writtenAt) this.restart(ringStart);
    scanned += this.advance(data, ringStart, writtenAt);
    const inTail = tailChange(data.toString('latin1', cut - ringStart));
    if (inTail) return { hazard: inTail, scanned };
    let hazard = this.stateHazard(data, ringStart, cut, rows);
    if (hazard && this.origin < ringStart - REBASE_BYTES) {
      // The hazard may come only from bytes the whole-ring replay no longer has.
      this.restart(ringStart);
      scanned += this.advance(data, ringStart, writtenAt);
      hazard = this.stateHazard(data, ringStart, cut, rows);
    }
    return { hazard, scanned };
  }

  private restart(ringStart: number): void {
    this.origin = ringStart;
    this.scannedTo = ringStart;
    this.state = DEFAULT_STATE;
    this.checkpoints = [{ at: ringStart, state: DEFAULT_STATE }];
  }

  /** Scan the bytes not yet seen, keeping a checkpoint every CHECKPOINT_BYTES. Returns the bytes scanned. */
  private advance(data: Buffer, ringStart: number, writtenAt: number): number {
    if (this.scannedTo === writtenAt) return 0;
    const from = Math.max(ringStart, this.scannedTo - OVERLAP_BYTES);
    const text = data.toString('latin1', from - ringStart);
    // Matches ending at or before the last read's end were applied by it.
    const seenEnd = this.scannedTo - from;
    let nextCheckpoint = this.checkpoints[this.checkpoints.length - 1].at + CHECKPOINT_BYTES;
    STATE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = STATE_RE.exec(text)) !== null) {
      if (m.index + m[0].length <= seenEnd) continue;
      const at = from + m.index;
      // Matches come in start order, so before the first one at or past a
      // checkpoint, the state is exactly that of every sequence before it.
      for (; at >= nextCheckpoint; nextCheckpoint += CHECKPOINT_BYTES) this.checkpoints.push({ at: nextCheckpoint, state: this.state });
      this.state = applied(this.state, m);
    }
    // Past the last match: exact up to where a sequence could still be unfinished.
    for (; nextCheckpoint <= writtenAt - OVERLAP_BYTES; nextCheckpoint += CHECKPOINT_BYTES) this.checkpoints.push({ at: nextCheckpoint, state: this.state });
    this.scannedTo = writtenAt;
    // Checkpoints before the ring's start have no bytes left to scan from; keep the newest of them as the floor.
    while (this.checkpoints.length > 1 && this.checkpoints[1].at <= ringStart) this.checkpoints.shift();
    return writtenAt - from;
  }

  /** The state hazard on at `cut`: from the checkpoint before it, through the bytes up to it. */
  private stateHazard(data: Buffer, ringStart: number, cut: number, rows: number): TailHazard | null {
    let checkpoint = this.checkpoints[0];
    for (const c of this.checkpoints) {
      if (c.at > cut) break;
      checkpoint = c;
    }
    if (checkpoint.at < ringStart) {
      // Its bytes are gone: start over from the ring's start.
      this.restart(ringStart);
      this.advance(data, ringStart, ringStart + data.length);
      checkpoint = this.checkpoints[0];
      for (const c of this.checkpoints) {
        if (c.at > cut) break;
        checkpoint = c;
      }
    }
    let state = checkpoint.state;
    const text = data.toString('latin1', checkpoint.at - ringStart, cut - ringStart);
    STATE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = STATE_RE.exec(text)) !== null) state = applied(state, m);
    return hazardOf(state, rows);
  }
}
