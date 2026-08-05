/**
 * RCA A1/A9 — partial-list reconcile "2-strike" guard.
 *
 * The empty-list case (daemon returns ZERO sessions) is already handled
 * non-destructively by AppLayout's reconcile (preserve everything; the daemon
 * is almost certainly mid-rehydrate). This helper closes the remaining hole:
 * the PARTIAL-list case, where the daemon returns a NON-empty session list
 * that happens to omit a live ptyId because the snapshot was taken mid-rehydrate
 * (e.g. the daemon has reattached 2 of 3 sessions). The pre-fix code cleared
 * that third surface's live ptyId on the FIRST cycle — destroying a live
 * session, the exact class the v2.14.0 RCA flagged.
 *
 * Fix: before clearing any ptyId that was absent from the first non-empty
 * snapshot, re-query the daemon ONCE after a short backoff. Only clear ptyIds
 * that are absent from BOTH snapshots. On ANY uncertainty — the re-query RPC
 * fails, or the view is torn down — preserve everything (return an empty set).
 * Clearing a live ptyId is destructive; never do it on incomplete evidence.
 *
 * Extracted as a pure, dependency-injected function (no xterm / zustand /
 * electron import) so the decision can be unit-tested in isolation, mirroring
 * reconnectPtyWithRetry.ts.
 */

export interface ReListResult {
  ok: boolean;
  /** The set of ptyIds the daemon reports alive, when ok. */
  ids?: Set<string>;
}

export interface ReconcileReQueryDeps {
  /** Re-query the daemon's live session list (a second snapshot). */
  reList: () => Promise<ReListResult>;
  /** Sleep before the re-query. Injectable so tests don't wait real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Bail (preserve everything) the moment the reconcile is aborted/torn down. */
  isCurrent?: () => boolean;
  /** Optional structured logger. Defaults to console. */
  log?: (level: 'warn' | 'log', message: string) => void;
  /** Override the re-query backoff (default RECONCILE_REQUERY_BACKOFF_MS). */
  backoffMs?: number;
}

/**
 * Backoff before the second daemon snapshot. Kept well under the rolling
 * RECONCILE_TIMEOUT_MS no-progress window (DAEMON_RPC_TIMEOUT_MS + 5s = 15s)
 * so this backoff plus one pty.list round-trip fits within a single stage.
 */
export const RECONCILE_REQUERY_BACKOFF_MS = 600;

/**
 * Given the ptyIds that were ABSENT from the first (non-empty) daemon snapshot,
 * re-query once and return ONLY those still absent in the second snapshot — the
 * safe-to-clear set. Returns an EMPTY set (preserve everything) if there are no
 * candidates, the re-query fails, or the caller is no longer current.
 */
export async function resolvePtyIdsToClear(
  firstAbsent: string[],
  deps: ReconcileReQueryDeps,
): Promise<Set<string>> {
  const toClear = new Set<string>();
  if (firstAbsent.length === 0) return toClear;

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const isCurrent = deps.isCurrent ?? (() => true);
  const log = deps.log ?? ((level, message) => {
    // eslint-disable-next-line no-console
    console[level](message);
  });

  if (!isCurrent()) return toClear; // torn down before strike 2 — preserve all
  await sleep(deps.backoffMs ?? RECONCILE_REQUERY_BACKOFF_MS);
  if (!isCurrent()) return toClear; // torn down during backoff — preserve all

  let second: ReListResult;
  try {
    second = await deps.reList();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('warn', `[lifecycle] reconcile re-query threw (${msg}) — preserving ${firstAbsent.length} candidate ptyId(s), no destructive clear`);
    return toClear; // empty = preserve all
  }

  if (!second.ok || !second.ids) {
    log('warn', `[lifecycle] reconcile re-query failed — preserving ${firstAbsent.length} candidate ptyId(s), no destructive clear`);
    return toClear; // empty = preserve all
  }

  const secondIds = second.ids;
  for (const id of firstAbsent) {
    if (!secondIds.has(id)) toClear.add(id);
  }
  log(
    'warn',
    `[lifecycle] reconcile 2-strike: ${toClear.size}/${firstAbsent.length} candidate ptyId(s) absent from BOTH daemon snapshots → clear; ${firstAbsent.length - toClear.size} reappeared on re-query → preserved`,
  );
  return toClear;
}
