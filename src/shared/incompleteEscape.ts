/**
 * Split a byte string so a trailing unfinished escape sequence can be carried
 * across a write boundary instead of being aborted by a later ESC.
 *
 * xterm holds incomplete CSI/OSC in the parser. If the next write starts with
 * ESC (DEC 2026 END, a new CUP, …) that ESC aborts the pending sequence and
 * the remainder (`12;6H`, `0m`, …) is stored as glyphs. Agent TUIs emit a
 * torrent of CUP sequences; PTY reads split them; wmux's 2026 safety-timeout
 * then injects END — exactly that abort. See terminalOutputScheduler.ts.
 *
 * The state machine matches src/daemon/util/ansiStreamScan.ts
 * PartialSequenceTracker (ECMA-48 / xterm.js): CSI params 0x30-0x3f,
 * intermediates 0x20-0x2f, final 0x40-0x7e; OSC/DCS until BEL or ST.
 */

const ESCAPE = 0x1b;

const enum ScanState {
  Ground,
  Esc,
  EscIntermediate,
  Csi,
  String,
  StringEsc,
}

function advance(state: ScanState, c: number): ScanState {
  switch (state) {
    case ScanState.Ground:
      return c === ESCAPE ? ScanState.Esc : ScanState.Ground;
    case ScanState.Esc:
      if (c === 0x5b /* [ */) return ScanState.Csi;
      if (
        c === 0x5d /* ] OSC */ ||
        c === 0x50 /* P DCS */ ||
        c === 0x58 /* X SOS */ ||
        c === 0x5e /* ^ PM */ ||
        c === 0x5f /* _ APC */
      ) {
        return ScanState.String;
      }
      if (c >= 0x20 && c <= 0x2f) return ScanState.EscIntermediate;
      return ScanState.Ground;
    case ScanState.EscIntermediate:
      if (c >= 0x20 && c <= 0x2f) return ScanState.EscIntermediate;
      if (c === ESCAPE) return ScanState.Esc;
      return ScanState.Ground;
    case ScanState.Csi:
      if ((c >= 0x30 && c <= 0x3f) || (c >= 0x20 && c <= 0x2f)) return ScanState.Csi;
      if (c >= 0x40 && c <= 0x7e) return ScanState.Ground;
      if (c === ESCAPE) return ScanState.Esc;
      if (c === 0x18 /* CAN */ || c === 0x1a /* SUB */) return ScanState.Ground;
      return ScanState.Csi;
    case ScanState.String:
      if (c === 0x07 /* BEL */) return ScanState.Ground;
      if (c === ESCAPE) return ScanState.StringEsc;
      if (c === 0x18 || c === 0x1a) return ScanState.Ground;
      return ScanState.String;
    case ScanState.StringEsc:
      if (c === 0x5c /* \ */) return ScanState.Ground;
      return advance(ScanState.Esc, c);
  }
}

export function splitIncompleteEscape(data: string): { complete: string; pending: string } {
  if (!data) return { complete: '', pending: '' };
  let state = ScanState.Ground;
  let lastGround = -1;
  for (let i = 0; i < data.length; i++) {
    state = advance(state, data.charCodeAt(i));
    if (state === ScanState.Ground) lastGround = i;
  }
  if (state === ScanState.Ground) return { complete: data, pending: '' };
  return {
    complete: data.slice(0, lastGround + 1),
    pending: data.slice(lastGround + 1),
  };
}
