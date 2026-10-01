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
  type GatedSubmitOptions,
  type GatedSubmitResult,
} from '../../shared/ptyMessageDelivery';

export { formatBracketedPastePayload, sanitizeBracketedPastePayload };
export type { GatedSubmitResult };

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


/**
 * Paste `text` into `ptyId` and submit it through main's approval gate
 * (IPC.GATED_SUBMIT). For every delivery made on a non-operator's behalf —
 * agent-to-agent tasks, company messages, channel mention nudges: an Enter into
 * a pane showing an approval would answer it. Main runs the gate before the
 * paste and again before the Enter. Never throws; a bridge that is missing or
 * fails is `gate_unavailable` (nothing is written from here either way).
 */
export async function gatedSubmitToPty(
  ptyId: string,
  text: string,
  options: { agent?: string | null } & GatedSubmitOptions = {},
): Promise<GatedSubmitResult> {
  const submit = (window.electronAPI?.rpc as { gatedSubmit?: unknown } | undefined)?.gatedSubmit as
    | ((id: string, body: string, agent?: string | null, opts?: GatedSubmitOptions) => Promise<GatedSubmitResult>)
    | undefined;
  if (typeof submit !== 'function') {
    return { ok: false, reason: 'gate_unavailable', detail: 'delivery: approval gate unavailable' };
  }
  try {
    // `newTask` only when set, so every other delivery calls exactly as before.
    const result = options.newTask
      ? await submit(ptyId, text, options.agent ?? null, {
          newTask: true,
          ...(options.keepContext ? { keepContext: options.keepContext } : {}),
          ...(options.taskId ? { taskId: options.taskId } : {}),
          ...(options.pane ? { pane: options.pane } : {}),
        })
      : await submit(ptyId, text, options.agent ?? null);
    return result && typeof result === 'object' && 'ok' in result
      ? result
      : { ok: false, reason: 'gate_unavailable', detail: 'delivery: approval gate returned no answer' };
  } catch (err) {
    return {
      ok: false,
      reason: 'gate_unavailable',
      detail: `delivery: approval gate failed (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}
