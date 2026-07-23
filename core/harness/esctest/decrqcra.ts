// E0 harness M3 — DECRQCRA checksum bridge (spec: engine-core-decision-2026-07-09.md §5-3)
//
// ⚠️ Clean-room rule: checksum algorithm and wire format in this file are derived **only from
//    DEC STD 070 / xterm ctlseqs spec**. GPL-2.0 esctest2 (vendor/) checksum logic was not
//    referenced. (esctest does not compute checksums in the first place — it only sends requests
//    and the terminal computes them. So the computation algorithm does not exist in vendor source
//    either. We reproduce what xterm would respond with from the subject grid.)
//
// ── DECRQCRA wire format (xterm ctlseqs spec) ─────────────────────────────────
//   Request:  CSI Pid ; Pp ; Pt ; Pl ; Pb ; Pr * y
//          - Pid: request id (echoed in response). Pp: page (0=current). Pt/Pl/Pb/Pr: rect (1-based).
//          - intermediate '*'(0x2A), final 'y'(0x79).
//   Response:  DCS Pid ! ~ D...D ST
//          - DCS = ESC P (0x1B 0x50), terminator ST = ESC \ (0x1B 0x5C).
//          - Pid decimal echo, then "!~", then 4-digit uppercase hex checksum.
//
// ── Checksum definition (xterm canonical) ──────────────────────────────────────────────────
//   xterm DECRQCRA checksum = two's complement (negation) of the sum of character codes in the
//   rectangle, truncated to 16 bits:  checksum = (-Σ code) & 0xFFFF.
//   - Σ code: sum of displayed character code points in rect. **Empty/blank cells count as 0x20
//     (space)** (xterm #336 onward "all blanks equal" behavior — matches DEC VT520 real behavior).
//   - Attribute (SGR) contribution not included in default xterm build (character codes only).
//     VT520 adds attribute bits but xterm defaults to characters only — aligned with our baseline
//     (xterm.js).
//   - Wide characters: xterm iterates cell-by-cell; wide trailing (spacer) cells are not code 0
//     contribution but skipped and treated as 0x20 (same as empty). This bridge also counts
//     spacer (width 0) as 0x20.
//
// This definition gives verification power: "if xterm.js grid holds the same characters as xterm,
// the same checksum results" — i.e. DECRQCRA round-trip actually verifies grid content.

import type { Terminal } from '@xterm/headless';

/** Code assigned to blank/unfilled cells (xterm #336 blank equal = space). */
export const BLANK_CODE = 0x20;

/**
 * Compute 16-bit two's complement of character code sum inside rect (1-based, inclusive).
 * Reads from buffer.active instead of iterating getCells directly (same source as differ.extractGrid).
 *
 * @param term    Subject-under-test (@xterm/headless).
 * @param top,left,bottom,right  1-based inclusive screen coordinates (esctest DECRQCRA rect).
 */
export function computeRectChecksum(
  term: Terminal,
  top: number,
  left: number,
  bottom: number,
  right: number,
): number {
  const buf = term.buffer.active;
  const cols = term.cols;
  const rows = term.rows;
  // 1-based → 0-based, clamp to grid bounds (safe even if rect extends off-screen).
  const y0 = Math.max(0, top - 1);
  const y1 = Math.min(rows - 1, bottom - 1);
  const x0 = Math.max(0, left - 1);
  const x1 = Math.min(cols - 1, right - 1);

  let sum = 0;
  for (let y = y0; y <= y1; y++) {
    const line = buf.getLine(buf.viewportY + y);
    for (let x = x0; x <= x1; x++) {
      const cell = line?.getCell(x);
      let code: number;
      if (!cell) {
        code = BLANK_CODE;
      } else {
        const width = cell.getWidth();
        const chars = cell.getChars();
        if (width === 0 || chars === '') {
          // wide spacer or unfilled → treat as blank (space) (xterm #336 equal).
          code = BLANK_CODE;
        } else {
          code = cell.getCode();
          if (code === 0) code = BLANK_CODE; // NUL/unset also blank.
        }
      }
      sum = (sum + code) & 0xffff;
    }
  }
  // Two's complement (negation) to 16 bits.
  return (-sum) & 0xffff;
}

