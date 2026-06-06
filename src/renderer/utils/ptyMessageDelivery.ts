/**
 * Helpers for delivering structured inter-agent messages to PTYs.
 *
 * A2A/company notifications are not typed by the local user; they can include
 * sender-controlled text and are delivered across workspace boundaries. Always
 * bracket them as terminal paste data so embedded line breaks are inserted into
 * paste-aware prompts instead of being interpreted as individual keystrokes.
 */

import {
  formatBracketedPastePayload,
  isMultilinePtyPayload,
  sanitizeBracketedPastePayload,
} from '../../shared/ptyMessageDelivery';

export { formatBracketedPastePayload, sanitizeBracketedPastePayload };

const DEFAULT_SUBMIT_DELAY_MS = 100;

export function submitBracketedPasteToPty(
  ptyId: string,
  text: string,
  write: (ptyId: string, data: string) => void = window.electronAPI.pty.write,
): void {
  const isMultiLine = isMultilinePtyPayload(text);
  write(ptyId, formatBracketedPastePayload(text));
  setTimeout(() => {
    write(ptyId, isMultiLine ? '\r\r' : '\r');
  }, DEFAULT_SUBMIT_DELAY_MS);
}
