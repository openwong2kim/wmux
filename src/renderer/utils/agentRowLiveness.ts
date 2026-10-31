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

/** When each pane's agent process-death edge arrived (see applyProcessExits). */
const processExitAt = new Map<string, number>();
/** When each liveness snapshot (pty.list) still in flight was asked for. */
const pendingSnapshots: number[] = [];

/**
 * A liveness snapshot is being asked for now. Returns its requestedAt; pass
 * that to livenessSnapshotSettled once the answer is applied or failed.
 */
export function livenessSnapshotRequested(): number {
  const requestedAt = Date.now();
  pendingSnapshots.push(requestedAt);
  return requestedAt;
}

/**
 * The snapshot asked for at requestedAt has settled. A death-edge mark only
 * matters to snapshots asked for before its edge, so it is retired once none
 * of those is still in flight, whatever order the answers came back in.
 */
export function livenessSnapshotSettled(requestedAt: number): void {
  const i = pendingSnapshots.indexOf(requestedAt);
  if (i >= 0) pendingSnapshots.splice(i, 1);
  for (const [ptyId, at] of processExitAt) {
    if (!pendingSnapshots.some((pending) => pending < at)) processExitAt.delete(ptyId);
  }
}

/**
 * The daemon's agent process-death edge for one pane: the alive=false branch
 * of clearSurfaceAgentsKnownGone, run when the edge arrives instead of on the
 * next 15 s poll. Only the agent that died is dropped: a pane whose detected
 * agent is another kind (a Codex started after the Claude) keeps its row, and
 * so does a custom or unknown pane agent, which the edge may not be about (a
 * late edge from an earlier, standard agent in that pane). The poll still
 * settles those.
 */
export function clearSurfaceAgentOnProcessExit(ptyId: string, slug: string | null, at: number): void {
  if (!slug) return;
  const store = useStore.getState();
  const agent = store.surfaceAgent[ptyId];
  if (!agent?.name) return;
  if ((agent.slug ?? agentDisplayToSlug(agent.name)) !== slug) return;
  processExitAt.set(ptyId, at);
  useStore.setState((state) => { state.agentAliveByPtyId[ptyId] = false; });
  store.clearSurfaceAgent(ptyId, store.commandRunningByPtyId[ptyId] === true ? undefined : at);
}

/**
 * A liveness snapshot asked for before a pane's death edge arrived may have
 * read the daemon before the death and still say alive. Mark those panes dead
 * in it, so the poll neither re-seeds nor re-stamps the row the edge dropped.
 * A snapshot asked for after the edge is current (a relaunch reads alive
 * there) and is left as it is. Marks are retired by livenessSnapshotSettled.
 */
export function applyProcessExits(agentAlive: Record<string, boolean>, requestedAt: number): void {
  for (const [ptyId, at] of processExitAt) {
    if (requestedAt < at) agentAlive[ptyId] = false;
  }
}
