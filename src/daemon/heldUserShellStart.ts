// #3049 — starting the user shells boot recovery held for main
// (recoverySelector heldForCredentials). Main starts each one with the
// credential values it passes in; whatever main has not started when the
// fallback fires starts without them, which is what recovery did before.

import { HELD_START_CONCURRENCY } from '../shared/userShellHolds';
import { runLimited } from '../shared/runLimited';

/**
 * How long after the control pipe opens the daemon waits before it starts the
 * held shells itself. Fixed: no client (main or any other) can cancel or
 * extend it, so a fake identify can only race main, never keep a shell down.
 */
export const HELD_START_FALLBACK_MS = 20_000;

/**
 * Whether a promote may be answered only for main, the first-party client: one
 * that carries credentials, and any promote of a held shell before the
 * fallback fires (so nothing else starts it without its credentials first).
 *
 * Honest scope: first-party is a classification over the one shared pipe
 * token (DaemonPipeServer.markFirstParty), not a second credential. It keeps
 * the CLI, MCP and an agent talked into a call from starting a held shell, or
 * from handing it values of their own; it does not stop a local process that
 * holds the token and identifies as main, which could type the same values
 * into the shell anyway (daemon.writeIfUnchanged).
 */
export function promoteNeedsFirstParty(opts: { credentialEnv: boolean; startPending: boolean; fallbackFired: boolean }): boolean {
  return opts.credentialEnv || (opts.startPending && !opts.fallbackFired);
}

export interface HeldStartFallback {
  /** Start every shell still held, without credentials. Runs its starts once. */
  fire(): Promise<void>;
  /** Whether the fallback has fired. */
  fired(): boolean;
}

/**
 * The fallback start. `start` is the daemon's promote, so a start main already
 * has in flight is joined rather than repeated, and a shell main started is no
 * longer held. One log line names how many shells it started.
 */
export function createHeldStartFallback(deps: {
  heldIds: () => string[];
  start: (id: string) => Promise<unknown>;
  log: (line: string) => void;
}): HeldStartFallback {
  let fired = false;
  return {
    fired: () => fired,
    fire: async () => {
      if (fired) return;
      fired = true;
      const ids = deps.heldIds();
      if (ids.length === 0) return;
      deps.log(`[recovery] ${ids.length} restored user shell(s) not started by the app within ${HELD_START_FALLBACK_MS / 1000}s; starting them without credentials`);
      await runLimited(ids, HELD_START_CONCURRENCY, deps.start);
    },
  };
}