/**
 * Build DECRQCRA response bytes: DCS Pid ! ~ HHHH ST.
 * Checksum is 4-digit uppercase hex (xterm convention).
 */
export function buildDecrqcraReply(pid: number, checksum: number): Uint8Array {
  const hex = (checksum & 0xffff).toString(16).toUpperCase().padStart(4, '0');
  // ESC P {pid}!~{HHHH} ESC \
  const body = `\x1bP${pid}!~${hex}\x1b\\`;
  return Buffer.from(body, 'binary');
}

// ── WINOPS size-report bridge (spike observation — not captured in decision doc §5-3) ──────
//
// Observation (probe): @xterm/headless emits CPR·DA·DA2·DSR·DECRQM·DECXCPR queries fully but
// **XTERM_WINOPS size reports (CSI 18 t / CSI 19 t) are silent** (no window in headless).
// esctest reset() uses GetScreenSize()=CSI 18 t for tab stop setup; without this, reset itself
// dies on timeout and no cases run. Same nature as DECRQCRA bridge — **adapter knows grid
// geometry and responds with that value** (no verification loss: geometry is governed by adapter
// resize). Bridge usage is recorded in the report.
//
// Wire format (xterm ctlseqs):
//   CSI 18 t (report text-area size in chars)  → response CSI 8 ; rows ; cols t
//   CSI 19 t (report screen size in chars)     → response CSI 9 ; rows ; cols t

/** Respond to CSI 18 t / CSI 19 t request. code=8(18t)·9(19t). */
export function buildWinopsSizeReply(reportCode: 8 | 9, rows: number, cols: number): Uint8Array {
  return Buffer.from(`\x1b[${reportCode};${rows};${cols}t`, 'binary');
}

/** WINOPS size query parse result. */
export type WinopsSizeParse =
  | { readonly reportCode: 8 | 9; readonly end: number }
  | null
  | 'incomplete';

/**
 * Parse only WINOPS size queries (CSI 18 t / CSI 19 t) from s[start..]. Other WINOPS (title
 * push/pop, deiconify, etc.) have no response, so null here → pass through to subject (xterm.js ignores).
 */
export function tryParseWinopsSizeQuery(s: string, start: number): WinopsSizeParse {
  let i = start;
  if (s.charCodeAt(i) === 0x1b) {
    if (i + 1 >= s.length) return 'incomplete';
    if (s[i + 1] !== '[') return null;
    i += 2;
  } else if (s.charCodeAt(i) === 0x9b) {
    i += 1;
  } else {
    return null;
  }
  let params = '';
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code >= 0x30 && code <= 0x3f) {
      params += s[i];
      i += 1;
    } else if (code >= 0x40 && code <= 0x7e) {
      // final. WINOPS final = 't', no intermediate.
      if (s[i] === 't') {
        // Only single parameter 18 or 19 is size report (forms with trailing args are not size queries).
        if (params === '18') return { reportCode: 8, end: i + 1 };
        if (params === '19') return { reportCode: 9, end: i + 1 };
        return null; // other winop → pass to subject.
      }
      return null; // final not 't' → not WINOPS.
    } else {
      return null;
    }
  }
  return 'incomplete';
}

/** tryParseDecrqcra result: fields if complete request, null if not start, 'incomplete' if partial. */
export type DecrqcraParse =
  | { readonly pid: number; readonly page: number; readonly top: number; readonly left: number; readonly bottom: number; readonly right: number; readonly end: number }
  | null
  | 'incomplete';

