// Turn-end reminder for A2A tasks a busy agent never picked up.
//
// A task that arrives while the receiving TUI agent is mid-turn only gets a
// one-line nudge, and the agent often finishes its turn without acting on it.
// When that pane's agent ends a turn (agent.stop), remind it once, with the
// count of tasks addressed to it that are still `submitted`.
//
// The stop is only recorded; the write happens on the next sweep that finds
// the pane idle. A hook stop is often seen while the pane still reads
// 'running', and by the time a stop is polled the agent may have started a new
// turn, so the live status decides, as for channel mentions.
//
// Where it may write (a line typed into a shell runs as a command, #1489): a
// detected agent whose process is known alive, not back at a shell prompt, and
// not busy (running / awaiting_input). Every write goes through the delivery
// gate (#1560).
//
// No spam: a task is reminded at most once per `submitted` episode (keyed on
// the status timestamp, so a reopen re-arms it). A write the gate withheld is
// not counted, so the next turn end retries it.
import { useStore } from '../stores';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import type { Task, Workspace } from '../../shared/types';
import { gatedSubmitToPty } from '../utils/ptyMessageDelivery';
import { paneHasDetectedAgent } from './a2aAddressing';

/** Episode keys already reminded. Pruned every sweep, and capped. */
const reminded = new Set<string>();
const REMINDED_CAP = 1000;
/** ptys whose agent ended a turn and have not been swept since. */
const turnEnded = new Set<string>();

function episodeKey(task: Task): string {
  return `${task.id}@${task.status.timestamp}`;
}

/** Submitted tasks pinned to the pane that owns `ptyId`, or null if no pane does. */
export function pinnedSubmittedTasks(
  ptyId: string,
  workspaces: Workspace[],
  tasks: Record<string, Task>,
): Task[] | null {
  for (const ws of workspaces) {
    const pane = getWorkspaceLeafPanes(ws).find((l) =>
      l.surfaces.some((s) => s.surfaceType !== 'browser' && s.ptyId === ptyId),
    );
    if (!pane) continue;
    return Object.values(tasks).filter(
      (t) =>
        t.status.state === 'submitted' &&
        t.metadata.to.workspaceId === ws.id &&
        t.metadata.to.paneId === pane.id,
    );
  }
  return null;
}

export function buildTurnEndReminder(count: number): string {
  return `[wmux] ${count} A2A task${count === 1 ? '' : 's'} still waiting for you — a2a_task_query`;
}

type Eligibility = 'write' | 'wait' | 'never';

function eligibility(ptyId: string): Eligibility {
  const s = useStore.getState();
  const liveness = { agentAlive: s.agentAliveByPtyId, commandRunning: s.commandRunningByPtyId };
  if (!paneHasDetectedAgent(ptyId, s.surfaceAgent, liveness)) return 'never';
  if (s.agentAliveByPtyId[ptyId] !== true) return 'never';
  const status = s.surfaceAgent[ptyId]?.status;
  if (status === 'running' || status === 'awaiting_input') return 'wait';
  return 'write';
}

/** Drop reminded keys whose task is gone or no longer in that episode; cap the rest. */
function pruneReminded(tasks: Record<string, Task>): void {
  for (const key of reminded) {
    const id = key.slice(0, key.lastIndexOf('@'));
    const t = tasks[id];
    if (!t || t.status.state !== 'submitted' || episodeKey(t) !== key) reminded.delete(key);
  }
  while (reminded.size > REMINDED_CAP) {
    const oldest = reminded.values().next().value as string | undefined;
    if (oldest === undefined) break;
    reminded.delete(oldest);
  }
}

async function remind(ptyId: string): Promise<void> {
  const state = useStore.getState();
  const pinned = pinnedSubmittedTasks(ptyId, state.workspaces, state.a2aTasks) ?? [];
  const fresh = pinned.filter((t) => !reminded.has(episodeKey(t)));
  // Only a task not yet reminded triggers a write, but the line counts every
  // task still waiting on this pane.
  if (fresh.length === 0) return;
  const keys = fresh.map(episodeKey);
  // Claim before the await so an overlapping sweep does not write twice.
  for (const k of keys) reminded.add(k);
  const result = await gatedSubmitToPty(ptyId, buildTurnEndReminder(pinned.length), {
    agent: state.surfaceAgent[ptyId]?.name ?? null,
  });
  if (!result.ok) for (const k of keys) reminded.delete(k);
}

/** Record an agent turn end (agent.stop from a hook or the detector). */
export function noteAgentTurnEnd(ptyId: string): void {
  if (ptyId) turnEnded.add(ptyId);
}

/**
 * Deliver reminders for recorded turn ends whose pane is now idle. Call on
 * every event poll; a pane still busy stays recorded for the next one.
 */
export async function sweepTurnEndReminders(): Promise<void> {
  pruneReminded(useStore.getState().a2aTasks);
  for (const ptyId of [...turnEnded]) {
    const verdict = eligibility(ptyId);
    if (verdict === 'wait') continue;
    turnEnded.delete(ptyId);
    // eslint-disable-next-line no-await-in-loop -- one gated write per pane, in order
    if (verdict === 'write') await remind(ptyId);
  }
}

/** Test-only. */
export function resetTurnEndRemindersForTest(): void {
  reminded.clear();
  turnEnded.clear();
}

/** Test-only. */
export function remindedSizeForTest(): number {
  return reminded.size;
}
