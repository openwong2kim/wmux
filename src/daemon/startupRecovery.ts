// ─── Whether the daemon's startup recovery has finished ────────────────────
//
// `daemon.listSessions` asked with `withRecovery: true` says it (#2393). The
// synchronous recovery pass runs before the pipe listens, so no client sees
// it. What a client can see is the background pass that follows: each WSL
// pane waits as a suspended placeholder until its distribution answers,
// which can take tens of seconds. Until that pass settles, a session list is
// no proof that an agent is gone. The pass counts as settled once every
// promotion it started has succeeded or failed (a failed one stays pending
// for the owner's Retry and never holds this back), or after
// STARTUP_RECOVERY_CEILING_MS, so a distribution that never answers cannot
// hold it back for good.

/** The background recovery counts as done after this long at the latest. */
export const STARTUP_RECOVERY_CEILING_MS = 5 * 60_000;

export interface StartupRecovery {
  /** Whether the background recovery pass has settled. */
  done(): boolean;
  /** The pass started these promotions (none: done at once). */
  track(promotions: ReadonlyArray<Promise<unknown>>): void;
}

export function createStartupRecovery(opts: {
  ceilingMs?: number;
  log?: (line: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
} = {}): StartupRecovery {
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  let settled = false;
  const finish = (line?: string): void => {
    if (settled) return;
    settled = true;
    if (line) opts.log?.(line);
  };
  return {
    done: () => settled,
    track(promotions) {
      if (settled) return;
      if (promotions.length === 0) {
        finish();
        return;
      }
      const ceiling = opts.ceilingMs ?? STARTUP_RECOVERY_CEILING_MS;
      const t = setTimer(() => {
        finish(`[recovery] background recovery still running after ${Math.round(ceiling / 1000)} s; session lists count as recovered from now on`);
      }, ceiling) as { unref?: () => void } | undefined;
      t?.unref?.();
      void Promise.allSettled(promotions).then(() => finish(`[recovery] background recovery settled (${promotions.length} pane(s))`));
    },
  };
}
