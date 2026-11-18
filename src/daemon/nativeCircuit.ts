/**
 * The circuit breaker of a native snapshot backend (Text/AnsiSnapshotBackend).
 *
 * A module error (a load failure, a throw, a malformed result) opens it for
 * that module path, and requests skip native while it is open. It no longer
 * stays open for the life of the daemon: after a cooldown one request is let
 * through as a trial. A trial on which the module worked (a snapshot, a
 * refusal, a budget run-out) closes it; a trial that errors, or does not
 * settle within TRIAL_TIMEOUT_MS, reopens it with the next, longer cooldown.
 * Another module path starts closed, as before.
 *
 * Each admitted attempt carries the generation it was admitted in, and only an
 * attempt of the current generation may change the state: an older attempt
 * still in flight when the circuit opened, closed or started a trial is
 * ignored when it settles. Reads (isOpen, failures) change nothing.
 */

/** Waits after each consecutive failure; the last one repeats. */
export const NATIVE_CIRCUIT_COOLDOWNS_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000, 600_000];
/** A trial that has not settled by then counts as a failed one. */
export const NATIVE_CIRCUIT_TRIAL_TIMEOUT_MS = 60_000;

/** The module the native snapshot loads, as the backends key their circuit. */
export function snapshotModulePath(): string | undefined {
  return process.env.WMUX_TERMINAL_CORE_MODULE ?? process.env.WMUX_RUST_SNAPSHOT_MODULE;
}

/** An admitted native attempt; hand it back to `settle` with its outcome. */
export interface CircuitTicket {
  readonly path: string | undefined;
  readonly generation: number;
}

export interface NativeCircuit {
  /** A ticket to try native for `path` at `now`, or null to skip it. A
   *  half-open circuit admits one request, its trial; the rest skip until it settles. */
  admit(path: string | undefined, now: number): CircuitTicket | null;
  /** The outcome of an admitted attempt: `sound` when the module worked. */
  settle(ticket: CircuitTicket, sound: boolean, now: number): void;
  /** Skipping native for `path` at `now` (cooling down, or a trial is out). */
  isOpen(path: string | undefined, now: number): boolean;
  /** Module errors in a row for `path`, a trial that timed out by `now` included; 0 once a trial found the module working. */
  failures(path: string | undefined, now: number): number;
}

interface Opened {
  path: string | undefined;
  failures: number;
  retryAt: number;
  /** When the trial was admitted; undefined while none is out. */
  trialAt?: number;
}

export function createNativeCircuit(
  cooldowns: readonly number[] = NATIVE_CIRCUIT_COOLDOWNS_MS,
  trialTimeoutMs: number = NATIVE_CIRCUIT_TRIAL_TIMEOUT_MS,
): NativeCircuit {
  let opened: Opened | undefined;
  let generation = 0;
  const reopen = (path: string | undefined, failures: number, now: number): void => {
    opened = { path, failures, retryAt: now + cooldowns[Math.min(failures, cooldowns.length) - 1] };
    generation++;
  };
  /** The open state for `path`, with a trial that outlived its timeout counted as failed. */
  const current = (path: string | undefined, now: number): Opened | undefined => {
    if (!opened || opened.path !== path) return undefined;
    if (opened.trialAt !== undefined && now - opened.trialAt >= trialTimeoutMs) reopen(path, opened.failures + 1, now);
    return opened;
  };
  return {
    admit(path, now) {
      const open = current(path, now);
      if (!open) {
        // Another module: what failed was a different file.
        if (opened && opened.path !== path) { opened = undefined; generation++; }
        return { path, generation };
      }
      if (open.trialAt !== undefined || now < open.retryAt) return null;
      open.trialAt = now;
      generation++;
      return { path, generation };
    },
    settle(ticket, sound, now) {
      if (ticket.generation !== generation) return;
      if (sound) {
        if (opened) { opened = undefined; generation++; }
        return;
      }
      const open = opened && opened.path === ticket.path ? opened : undefined;
      reopen(ticket.path, (open?.failures ?? 0) + 1, now);
    },
    isOpen(path, now) {
      if (!opened || opened.path !== path) return false;
      const trialExpired = opened.trialAt !== undefined && now - opened.trialAt >= trialTimeoutMs;
      return (opened.trialAt !== undefined && !trialExpired) || now < opened.retryAt;
    },
    failures(path, now) {
      if (!opened || opened.path !== path) return 0;
      const trialExpired = opened.trialAt !== undefined && now - opened.trialAt >= trialTimeoutMs;
      return opened.failures + (trialExpired ? 1 : 0);
    },
  };
}
