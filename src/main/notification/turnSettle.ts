import type { BrowserWindow } from 'electron';
import type { AgentStatus } from '../../shared/types';
import type { HookSignalRouter } from '../hooks/HookSignalRouter';
import {
  broadcastMetadataUpdate,
  getLastBroadcastAgentStatus,
} from '../ipc/handlers/metadata.handler';
import { markSettled } from './idleSuppression';

/**
 * The statuses a settle edge must never overwrite (the F5 rule, shared by the
 * process-death edge, the OSC 133 back-at-prompt edge and the interrupt edge):
 * they are RESULTS the operator has not read yet, and neither the agent
 * exiting nor its shell returning to a prompt un-finishes the turn that
 * reported them.
 */
const UNREAD_RESULT_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  'complete',
  'awaiting_input',
  'waiting',
  'error',
]);

export function holdsUnreadResult(ptyId: string): boolean {
  const last = getLastBroadcastAgentStatus(ptyId);
  return last !== undefined && UNREAD_RESULT_STATUSES.has(last);
}

/**
 * Broadcast one settle: `agentStatus:'idle'` MARKED as a turn end.
 *
 * Every main-side settle edge sends its idle through here — the interrupt
 * keystroke, the OSC 133 back-at-prompt marker, the agent process's death, and
 * the latch expiry — because an unmarked idle is not enough to clear the pane.
 * 'running' has two carriers in the renderer: the turn latch, which a plain
 * idle ends, and `surfaceActivityAt`, a 120-second freshness stamp the byte
 * heuristic writes and no status broadcast touched. Live-observed: an
 * interrupted pane stayed amber for the rest of that window even though main
 * had already settled it. `settled` is what tells the renderer to clear both.
 *
 * `markSettled` closes the same hole on this side: the redraw that follows
 * every settle would otherwise re-broadcast byte-'running' immediately.
 */
export function broadcastSettledIdle(
  ptyId: string,
  win: BrowserWindow | null,
  now: number = Date.now(),
): void {
  if (!ptyId) return;
  markSettled(ptyId, now);
  broadcastMetadataUpdate(win, { ptyId, agentStatus: 'idle', settled: true });
}

/**
 * Settle a LATCHED pane to idle. The one funnel every main-side settle edge
 * goes through, so they cannot drift apart.
 *
 * Only a latched pane is touched: the latch is the claim these edges exist to
 * withdraw, and a pane that never had one is still the byte heuristic's to
 * write. The latch is released FIRST, exactly as the death edge does it, so the
 * broadcast is not vetoed by the gate it exists to escape — and it is released
 * even when the broadcast is withheld, because the turn is over either way.
 *
 * Returns true when the pane held a latch (whether or not the broadcast went
 * out) so callers can log/test the edge.
 */
export function settleHookTurnToIdle(
  ptyId: string,
  router: HookSignalRouter | null,
  win: BrowserWindow | null,
  now: number = Date.now(),
): boolean {
  if (!ptyId) return false;
  if (!router?.governsRunningState(ptyId, now)) return false;
  router.releaseHookTurnStart(ptyId);
  // The F5 guard: a turn that already reported a result is not un-finished.
  // The byte-'running' mute still applies — the redraw comes either way, and
  // re-lighting a pane that holds an unread result is the same regression.
  if (holdsUnreadResult(ptyId)) {
    markSettled(ptyId, now);
    return true;
  }
  broadcastSettledIdle(ptyId, win, now);
  return true;
}
