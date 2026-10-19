import type { DaemonSession } from './types';

export interface RecoverySelection {
  /** IDs of sessions that should be recreated as live PTYs on this launch. */
  recoverableIds: Set<string>;
  /** Count of sessions intentionally skipped because the cap was exceeded. */
  cappedCount: number;
}

/**
 * Pick the most recently active non-dead sessions for recovery.
 *
 * Sessions outside the cap stay in `state.sessions` verbatim. They may
 * become recoverable on a later launch once the live count drops, or
 * get reaped by `SUSPENDED_TTL_HOURS` in `StateWriter.load` if they
 * keep idling.
 *
 * Pulled out of `recoverSessions` so the cap policy is unit-testable
 * without spinning up the full daemon main(): see
 * `src/daemon/__tests__/recoverySelector.test.ts`.
 *
 * @param sessions  Loaded `state.sessions` array.
 * @param cap       Maximum number of sessions to recover this launch.
 *                  In production this is `MAX_RECOVER_SESSIONS = 40`.
 */
export function selectRecoverableSessions(
  sessions: readonly DaemonSession[],
  cap: number,
): RecoverySelection {
  const queue = sessions
    .filter((s) => s.state !== 'dead')
    .slice()
    .sort(
      (a, b) =>
        new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime(),
    );
  const recoverableIds = new Set(queue.slice(0, cap).map((s) => s.id));
  return {
    recoverableIds,
    cappedCount: queue.length - recoverableIds.size,
  };
}

/**
 * Stop the shells a previous daemon left running, a few sessions at a time.
 *
 * Each `reap` is expected to confirm the process identity itself and kill
 * right after that check, so no pid is acted on with a stale verdict. Every
 * returned promise settles, even when a check throws, so the recovery loop
 * can await a session's entry before recreating that session.
 */
export function startLeftoverShellReaps(
  sessions: readonly DaemonSession[],
  opts: {
    limit: number;
    isAlive: (pid: number) => Promise<boolean>;
    reap: (session: DaemonSession) => Promise<unknown>;
  },
): Map<string, Promise<void>> {
  const done = new Map<string, Promise<void>>();
  const resolvers = new Map<string, () => void>();
  for (const s of sessions) {
    done.set(s.id, new Promise<void>((resolve) => resolvers.set(s.id, resolve)));
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < sessions.length) {
      const s = sessions[next++];
      try {
        if (await opts.isAlive(s.pid)) await opts.reap(s);
      } catch {
        /* treated as gone: nothing is killed */
      } finally {
        resolvers.get(s.id)?.();
      }
    }
  };
  for (let i = 0; i < Math.min(opts.limit, sessions.length); i++) void worker();
  return done;
}
