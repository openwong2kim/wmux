/**
 * Input a terminal sends that no one typed: focus reports, pure mouse motion,
 * and the terminal's own replies to queries. Moved here from DaemonPTYBridge
 * so main can tell the same apart (a dropped reply is not lost input).
 */

// eslint-disable-next-line no-control-regex
const SGR_MOUSE = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
// eslint-disable-next-line no-control-regex
const FOCUS_REPORT = /\x1b\[[IO]/g;

/**
 * #1680 — replies the TERMINAL writes back to a query the app sent: no key
 * makes them, and an app redrawing (e.g. after `/clear` or `/new`) may ask.
 * Each form is anchored on a final byte or prefix no key encoding uses.
 * xterm.js 6.0.0 (the renderer and the web terminal) answers, in
 * src/common/InputHandler.ts and src/browser/CoreBrowserTerminal.ts:
 *   DA1 `CSI ? … c`, DA2 `CSI > … c`, DSR status `CSI 0 n`, DECRQM
 *   `CSI ? … $ y` / `CSI … $ y`, window reports `CSI 4|6|8 ; … t`, DECRQSS
 *   `DCS 0|1 $ r … ST`, OSC 4/10/11/12 color reports (ST or BEL), and the
 *   cursor position reports below. Also covered, from other terminals that
 *   may sit behind the web or phone input: DA3 `DCS ! | … ST`, XTVERSION
 *   `DCS > | … ST`, and the kitty keyboard flags reply `CSI ? flags u`.
 */
// eslint-disable-next-line no-control-regex
const TERMINAL_REPLY = new RegExp(
  [
    '\\x1b\\[[?>][\\d;]*c', // DA1, DA2
    '\\x1b\\[0n', // DSR: terminal OK
    '\\x1b\\[\\??[\\d;]+\\$y', // DECRQM (ANSI and DEC private)
    '\\x1b\\[[468](?:;\\d+)+t', // window size reports
    '\\x1b\\[\\?\\d+(?:;\\d+)+R', // DECXCPR
    '\\x1b\\[\\?\\d+u', // kitty keyboard flags
    '\\x1bP(?:[01]\\$r|!\\||>\\|)[^\\x1b\\x07]*(?:\\x1b\\\\|\\x07)', // DECRQSS, DA3, XTVERSION
    '\\x1b\\](?:4;\\d+|1[0-2]);[^\\x1b\\x07]*(?:\\x1b\\\\|\\x07)', // OSC color reports
  ].join('|'),
  'g',
);

/**
 * CPR `CSI row ; col R`. The one reply a key can collide with: xterm.js
 * sends F3 with modifiers as `CSI 1 ; m R`, m = 1 + (shift 1, alt 2, ctrl 4,
 * meta 8) — so 2..16 (src/common/input/Keyboard.ts). A CPR for row 1 and a
 * column 2..16 is therefore left counted as a key: wrongly counting a reply
 * can only make a fresh-context step skip or fail, wrongly dropping a key
 * could let a delivery type over someone's input. Every other CPR (row > 1,
 * or a column past 16) cannot be a key and is dropped.
 */
// eslint-disable-next-line no-control-regex
const CPR = /\x1b\[(\d+);(\d+)R/g;

/**
 * Remove only PASSIVE input: focus reports, SGR mouse reports that are pure
 * motion (motion flag 32 set, button bits 3 = none, no wheel flag 64), and
 * the terminal's own replies to queries (TERMINAL_REPLY, CPR). Presses,
 * releases and wheel reports stay — they can select or dismiss.
 */
export function stripPassiveInput(data: string): string {
  return data
    .replace(FOCUS_REPORT, '')
    .replace(TERMINAL_REPLY, '')
    .replace(CPR, (seq, row: string, col: string) =>
      Number(row) === 1 && Number(col) >= 2 && Number(col) <= 16 ? seq : '')
    .replace(SGR_MOUSE, (seq, b: string) => {
      const code = Number(b);
      const pureMotion = (code & 32) !== 0 && (code & 3) === 3 && (code & 64) === 0;
      return pureMotion ? '' : seq;
    });
}