/** WINOPS character resize (CSI 8 ; rows ; cols t) parse result (review feedback — bridge freshness). */
export type WinopsResizeParse =
  | { readonly rows: number; readonly cols: number; readonly end: number }
  | null
  | 'incomplete';

/**
 * Parse WINOPS character-unit resize command (CSI 8 ; rows ; cols t) from s[start..] (review feedback).
 * Must intercept and apply to subject term.resize so subsequent CSI 18 t queries return fresh geometry —
 * without intercept, size-report bridge stays fixed at initial geometry.
 */
export function tryParseWinopsResize(s: string, start: number): WinopsResizeParse {
  let i = start;
  if (s.charCodeAt(i) === 0x1b) {
    if (i + 1 >= s.length) return 'incomplete';
    if (s[i + 1] !== '[') return null;
    i += 2;
  } else if (s.charCodeAt(i) === 0x9b) {
    i += 1;
  } else {
    return null;
  }
  let params = '';
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code >= 0x30 && code <= 0x3f) {
      params += s[i];
      i += 1;
    } else if (code >= 0x40 && code <= 0x7e) {
      if (s[i] !== 't') return null;
      const parts = params.split(';');
      if (parts[0] !== '8' || parts.length < 3) return null;
      const rows = Number(parts[1]);
      const cols = Number(parts[2]);
      if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) return null;
      return { rows, cols, end: i + 1 };
    } else {
      return null;
    }
  }
  return 'incomplete';
}

/**
 * Parse DECRQCRA request (CSI ... * y) at s[start..].
 *   - If s[start] is ESC (0x1B) and not followed by CSI (ESC[), not a start (null).
 *   - If buffer ends during CSI parameters, 'incomplete' (retry merged with next chunk).
 *   - When intermediate '*' + final 'y', interpret parameters as (pid,page,top,left,bottom,right).
 *
 * Fewer than 6 parameters (abnormal DECRQCRA) → null — pass to subject. esctest normal path
 * always sends Pid;Pp;Pt;Pl;Pb;Pr six values (vendor esccmd DECRQCRA usage verified).
 */
export function tryParseDecrqcra(s: string, start: number): DecrqcraParse {
  // CSI start detection: ESC(0x1B) '[' or 8-bit CSI(0x9B). esctest emits 7-bit (ESC[) only.
  let i = start;
  if (s.charCodeAt(i) === 0x1b) {
    if (i + 1 >= s.length) return 'incomplete';
    if (s[i + 1] !== '[') return null;
    i += 2;
  } else if (s.charCodeAt(i) === 0x9b) {
    i += 1;
  } else {
    return null;
  }
  // Scan parameters/intermediate/final.
  let params = '';
  let intermediate = '';
  while (i < s.length) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    if (code >= 0x30 && code <= 0x3f) {
      // Parameter byte (digits·';'·':'·'<'..'?').
      params += ch;
      i += 1;
    } else if (code >= 0x20 && code <= 0x2f) {
      // Intermediate byte (includes '*').
      intermediate += ch;
      i += 1;
    } else if (code >= 0x40 && code <= 0x7e) {
      // Final byte. DECRQCRA final = 'y' + intermediate '*'.
      if (ch === 'y' && intermediate === '*') {
        const parts = params.split(';');
        if (parts.length < 6) return null; // Not DECRQCRA (no other CSI * y, defensive).
        const nums = parts.map((p) => (p === '' ? 0 : parseInt(p, 10)));
        if (nums.some((n) => Number.isNaN(n))) return null;
        return {
          pid: nums[0],
          page: nums[1],
          top: nums[2],
          left: nums[3],
          bottom: nums[4],
          right: nums[5],
          end: i + 1,
        };
      }
      // Other CSI sequence → not DECRQCRA (pass to subject).
      return null;
    } else {
      // Control char intrusion etc. abnormal → not a start.
      return null;
    }
  }
  // Buffer ended during parameters → incomplete.
  return 'incomplete';
}
