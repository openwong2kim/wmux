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

export interface SubmitBracketedPasteOptions {
  /**
   * Re-checked immediately before the deferred Enter is written. Returning
   * false aborts the submit (the payload is already in the prompt's paste
   * buffer, but no newline is sent).
   *
   * Exists because the Enter rides a 100ms timeout: a pane can move onto a
   * permission menu inside that window, where a bare `\r` selects whatever
   * option is highlighted. Callers that hold a composer gate pass the gate
   * here so the deferred write obeys the state at fire time, not at call time
   * (Chat View eng-review A7).
   */
  submitGuard?: () => boolean;
}

export function submitBracketedPasteToPty(
  ptyId: string,
  text: string,
  write: (ptyId: string, data: string) => void = window.electronAPI.pty.write,
  opts?: SubmitBracketedPasteOptions,
): void {
  const isMultiLine = isMultilinePtyPayload(text);
  write(ptyId, formatBracketedPastePayload(text));
  setTimeout(() => {
    if (opts?.submitGuard && !opts.submitGuard()) return;
    write(ptyId, isMultiLine ? '\r\r' : '\r');
  }, DEFAULT_SUBMIT_DELAY_MS);
}
