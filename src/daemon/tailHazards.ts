/**
 * What a replay of only a ring's newest bytes (a "tail") cannot know: the
 * terminal state the bytes before the cut left behind that changes how the
 * tail's own bytes land, and that no unknown cell would reveal.
 *
 * A tail replay starts from a fresh terminal led by the mode preamble
 * (OutputModeTracker / the native interpreter), which restores DEC private
 * modes only. Scroll margins, origin mode, left/right margin mode, a
 * designated or shifted character set, changed tab stops, insert mode and
 * new-line mode all start at their defaults there. When one was set before the
 * cut, the tail's bytes are interpreted differently than the whole ring's
 * replay interprets them: a scroll moves the whole screen instead of the
 * region, a cursor position lands relative to the wrong origin, box-drawing
 * reads as letters, a tab stops at the wrong column. Every cell is still
 * written, so the screen is wrong with no unknown cell to show it.
 *
 * Scanned at read time, incrementally per session: each read scans only the
 * ring bytes since that session's last scan, so the PTY's write path pays
 * nothing. The scan starts at the ring's oldest byte with every hazard at its
 * default, which is the state the whole-ring replay itself starts from, so
 * "default at the cut" here means "default at the cut in the whole-ring
 * replay". A change that later falls out of the ring stays in the log: that
 * can only report a hazard the replay no longer sees, which costs a fallback,
 * never a wrong answer.
 *
 * Deliberately conservative where the two engines differ: DECSTR (`CSI ! p`)
 * resets margins in xterm.js but is unhandled by vte, so it resets nothing
 * here; only RIS (`ESC c`), which both handle, returns everything to default.
 */

export type TailHazard =
  | 'screen-switch'
  | 'margins'
  | 'origin'
  | 'lr-margins'
  | 'charset'
  | 'tabs'
  | 'insert'
  | 'newline'
  | 'hazard-history';

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
  /** G0..G3 designations ('B' is ASCII) and the set invoked into GL. */
  readonly sets: string;
  readonly gl: number;
}

const DEFAULT_STATE: HazardState = {
  top: 0, bottom: 0, origin: false, lrMargins: false, insert: false, newline: false, tabs: false, sets: 'BBBB', gl: 0,
};

/**
 * The sequences that change a hazard, plus the alternate-screen switches.
 * Matched on a latin1 view of the ring's bytes, so a match index is a byte
 * offset: every sequence here is ASCII, and ESC/SO/SI never occur inside a
 * UTF-8 character.
 *   1-3: CSI [?] Ps;... h|l|r|g    4-5: ESC (|)|*|+|-|.|/ <final>
 *   6:   ESC c|H|n|o               7:   SO / SI
 */
