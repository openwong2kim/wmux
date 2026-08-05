/**
 * Run a multi-step operation with a rolling no-progress watchdog.
 *
 * A fixed wall-clock timeout is unsafe for startup reconcile because one pass
 * can legitimately perform several serial daemon RPCs. Each RPC has its own
 * bounded timeout, so the watchdog should fire only when one stage stops making
 * progress, not merely because the complete pass took longer than one RPC.
 */

export interface ProgressTimeoutOptions {
  timeoutMs: number;
  label: string;
  /** Called immediately before the watchdog rejects (for example, to abort IO). */
  onTimeout?: () => void;
}

export function runWithProgressTimeout<T>(
  work: (reportProgress: () => void) => Promise<T>,
  options: ProgressTimeoutOptions,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearWatchdog = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const armWatchdog = () => {
      if (settled) return;
      clearWatchdog();
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        timer = null;
        try {
          options.onTimeout?.();
        } catch {
          // Timeout reporting must not replace the original watchdog failure.
        }
        reject(new Error(`${options.label} made no progress for ${options.timeoutMs}ms`));
      }, options.timeoutMs);
    };

    armWatchdog();
    void Promise.resolve()
      .then(() => work(armWatchdog))
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearWatchdog();
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearWatchdog();
          reject(error);
        },
      );
  });
}
