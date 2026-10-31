import { useStore } from '../stores';
import { agentDisplayToSlug } from '../../shared/agentIdentity';

/**
 * #1210 — drop a pane's detected agent identity once we know the TUI is gone.
 * #1463 — `requestedAt` is when the snapshot was asked for: only running
 * evidence older than that is dropped with it, so an agent relaunched while the
 * answer was in flight keeps its stamp. A dead process with a foreground
 * command still running may be a relaunch the tracker has not re-armed for yet,
 * so that case keeps the stamp too.
 */
export function clearSurfaceAgentsKnownGone(
  agentAlive: Record<string, boolean>,
  commandRunning: Record<string, boolean>,
  requestedAt: number,
): void {
  const store = useStore.getState();
  for (const [id, alive] of Object.entries(agentAlive)) {
    if (alive === false) store.clearSurfaceAgent(id, commandRunning[id] === true ? undefined : requestedAt);
  }
  for (const [id, running] of Object.entries(commandRunning)) {
    if (running === false) store.clearSurfaceAgent(id, requestedAt);
  }
}

/**
 * The daemon's agent process-death edge for one pane: the alive=false branch
 * of clearSurfaceAgentsKnownGone, run when the edge arrives instead of on the
 * next 15 s poll. Only the agent that died is dropped: a pane whose detected
 * agent is another kind (a Codex started after the Claude) keeps its row. An
 * unknown pane agent cannot contradict the tracker, as in main's
 * onAgentProcessExit.
 */
export function clearSurfaceAgentOnProcessExit(ptyId: string, slug: string | null, at: number): void {
  if (!slug) return;
  const store = useStore.getState();
  const agent = store.surfaceAgent[ptyId];
  if (!agent?.name) return;
  const paneSlug = agent.slug ?? agentDisplayToSlug(agent.name);
  if (paneSlug && paneSlug !== slug) return;
  store.clearSurfaceAgent(ptyId, store.commandRunningByPtyId[ptyId] === true ? undefined : at);
}
