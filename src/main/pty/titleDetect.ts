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
