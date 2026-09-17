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
  submitProfileForAgent,
} from '../../shared/ptyMessageDelivery';

export { formatBracketedPastePayload, sanitizeBracketedPastePayload };

export interface SubmitBracketedPasteOptions {
  /**
   * The receiving pane's agent, as a canonical slug or the display name the
   * renderer holds (`surfaceAgent[ptyId].name`). Selects the gap before Enter
   * — see `submitProfileForAgent` for why a paste-burst TUI needs a wider one
   * (#1337). Omitted (the pre-existing behavior of every call site that does
   * not know its receiver) keeps the 100 ms default.
   */
  agent?: string | null;
  /** Injection seam for tests. */
  write?: (ptyId: string, data: string) => void;
}

export function submitBracketedPasteToPty(
  ptyId: string,
  text: string,
  options: SubmitBracketedPasteOptions = {},
): void {
  const write = options.write ?? window.electronAPI.pty.write;
  const isMultiLine = isMultilinePtyPayload(text);
  write(ptyId, formatBracketedPastePayload(text));
  setTimeout(() => {
    write(ptyId, isMultiLine ? '\r\r' : '\r');
  }, submitProfileForAgent(options.agent).submitDelayMs);
}

