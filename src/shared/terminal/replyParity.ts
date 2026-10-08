/**
 * Keep the query replies xterm.js 6.0 gave.
 *
 * xterm.js 6.1 answers two queries 6.0 left unanswered, both on by default:
 *
 *  - XTVERSION (`CSI > q`) with `DCS > | xterm.js(<version>) ST`. Agents read
 *    this reply to pick terminal-specific behaviour, so answering it changes
 *    what Claude Code / Codex do inside a pane.
 *  - Color-scheme query (`CSI ? 996 n`) with `CSI ? 997 ; 1|2 n`, plus
 *    unsolicited reports on theme change once an app sets DECSET 2031.
 *
 * The 6.1 upgrade is meant to change no behaviour, so every interactive
 * terminal (local pane, remote mirror, web page) keeps both unanswered until
 * turning them on is decided on its own. A CSI handler registered through the
 * public parser API runs before xterm's built-in one and, by returning true,
 * stops it; the color-scheme reply has its own option.
 */

interface ReplyParityTerminal {
  options: { vtExtensions?: object };
  parser: {
    registerCsiHandler(
      id: { prefix?: string; final: string },
      callback: (params: (number | number[])[]) => boolean,
    ): { dispose(): void };
  };
}

/** Swallow the replies 6.0 never sent. Call once per terminal; the handler
 *  lives as long as the terminal does. */
export function holdNewXtermReplies(term: ReplyParityTerminal): void {
  term.options.vtExtensions = { ...term.options.vtExtensions, colorSchemeQuery: false };
  term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, () => true);
}
