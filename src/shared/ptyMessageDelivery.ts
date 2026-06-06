/** Utilities for safe PTY delivery of structured inter-agent messages. */

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const VISIBLE_ESCAPE = '␛';

/**
 * Escape raw ESC bytes before wrapping a bracketed paste payload. Otherwise a
 * malicious body could include ESC [ 201 ~ to close the bracketed paste early.
 */
export function sanitizeBracketedPastePayload(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b/g, VISIBLE_ESCAPE);
}

export function formatBracketedPastePayload(text: string): string {
  return `${BRACKETED_PASTE_START}${sanitizeBracketedPastePayload(text)}${BRACKETED_PASTE_END}`;
}

export function isMultilinePtyPayload(text: string): boolean {
  return text.includes('\n') || text.includes('\r');
}
