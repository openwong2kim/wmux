/**
 * Schedules a workspace-profile startup command for a just-created PTY.
 *
 * Extracted from pty.handler (electron-free) so the timing logic has direct
 * unit coverage. Why it is event-driven rather than a fixed delay: the previous
 * blind 200 ms timer was racy and dropped the command intermittently. Two
 * failure modes — (1) in daemon mode `writeToSession` returns false while the
 * session pipe is still mid-attach, and a single fire-and-forget write was
 * silently dropped; (2) on a busy box the shell hadn't reached its interactive
 * prompt at 200 ms, so the keystrokes were lost.
 *
 * This helper instead:
 *   - waits for the shell's FIRST output (caller invokes `onFirstData`), which
 *     signals the shell is alive and (daemon mode) the pipe is carrying data;
 *   - then waits a short settle for the prompt to finish rendering;
 *   - then writes, RETRYING while the write reports "not delivered" (the writer
 *     returns `false`) up to a bounded budget;
 *   - falls back to firing anyway if no output ever arrives;
 *   - invokes `onExhausted` if every retry reported "not delivered", so the
 *     caller can leave a diagnostic trail instead of a silent no-run.
 *
 * The command is written exactly once (guarded), and all timers are unref'd so
 * a pending command never keeps the process alive.
 */

export const INITIAL_COMMAND_SETTLE_MS = 120;
export const INITIAL_COMMAND_FALLBACK_MS = 3000;
export const INITIAL_COMMAND_RETRY_ATTEMPTS = 15;
export const INITIAL_COMMAND_RETRY_DELAY_MS = 80;

export interface ScheduleInitialCommandOptions {
  /** Perform the write. Return `false` to signal "not delivered, please retry". */
  write: (cmd: string) => boolean | void;
  /** Called once if the retry budget is exhausted with the write still undelivered. */
  onExhausted?: () => void;
  settleMs?: number;
  fallbackMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
}

export interface ScheduledInitialCommand {
  /** Call when the PTY produces its first output. Idempotent. */
  onFirstData: () => void;
}

const noop = () => {};

export function scheduleInitialCommand(
  command: string | undefined,
  opts: ScheduleInitialCommandOptions,
): ScheduledInitialCommand {
  if (!command || command.trim().length === 0) return { onFirstData: noop };

  const cmd = command;
  const settleMs = opts.settleMs ?? INITIAL_COMMAND_SETTLE_MS;
  const fallbackMs = opts.fallbackMs ?? INITIAL_COMMAND_FALLBACK_MS;
  const retryAttempts = opts.retryAttempts ?? INITIAL_COMMAND_RETRY_ATTEMPTS;
  const retryDelayMs = opts.retryDelayMs ?? INITIAL_COMMAND_RETRY_DELAY_MS;

  let fired = false;

  const fire = () => {
    if (fired) return;
    fired = true;
    let attempts = 0;
    const attempt = () => {
      let delivered: boolean | void;
      try {
        delivered = opts.write(cmd);
      } catch {
        return; // pane closed mid-write — best-effort, give up
      }
      if (delivered === false) {
        if (++attempts < retryAttempts) {
          setTimeout(attempt, retryDelayMs).unref?.();
        } else {
          opts.onExhausted?.();
        }
      }
    };
    setTimeout(attempt, settleMs).unref?.();
  };

  // Fallback so a silent shell still gets its command.
  const fallback = setTimeout(fire, fallbackMs);
  fallback.unref?.();

  return {
    onFirstData: () => {
      clearTimeout(fallback);
      fire();
    },
  };
}
