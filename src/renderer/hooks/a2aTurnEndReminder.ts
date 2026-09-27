// Turn-end reminder for A2A tasks a busy agent never picked up.
//
// A task that arrives while the receiving TUI agent is mid-turn only gets a
// one-line nudge, and the agent often finishes its turn without acting on it.
// When that pane's agent ends a turn (agent.stop), remind it once, with a
// count, of the tasks addressed to it that are still `submitted`.
//
// No spam: each task is reminded at most once per `submitted` episode (keyed on
// the status timestamp, so a reopen re-arms it). A write the approval gate
// withheld (#1560) is not counted, so the next turn end retries it.
import { useStore } from '../stores';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import type { Task, Workspace } from '../../shared/types';
import { gatedSubmitToPty } from '../utils/ptyMessageDelivery';

const reminded = new Set<string>();

function episodeKey(task: Task): string {
  return `${task.id}@${task.status.timestamp}`;
}

/** Submitted tasks pinned to the pane that owns `ptyId`, not yet reminded. */
export function pendingTasksForPty(
  ptyId: string,
  workspaces: Workspace[],
  tasks: Record<string, Task>,
): Task[] {
  for (const ws of workspaces) {
    const pane = getWorkspaceLeafPanes(ws).find((l) =>
      l.surfaces.some((s) => s.surfaceType !== 'browser' && s.ptyId === ptyId),
    );
    if (!pane) continue;
    return Object.values(tasks).filter(
      (t) =>
        t.status.state === 'submitted' &&
        t.metadata.to.workspaceId === ws.id &&
        t.metadata.to.paneId === pane.id &&
        !reminded.has(episodeKey(t)),
    );
  }
  return [];
}

export function buildTurnEndReminder(count: number): string {
  return `[wmux] ${count} A2A task${count === 1 ? '' : 's'} still waiting for you — a2a_task_query`;
}

/** Called on an agent.stop for `ptyId`. */
export async function remindPendingA2aTasks(ptyId: string): Promise<void> {
  const state = useStore.getState();
  // #1489: only a pane with a detected, live agent is ever written to. A stop
  // signal alone is not proof: the line would run as a command in a shell.
  const agent = state.surfaceAgent[ptyId];
  if (!agent || state.agentAliveByPtyId[ptyId] === false) return;
  const pending = pendingTasksForPty(ptyId, state.workspaces, state.a2aTasks);
  if (pending.length === 0) return;
  const keys = pending.map(episodeKey);
  // Claim before the await so a second stop in the same poll batch does not
  // write the same reminder twice.
  for (const k of keys) reminded.add(k);
  const result = await gatedSubmitToPty(ptyId, buildTurnEndReminder(pending.length), {
    agent: agent.name ?? null,
  });
  if (!result.ok) for (const k of keys) reminded.delete(k);
}

/** Test-only. */
export function resetTurnEndRemindersForTest(): void {
  reminded.clear();
}
