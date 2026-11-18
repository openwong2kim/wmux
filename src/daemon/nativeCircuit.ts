/**
 * The circuit breaker of a native snapshot backend (Text/AnsiSnapshotBackend).
 *
 * A module error (a load failure, a throw, a malformed result) opens it for
 * that module path, and requests skip native while it is open. It no longer
 * stays open for the life of the daemon: after a cooldown one request is let
 * through as a trial. A trial on which the module worked (a snapshot, a
 * refusal, a budget run-out) closes it; a trial that errors again reopens it
 * with the next, longer cooldown. Pointing the backend at another module path
 * closes it at once, as before.
 */

/** Waits after each consecutive failure; the last one repeats. */
export const NATIVE_CIRCUIT_COOLDOWNS_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000, 600_000];

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface NativeCircuit {
  /** What a request for `path` meets at `now`. Read-only: a half-open circuit
   *  admits a request only once `beginTrial` is called. */
  state(path: string | undefined, now: number): CircuitState;
  /** Take the half-open slot: until `settle`, further requests see `open`. */
  beginTrial(path: string | undefined): void;
  /** The outcome of a native attempt: `sound` when the module worked. */
  settle(path: string | undefined, sound: boolean, now: number): void;
  /** Open (cooling down or on trial) for `path`, for diagnostics. */
  isOpen(path: string | undefined): boolean;
  /** Consecutive module failures for `path` (0 when closed). */
  failures(path: string | undefined): number;
}

export function createNativeCircuit(cooldowns: readonly number[] = NATIVE_CIRCUIT_COOLDOWNS_MS): NativeCircuit {
  let open: { path: string | undefined; failures: number; retryAt: number; trial: boolean } | undefined;
  const forPath = (path: string | undefined) => {
    // Another module: what failed was a different file.
    if (open && open.path !== path) open = undefined;
    return open;
  };
  return {
    state(path, now) {
      const current = forPath(path);
      if (!current) return 'closed';
      return current.trial || now < current.retryAt ? 'open' : 'half-open';
    },
    beginTrial(path) {
      const current = forPath(path);
      if (current) current.trial = true;
    },
    settle(path, sound, now) {
      const current = forPath(path);
      if (sound) {
        open = undefined;
        return;
      }
      const failures = (current?.failures ?? 0) + 1;
      open = { path, failures, retryAt: now + cooldowns[Math.min(failures, cooldowns.length) - 1], trial: false };
    },
    isOpen: (path) => !!forPath(path),
    failures: (path) => forPath(path)?.failures ?? 0,
  };
}
