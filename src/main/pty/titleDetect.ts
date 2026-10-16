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
 * Claude Code's window-title spinner (#2264), as captured on 2.1.301: the
 * title alternates `◐ <name>` / `◑ <name>` about once a second for the whole
 * turn (thinking, tools, streaming), reduced motion included, and turns
 * `✳ <name>` when the turn ends or is interrupted.
 */
const CLAUDE_BUSY_TITLE = /^[◐◑]\s/;
const CLAUDE_IDLE_TITLE = /^✳\s/;

/**
 * Reads the busy-to-idle edge of Claude Code's title spinner, one pane each.
 *
 * An Esc while Claude Code is still thinking ends the turn without the
 * `⎿  Interrupted` row: it blanks the spinner row, puts the prompt back in the
 * composer and sets the idle title. The title edge is the one thing it draws
 * that says the turn is over. Only an edge counts: a repeated idle title, or
 * one with no running title before it, says nothing about a turn.
 */
export class ClaudeTitleTurnEdge {
  private busy = false;
  private stopHookRan = false;

  /**
   * Feed the pane's output, before its titles are read. A turn that ends on
   * its own runs its Stop hooks first, under `running Stop hook · 3s` on the
   * spinner row, about 300 ms before the idle title (live capture). No
   * interrupted turn draws that row, so such an edge is an ordinary turn end
   * even right after an Esc that only closed a popup.
   */
  noteOutput(data: string): void {
    if (this.busy && data.includes('Stop hook')) this.stopHookRan = true;
  }

  /** Feed one sanitized title. True when it ends a turn the title showed running without its Stop hooks. */
  observe(title: string): boolean {
    if (CLAUDE_BUSY_TITLE.test(title)) {
      this.busy = true;
      return false;
    }
    const ended = this.busy && !this.stopHookRan && CLAUDE_IDLE_TITLE.test(title);
    this.busy = false;
    this.stopHookRan = false;
    return ended;
  }
}
