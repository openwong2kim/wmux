/**
 * Keep the behaviour xterm.js 6.0 had.
 *
 * xterm.js 6.1 turns on three things by default that 6.0 did not have:
 *
 *  - XTVERSION (`CSI > q`) is answered with `DCS > | xterm.js(<version>) ST`.
 *    Agents read this reply to pick terminal-specific behaviour, so answering
 *    it changes what Claude Code / Codex do inside a pane.
 *  - The color-scheme query (`CSI ? 996 n`) is answered with `CSI ? 997 ; 1|2 n`,
 *    plus unsolicited reports on theme change once an app sets DECSET 2031.
 *  - SGR 221 / 222 (kitty "not bold" / "not faint") are interpreted. 6.0
 *    ignored them, so text after them keeps its bold / faint.
 *
 * The 6.1 upgrade is meant to change no behaviour, so every terminal keeps all
 * three off until turning them on is decided on its own. The SGR one changes
 * what lands in the grid, so it must match in EVERY grid: the interactive
 * terminals (local pane, remote mirror, web page) and the daemon's headless
 * snapshot terminals, or a restored snapshot paints differently from the live
 * screen. A CSI handler registered through the public parser API runs before
 * xterm's built-in one and, by returning true, stops it; the other two have
 * options.
 */

/** The 6.1 `vtExtensions` values that keep 6.0 behaviour. The headless
 *  snapshot terminals pass the grid-relevant one too. */
export const XTERM_60_VT_EXTENSIONS = {
  colorSchemeQuery: false,
  kittySgrBoldFaintControl: false,
} as const;

interface ReplyParityTerminal {
  options: { vtExtensions?: object };
  parser: {
    registerCsiHandler(
      id: { prefix?: string; final: string },
      callback: (params: (number | number[])[]) => boolean,
    ): { dispose(): void };
  };
}

/** Hold back what 6.0 never did. Call once per terminal; the handler lives as
 *  long as the terminal does. */
export function holdNewXtermReplies(term: ReplyParityTerminal): void {
  term.options.vtExtensions = { ...term.options.vtExtensions, ...XTERM_60_VT_EXTENSIONS };
  term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, () => true);
}
