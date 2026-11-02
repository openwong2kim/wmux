import type { DaemonClient } from './DaemonClient';
import type { FolderTrustState } from '../daemon/folderTrustState';
import { FOLDER_TRUST_DEFAULT_BUDGET_MS, FOLDER_TRUST_LAUNCH_REFUSAL, FOLDER_TRUST_UNREADABLE_REFUSAL } from '../shared/folderTrustWording';

/** How long main waits past the daemon's read budget (FOLDER_TRUST_DEFAULT_BUDGET_MS,
 *  or the `budgetMs` asked for), so the daemon's 'unknown' arrives before main
 *  gives up on it. */
const FOLDER_TRUST_CLIENT_MARGIN_MS = 150;

/** The last reason each pane's check was unavailable, so it is logged once. */
const unavailableLogged = new Map<string, string>();
/** The last refusal logged per pane for a writer that retries (`once`). */
const refusalLogged = new Map<string, string>();

/** Drop a pane's log memory: its session died or was disposed. */
export function forgetFolderTrustPane(ptyId: string): void {
  unavailableLogged.delete(ptyId);
  refusalLogged.delete(ptyId);
}

/**
 * The daemon's folder-trust verdict for `ptyId`, or null when there is none to
 * have (no daemon, an older one, no answer in time): the check then stands
 * aside, with one log line per pane while the reason holds.
 */
export async function daemonFolderTrustVerdict(
  dc: Pick<DaemonClient, 'folderTrustState'> | null | undefined,
  ptyId: string,
): Promise<FolderTrustState | null> {
  return (await daemonFolderTrustReading(dc, ptyId))?.state ?? null;
}

/** daemonFolderTrustVerdict, with the reason tag a daemon sends for 'unknown'.
 *  `budgetMs`: the daemon's read budget, for a caller no person waits on
 *  (FOLDER_TRUST_DELIVERY_BUDGET_MS); main waits that long plus a margin. */
export async function daemonFolderTrustReading(
  dc: Pick<DaemonClient, 'folderTrustState'> | null | undefined,
  ptyId: string,
  opts: { budgetMs?: number } = {},
): Promise<{ state: FolderTrustState; reason?: string } | null> {
  const timeoutMs = (opts.budgetMs ?? FOLDER_TRUST_DEFAULT_BUDGET_MS) + FOLDER_TRUST_CLIENT_MARGIN_MS;
  const answer = dc
    ? await (opts.budgetMs !== undefined ? dc.folderTrustState(ptyId, timeoutMs, opts.budgetMs) : dc.folderTrustState(ptyId, timeoutMs))
    : undefined;
  if (answer && 'state' in answer) {
    unavailableLogged.delete(ptyId);
    return answer;
  }
  const reason = answer?.unavailable ?? 'no daemon client';
  if (unavailableLogged.get(ptyId) !== reason) {
    unavailableLogged.set(ptyId, reason);
    console.warn(`[folder-trust] check unavailable on pane ${ptyId}: ${reason}`);
  }
  return null;
}

/**
 * Whether a verdict stops `writer`: 'trust' always, 'unknown' only when
 * `refuseUnknown` (an automated writer). One log line per refusal, naming the
 * writer and the verdict (and the daemon's reason tag for an 'unknown' it
 * read), and no screen text; with `once` (a writer that retries), one per pane
 * while the same refusal holds.
 */
export function folderTrustStops(
  verdict: FolderTrustState | null,
  writer: string,
  ptyId: string,
  refuseUnknown: boolean,
  opts: { once?: boolean; reason?: string } = {},
): verdict is 'trust' | 'unknown' {
  if (verdict === null || verdict === 'clear' || (verdict === 'unknown' && !refuseUnknown)) {
    if (opts.once) refusalLogged.delete(ptyId);
    return false;
  }
  const line = `[folder-trust] refused ${writer} on pane ${ptyId}: folder-trust ${verdict}${opts.reason ? ` (${opts.reason})` : ''}`;
  if (!opts.once || refusalLogged.get(ptyId) !== line) console.warn(line);
  if (opts.once) refusalLogged.set(ptyId, line);
  return true;
}

/**
 * Why main must not type a launch line or key into `ptyId` now, or null:
 * asked once, right before the write. With no daemon verdict to have, the
 * line is typed as before. `budgetMs`: the daemon's read budget, for a writer
 * no person waits on (FOLDER_TRUST_DELIVERY_BUDGET_MS).
 */
export async function folderTrustLaunchRefusal(
  dc: Pick<DaemonClient, 'folderTrustState'> | null | undefined,
  ptyId: string,
  writer: string,
  opts: { refuseUnknown: boolean; once?: boolean; budgetMs?: number },
): Promise<string | null> {
  return (await folderTrustLaunchHold(dc, ptyId, writer, opts))?.reason ?? null;
}

/** As folderTrustLaunchRefusal, saying also whether the hold may pass by
 *  itself (`retry`: a screen that could not be read) or waits for a person. */
export async function folderTrustLaunchHold(
  dc: Pick<DaemonClient, 'folderTrustState'> | null | undefined,
  ptyId: string,
  writer: string,
  opts: { refuseUnknown: boolean; once?: boolean; budgetMs?: number },
): Promise<{ retry: boolean; reason: string } | null> {
  if (!dc) return null;
  const reading = await daemonFolderTrustReading(dc, ptyId, opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {});
  const verdict = reading?.state ?? null;
  if (!folderTrustStops(verdict, writer, ptyId, opts.refuseUnknown, { once: opts.once, reason: reading?.reason })) return null;
  return verdict === 'trust'
    ? { retry: false, reason: FOLDER_TRUST_LAUNCH_REFUSAL }
    : { retry: true, reason: FOLDER_TRUST_UNREADABLE_REFUSAL };
}
