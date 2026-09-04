// ─── LedgerPort — the one seam between the gate runner and the task ledger ───
//
// The gate runner records its verdict in the task ledger (src/shared/ledger.ts)
// and never touches the store directly — it calls this interface, and exactly
// one adapter knows where the ledger actually lives. Every test in this
// directory injects a fake instead.
//
// WHERE IT LIVES, and why the adapter is not an RPC (integration lane): the
// TaskLedger instance is HOSTED IN MAIN (`deck/taskLedgerHost.ts`), the same
// process as the gate runner, so `createHostedLedgerPort` calls it in-process.
// Going out over `ledger.update` would not work even as a round trip: that
// handler REFUSES a `gate` field from any wire caller by design ("gate results
// are recorded by the gate runner, not by callers"), because a caller-written
// `exitCode: 0` is exactly the self-certification the ledger exists to prevent.
// The privileged write is `TaskLedger.recordGate`, which only a `system` actor
// may perform — and this adapter is the only thing that performs it.
//
// Compare-and-swap, not last-write-wins: `LedgerEntry.rev` is monotonic and the
// writer refuses a stale `expectedRev`, so a caller must READ before it writes.
// That is why `read` exists here at all — a port with only `update` would force
// every caller to invent a revision. `recordGate` bumps the rev itself and does
// not take an `expectedRev`, so the check the runner does against the snapshot
// it read is this adapter's job (below).

import type { LedgerActor, LedgerGateResult } from '../../shared/ledger';
import type { TaskLedger } from '../../daemon/ledger/TaskLedger';
import { getTaskLedger } from '../deck/taskLedgerHost';

/** The snapshot a writer needs before it may write: the revision it read. */
export interface LedgerSnapshot {
  id: string;
  rev: number;
}

export interface LedgerGateWrite {
  taskId: string;
  /** The `rev` of the entry this write was computed from (compare-and-swap). */
  expectedRev: number;
  /** Always `{ kind: 'system' }` for the gate runner — the daemon ran it, not
   *  the worker whose code it graded. */
  actor: LedgerActor;
  gate: LedgerGateResult;
}

export type LedgerWriteResult =
  | { ok: true; rev: number }
  /** `conflict` = someone else wrote first; the caller must re-read and retry.
   *  `unavailable` = the daemon is not reachable, which must NOT fail the gate:
   *  the gate ran, only its receipt is missing. */
  | { ok: false; reason: 'conflict' | 'not_found' | 'unavailable' | 'refused'; error: string };

export interface LedgerPort {
  read(taskId: string): Promise<LedgerSnapshot | null>;
  writeGate(write: LedgerGateWrite): Promise<LedgerWriteResult>;
}

/**
 * The one adapter, bound to the main-hosted TaskLedger.
 *
 * `getLedger` is injected only by tests; production passes nothing and gets the
 * hosted instance. A throw from the store — an unreadable ledger file, a host
 * that has not booted — becomes `unavailable`, which the gate runner already
 * treats as "the gate ran, its receipt is missing" rather than as a failure.
 */
export function createHostedLedgerPort(getLedger: () => TaskLedger = getTaskLedger): LedgerPort {
  return {
    async read(taskId: string): Promise<LedgerSnapshot | null> {
      try {
        const entry = getLedger().get(taskId);
        return entry ? { id: entry.id, rev: entry.rev } : null;
      } catch {
        return null;
      }
    },
    async writeGate(write: LedgerGateWrite): Promise<LedgerWriteResult> {
      let ledger: TaskLedger;
      try {
        ledger = getLedger();
      } catch (err) {
        return { ok: false, reason: 'unavailable', error: err instanceof Error ? err.message : String(err) };
      }
      // The compare-and-swap is handed DOWN, not done here. Reading the rev and
      // comparing it in this function would straddle the `await` below, and any
      // write that landed inside that window would be overwritten by a verdict
      // computed from a revision that no longer exists. `recordGate` checks it
      // inside the ledger's own serialized section, where nothing can interleave.
      try {
        const res = await ledger.recordGate(write.taskId, write.gate, write.actor, write.expectedRev);
        if (res.ok) return { ok: true, rev: res.entry.rev };
        return {
          ok: false,
          reason:
            res.error === 'not_found'
              ? 'not_found'
              : res.error === 'stale_rev'
                ? 'conflict'
                : res.error === 'persist_failed'
                  ? 'unavailable'
                  : 'refused',
          error: res.message,
        };
      } catch (err) {
        return { ok: false, reason: 'unavailable', error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