// eslint-disable-next-line no-control-regex
const HAZARD_RE = /\x1b(?:\[(\??)([0-9;]*)([hlrg])|([()*+\-./])([\x20-\x2f]*[\x30-\x7e])|([cHno]))|([\x0e\x0f])/g;

/** Bytes re-read before a scan's start, so a sequence cut by the previous scan's end still matches. */
const OVERLAP_BYTES = 64;

/** State changes kept; a cut older than the oldest kept one can no longer be answered. */
const MAX_LOG = 4096;

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

function same(a: HazardState, b: HazardState): boolean {
  return a.top === b.top && a.bottom === b.bottom && a.origin === b.origin && a.lrMargins === b.lrMargins &&
    a.insert === b.insert && a.newline === b.newline && a.tabs === b.tabs && a.sets === b.sets && a.gl === b.gl;
}

export class TailHazardScan {
  /** Lifetime offset the scan has read up to. */
  private scannedTo = -1;
  /** The state before the oldest logged change, and the offset it is known from. */
  private base: HazardState = DEFAULT_STATE;
  private knownFrom = 0;
  /** State changes in stream order: `at` is the lifetime offset of the sequence's first byte. */
  private log: Array<{ at: number; state: HazardState }> = [];
  private state: HazardState = DEFAULT_STATE;
  /** Lifetime offset of the newest alternate-screen switch, or -1. */
  private lastScreenSwitch = -1;

  /**
   * Read the bytes of `data` (a copy of the whole ring, whose last byte is the
   * stream's byte `writtenAt - 1`) that this scan has not seen. When bytes
   * between the last scan and the ring's start were dropped, or this is the
   * first scan, the log restarts at the ring's start with every default, as
   * the whole-ring replay does. Returns the bytes scanned.
   */
  advance(data: Buffer, writtenAt: number): number {
    const ringStart = writtenAt - data.length;
    if (this.scannedTo < ringStart || this.scannedTo > writtenAt) {
      this.base = DEFAULT_STATE;
      this.state = DEFAULT_STATE;
      this.log = [];
      this.knownFrom = ringStart;
      this.lastScreenSwitch = -1;
      this.scannedTo = ringStart;
    }
    if (this.scannedTo === writtenAt) return 0;
    const from = Math.max(ringStart, this.scannedTo - OVERLAP_BYTES);
    const text = data.toString('latin1', from - ringStart);
    // Matches ending at or before the last scan's end were applied by it.
    const seenEnd = this.scannedTo - from;
    HAZARD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HAZARD_RE.exec(text)) !== null) {
      if (m.index + m[0].length <= seenEnd) continue;
      this.apply(m, from + m.index);
    }
    this.scannedTo = writtenAt;
    return writtenAt - from;
  }

  private apply(m: RegExpExecArray, at: number): void {
    const s = this.state;
    let next: HazardState = s;
    if (m[3] !== undefined) {
      const priv = m[1] === '?';
      const params = m[2].split(';').map((p) => (p === '' ? 0 : Number(p)));
      if (m[3] === 'h' || m[3] === 'l') {
        const on = m[3] === 'h';
        for (const p of params) {
          if (priv) {
            if (p === 47 || p === 1047 || p === 1049) this.lastScreenSwitch = at;
            else if (p === 6) next = { ...next, origin: on };
            else if (p === 69) next = { ...next, lrMargins: on };
          } else if (p === 4) next = { ...next, insert: on };
          else if (p === 20) next = { ...next, newline: on };
        }
      } else if (!priv && m[3] === 'r') next = { ...s, top: params[0] ?? 0, bottom: params[1] ?? 0 };
      else if (!priv && m[3] === 'g') next = { ...s, tabs: true };
    } else if (m[4] !== undefined) {
      const index = SET_INDEX[m[4]];
      const sets = s.sets.slice(0, index) + (m[5] === 'B' ? 'B' : '?') + s.sets.slice(index + 1);
      next = { ...s, sets };
    } else if (m[6] !== undefined) {
      if (m[6] === 'c') next = DEFAULT_STATE;
      else if (m[6] === 'H') next = { ...s, tabs: true };
      else next = { ...s, gl: m[6] === 'n' ? 2 : 3 };
    } else {
      next = { ...s, gl: m[7] === '\x0e' ? 1 : 0 };
    }
    if (same(next, s)) return;
    this.state = next;
    this.log.push({ at, state: next });
    const dropped = this.log.length > MAX_LOG ? this.log.shift() : undefined;
    if (dropped) {
      this.base = dropped.state;
      // A cut at or before the dropped change's offset no longer knows its state.
      this.knownFrom = dropped.at + 1;
    }
  }

  /**
   * What a tail replay starting at lifetime offset `cut` (a fresh terminal
   * `rows` tall) would get wrong, or null when nothing scanned says so.
   * Call after advance() with the same read's bytes.
   */
  hazardAt(cut: number, rows: number): TailHazard | null {
    if (this.lastScreenSwitch >= cut) return 'screen-switch';
    if (cut < this.knownFrom) return 'hazard-history';
    // The state after every change that starts before the cut.
    let lo = 0;
    let hi = this.log.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.log[mid].at < cut) lo = mid + 1;
      else hi = mid;
    }
    return hazardOf(lo === 0 ? this.base : this.log[lo - 1].state, rows);
  }
}
