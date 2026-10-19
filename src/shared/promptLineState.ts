/**
 * F26 — has the shell read a command line since the pane started? Read from
 * the pane's OSC 133 events (daemon PromptEventLog) and the size of its output.
 *
 *   - 'read': the shell took a line. A `command_start` (C, bash's PS0), or a
 *     `command_end` (D) that follows a `prompt_start` (A): a line bash could
 *     not parse never shows C but still comes back with D. The very first D
 *     of a session (bash prints `D;$? A` before its first prompt) has no A
 *     before it and is not a read.
 *   - 'idle-at-prompt': no line was read, the shell's last marker is the end
 *     of its prompt (B), and it has written at most `slackBytes` since. A
 *     line that reached the shell would have been echoed right after that
 *     prompt. A caller that watches the output stay still over time itself
 *     (a repaint after a resize is output too) passes a larger slack.
 *   - 'unknown': anything else — no markers (no shell integration), a prompt
 *     not drawn yet, or output after the prompt that a shell without PS0
 *     running a program also produces. Never evidence either way.
 *
 * Pure: the daemon's launch check and main's launch-line delivery share it.
 */

export type PromptLineState = 'read' | 'idle-at-prompt' | 'unknown';

export interface PromptLineEvent {
  type: string;
  byteOffset: number;
}

/** Output after the prompt's B marker that still counts as idle. An echoed
 *  launch line is far longer; a cursor-visibility or focus sequence is not. */
export const IDLE_PROMPT_SLACK_BYTES = 64;

export function promptLineState(
  events: readonly PromptLineEvent[],
  totalBytesWritten: number,
  slackBytes: number = IDLE_PROMPT_SLACK_BYTES,
): PromptLineState {
  let promptSeen = false;
  for (const e of events) {
    if (e.type === 'command_start') return 'read';
    if (e.type === 'prompt_start') promptSeen = true;
    else if (e.type === 'command_end' && promptSeen) return 'read';
  }
  const last = events[events.length - 1];
  if (!last || last.type !== 'prompt_end') return 'unknown';
  return totalBytesWritten - last.byteOffset <= slackBytes ? 'idle-at-prompt' : 'unknown';
}
