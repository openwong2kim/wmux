// ─── LedgerPort — the one seam between the gate runner and the task ledger ───
//
// The gate runner records its verdict in the task ledger (src/shared/ledger.ts),
// and the ledger's writer is the DAEMON: `ledger.update` over the pipe. That RPC
// ships on a different lane, in parallel with this file, so the runner never
// calls it directly — it calls this interface, and exactly one adapter
// (`createDaemonLedgerPort`) knows the method name and the parameter shape.
// Pointing the adapter at the real RPC is a one-file change; every test in this
// directory injects a fake instead of a daemon.
//
// Compare-and-swap, not last-write-wins: `LedgerEntry.rev` is monotonic and the
// writer refuses a stale `expectedRev`, so a caller must READ before it writes.
// That is why `read` exists here at all — a port with only `update` would force
// every caller to invent a revision.

import type { LedgerActor, LedgerGateResult } from '../../shared/ledger';

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

/** Daemon RPC minimum surface (same shape as CloseDaemonPort — injectable). */
export interface LedgerDaemonPort {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/**
 * The one adapter that names the wire method. Lane F owns `ledger.get` /
 * `ledger.update`; until they are registered this returns `unavailable`, which
 * the gate runner already treats as "ran, unrecorded" rather than a failure.
 */
export function createDaemonLedgerPort(daemon: LedgerDaemonPort): LedgerPort {
  return {
    async read(taskId: string): Promise<LedgerSnapshot | null> {
      try {
        const res = (await daemon.rpc('ledger.get', { taskId })) as
          | { ok?: boolean; entry?: { id?: unknown; rev?: unknown } }
          | undefined;
        const entry = res?.ok === true ? res.entry : undefined;
        if (!entry || typeof entry.id !== 'string' || typeof entry.rev !== 'number') return null;
        return { id: entry.id, rev: entry.rev };
      } catch {
        return null;
      }
    },
    async writeGate(write: LedgerGateWrite): Promise<LedgerWriteResult> {
      try {
        const res = (await daemon.rpc('ledger.update', {
          taskId: write.taskId,
          expectedRev: write.expectedRev,
          actor: write.actor,
          gate: write.gate,
        })) as { ok?: boolean; rev?: unknown; error?: { code?: unknown; message?: unknown } } | undefined;
        if (res?.ok === true && typeof res.rev === 'number') return { ok: true, rev: res.rev };
        const code = typeof res?.error?.code === 'string' ? res.error.code : '';
        const message = typeof res?.error?.message === 'string' ? res.error.message : 'ledger.update failed';
        const reason =
          code === 'ABORTED' || code === 'CONFLICT'
            ? ('conflict' as const)
            : code === 'NOT_FOUND'
              ? ('not_found' as const)
              : ('refused' as const);
        return { ok: false, reason, error: message };
      } catch (err) {
        return { ok: false, reason: 'unavailable', error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
