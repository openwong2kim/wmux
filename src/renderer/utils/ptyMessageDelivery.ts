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
   * Re-checked immediately before EACH write: the payload, and again before the
   * deferred Enter. Returning false at the first check writes nothing at all;
   * returning false at the second leaves the payload in the prompt's paste
   * buffer with no newline sent.
   *
   * Guarding the Enter alone was not enough. The Enter rides a 100ms timeout, so
   * a pane can move onto a permission menu inside that window where a bare `\r`
   * selects whatever option is highlighted — that is what the guard was added
   * for. But the PAYLOAD went out unconditionally at call time, so a caller
   * whose gate had engaged since its last render still pushed the user's text
   * into the menu. Callers that hold a composer gate pass it here and get both
   * writes covered (Chat View eng-review A7).
   *
   * KNOWN LIMITATION: this is renderer-side, so it is not atomic against the
   * PTY. The gate can engage between the guard returning true and the write
   * landing in the daemon — closing that window needs a guarded-write RPC that
   * re-checks approval state in the process that owns the PTY, which is
   * deliberately out of scope here.
   */
  submitGuard?: () => boolean;
}

/**
 * Returns false when the guard refused and NOTHING was written — callers that
 * echo the message optimistically should not echo a message that never left.
 */
export function submitBracketedPasteToPty(
  ptyId: string,
  text: string,
  write: (ptyId: string, data: string) => void = window.electronAPI.pty.write,
  opts?: SubmitBracketedPasteOptions,
): boolean {
  if (opts?.submitGuard && !opts.submitGuard()) return false;
  const isMultiLine = isMultilinePtyPayload(text);
  write(ptyId, formatBracketedPastePayload(text));
  setTimeout(() => {
    if (opts?.submitGuard && !opts.submitGuard()) return;
    write(ptyId, isMultiLine ? '\r\r' : '\r');
  }, DEFAULT_SUBMIT_DELAY_MS);
  return true;
}
