import type { BrowserWindow } from 'electron';
import type { AgentStatus } from '../../shared/types';
import type { HookSignalRouter } from '../hooks/HookSignalRouter';
import {
  broadcastMetadataUpdate,
  getLastBroadcastAgentStatus,
} from '../ipc/handlers/metadata.handler';

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
  if (holdsUnreadResult(ptyId)) return true;
  broadcastMetadataUpdate(win, { ptyId, agentStatus: 'idle' });
  return true;
}
