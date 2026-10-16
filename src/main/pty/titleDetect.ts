/**
 * Window-title detection helper for OSC 0/2 ("set window title") sequences.
 *
 * Pure (no Electron/Node deps) so the sanitizer that turns untrusted shell
 * output into a safe tab title has direct regression coverage — sibling to
 * cwdDetect.ts. Both feed renderer surface fields off the same PTY data path.
 */

/** Max tab-title length, matching the pane-label cap (PANE_METADATA_LABEL_MAX). */
export const TERMINAL_TITLE_MAX = 64;

/**
 * Sanitize an OSC 0/2 window-title payload (untrusted shell output) into a safe
 * tab title: replace C0 controls, DEL, and C1 controls (covers CR/LF/TAB, BEL
 * \x07, and any ST/BEL terminator bytes that survive OSC parsing) with spaces,
 * collapse runs of whitespace, trim, and cap to TERMINAL_TITLE_MAX. Returns ''
 * when nothing printable remains.
 */
export function sanitizeTitle(raw: string): string {
  const stripped = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > TERMINAL_TITLE_MAX
    ? stripped.slice(0, TERMINAL_TITLE_MAX)
    : stripped;
}

/**
 * Claude Code's window title (#2264), as captured on 2.1.301: `◐ <name>` /
 * `◑ <name>` alternate about once a second while a turn runs (thinking, tools,
 * streaming), reduced motion included, and `✳ <name>` is set when the turn
 * ends or is interrupted.
 */
const CLAUDE_IDLE_TITLE = /^✳\s/;
/** What Claude Code's spinner row says while a turn's Stop hooks run. */
const CLAUDE_STOP_HOOK_ROW = 'running Stop hook';

/**
 * Reads Claude Code's title saying a turn is over, one pane each.
 *
 * An Esc while Claude Code is still thinking ends the turn without the
 * `⎿  Interrupted` row: it blanks the spinner row, puts the prompt back in the
 * composer and sets the idle title, 84-107 ms after the Esc in every capture.
 * That title is the one thing it draws that says the turn is over. A running
 * title is not required before it: the first one comes about 0.9 s after the
 * submit, and an Esc before that (300 ms in a capture) goes straight to idle.
 * The callers decide whether it means anything: only right after a lone Esc,
 * on a pane whose turn is still open.
 */
export class ClaudeTitleTurnEdge {
  private stopHookRan = false;
  /** The end of the last chunk, so a row split across two reads still matches. */
  private tail = '';

  /**
   * Feed the pane's output, before its titles are read. A turn that ends on
   * its own runs its Stop hooks first, under `running Stop hook · 3s` on the
   * spinner row, about 300 ms before the idle title (live capture). No
   * interrupted turn draws that row, so such an idle title is an ordinary turn
   * end, even right after an Esc that only closed a popup. The whole phrase is
   * matched, not the escape bytes around it: those depend on what the diff
   * renderer already had on screen.
   */
  noteOutput(data: string): void {
    const text = this.tail + data;
    if (text.includes(CLAUDE_STOP_HOOK_ROW)) this.stopHookRan = true;
    this.tail = text.slice(-(CLAUDE_STOP_HOOK_ROW.length - 1));
  }

  /** Feed one sanitized title. True for an idle title with no Stop-hook row since the last one. */
  observe(title: string): boolean {
    if (!CLAUDE_IDLE_TITLE.test(title)) return false;
    const ended = !this.stopHookRan;
    this.stopHookRan = false;
    this.tail = '';
    return ended;
  }
}
