/**
 * F26 — a fan-out task pane's launch line, checked after it was written.
 *
 * scheduleInitialCommand counts a write as delivered once the bytes are handed
 * to the session socket. That is not the shell reading them: the renderer's
 * reattach of a new pane tears the create-time socket down (pty:reconnect,
 * connectSessionPipe forceFresh) about when the line is written, and a line
 * typed while wsl.exe is still starting the distro has nothing reading it
 * yet. The pane then sits at a bare prompt and the task is reported running.
 *
 * So, for a task pane only: poll the pane's prompt markers (promptLineState)
 * until the shell has read a line. The line is written once more only on
 * positive evidence that it never arrived, all of it required:
 *
 *   - a prompt drawn AFTER the line was typed (its B marker lies beyond the
 *     output size read right after the write) and no line read since — no
 *     command-start, no return to a prompt after a line;
 *   - next to nothing written after that prompt (promptLineState's slack): a
 *     line the shell took is echoed there;
 *   - that output standing still for `quietMs`;
 *   - the daemon's word that nothing runs in the pane (`nothingRunning`: no
 *     agent, no foreground command, and a process-table read showing the
 *     shell with no child process); and the pane still exactly as it was in
 *     the snapshot the decision was made on. That last check and the write
 *     are one step in the daemon (daemon.writeIfUnchanged), so an echo or a
 *     command-start that lands meanwhile stops the write. No probe lists a
 *     WSL shell's Linux children, so a WSL pane is never written to twice:
 *     its lost line is left to the launch check (launchPresenceAllowsResend).
 *
 * A prompt drawn before the write proves nothing: a shell that shows no
 * command-start (macOS /bin/bash 3.2 has no PS0) reads the line and runs it
 * with that prompt still its last marker, and a quiet program then looks like
 * an idle shell (F26 review). Whether a shell shows command-start cannot be
 * known before its first line, so no shell is trusted to.
 *
 * Never a third write: a second idle stretch gives up. Anything short of the
 * evidence ends as 'unverified', which the caller logs; the fan-out launch
 * check (#1919) still has the final word on the task.
 *
 * Electron-free so the timing has direct unit coverage.
 */

import { promptLineState, type PromptLineEvent } from '../../../shared/promptLineState';

export const LAUNCH_LINE_VERIFY_WINDOW_MS = 40_000;
export const LAUNCH_LINE_POLL_MS = 750;
export const LAUNCH_LINE_QUIET_MS = 4_000;

export interface LaunchLineRead {
  events: PromptLineEvent[];
  /** The session's whole prompt log size; `events` may be only its newest
   *  page. Absent from an older daemon. */
  eventCount?: number;
  totalBytesWritten: number;
  sessionFound: boolean;
}

/** The pane as the decision saw it (daemon/writeIfUnchanged.ts). */
export interface LaunchLineExpectation {
  outputBytes: number;
  markerCount: number;
  lastPromptMarker: { type: string; byteOffset: number } | null;
}

export type LaunchLineOutcome = 'read' | 'resent' | 'gave-up' | 'unverified' | 'gone';

export interface VerifyLaunchLineOptions {
  /** The pane's prompt events and output size; null when the read failed. */
  read: () => Promise<LaunchLineRead | null>;
  /** Write the launch line again (the same bytes the first write sent), only
   *  if the pane still matches `expect`; resolves whether it was written. */
  resendIfUnchanged: (expect: LaunchLineExpectation) => Promise<boolean>;
  /** True only on the daemon's positive evidence that nothing runs in the
   *  pane (daemon.getLaunchPresence `absent`); anything else is false. */
  nothingRunning: () => Promise<boolean>;
  windowMs?: number;
  pollMs?: number;
  quietMs?: number;
  /** Called once with how it ended. */
  onDone?: (outcome: LaunchLineOutcome) => void;
}

export function verifyLaunchLine(opts: VerifyLaunchLineOptions): { cancel: () => void } {
  const windowMs = opts.windowMs ?? LAUNCH_LINE_VERIFY_WINDOW_MS;
  const pollMs = opts.pollMs ?? LAUNCH_LINE_POLL_MS;
  const quietMs = opts.quietMs ?? LAUNCH_LINE_QUIET_MS;
  const started = Date.now();
  let resent = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The pane's output size just after the line was typed; a prompt drawn
   *  past it is a prompt drawn after the line. Null until read. */
  let writtenAt: number | null = null;
  /** Output size when the pane was first seen idle at its prompt, and when. */
  let idle: { bytes: number; at: number } | null = null;

  const finish = (outcome: LaunchLineOutcome): void => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    opts.onDone?.(outcome);
  };

  const safeRead = async (): Promise<LaunchLineRead | null> => {
    try {
      return await opts.read();
    } catch {
      return null;
    }
  };

  const poll = async (): Promise<void> => {
    if (finished) return;
    const r = await safeRead();
    if (finished) return;
    if (r && !r.sessionFound) return finish('gone');
    const now = Date.now();
    const state = r ? promptLineState(r.events, r.totalBytesWritten) : 'unknown';
    if (state === 'read') return finish(resent ? 'resent' : 'read');
    const prompt = r?.events[r.events.length - 1];
    const freshPrompt = state === 'idle-at-prompt' && writtenAt !== null && !!prompt && prompt.byteOffset > writtenAt;
    if (freshPrompt && r) {
      if (!idle || idle.bytes !== r.totalBytesWritten) {
        idle = { bytes: r.totalBytesWritten, at: now };
      } else if (now - idle.at >= quietMs) {
        if (resent) return finish('gave-up');
        idle = null;
        let quiet = false;
        try {
          quiet = await opts.nothingRunning();
        } catch {
          quiet = false;
        }
        if (finished) return;
        if (quiet) {
          // The daemon decided on state it read before its process walk, and
          // the shell may take the first line at any moment: write only if the
          // pane still matches the snapshot this decision started from.
          const last = r.events[r.events.length - 1];
          let written = false;
          try {
            written = await opts.resendIfUnchanged({
              outputBytes: r.totalBytesWritten,
              markerCount: r.eventCount ?? r.events.length,
              lastPromptMarker: last ? { type: last.type, byteOffset: last.byteOffset } : null,
            });
          } catch {
            written = false;
          }
          if (finished) return;
          if (!written) return finish('unverified');
          resent = true;
        }
      }
    } else {
      idle = null;
    }
    if (Date.now() - started >= windowMs) return finish(resent ? 'gave-up' : 'unverified');
    timer = setTimeout(() => void poll(), pollMs);
    timer.unref?.();
  };

  // The output size right after the write: read at once, before any wait.
  void (async () => {
    const r = await safeRead();
    if (finished) return;
    if (r && !r.sessionFound) return finish('gone');
    writtenAt = r ? r.totalBytesWritten : null;
    timer = setTimeout(() => void poll(), pollMs);
    timer.unref?.();
  })();
  return { cancel: () => finish('gone') };
}
