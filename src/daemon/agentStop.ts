// ─── Stop the agent in a pane, keep the pane ────────────────────────────────
//
// main asks for this when a factory worker's task has ended (completed or
// cancelled) and the worker's agent should stop holding memory: the agent
// process and everything below it (its MCP servers and tools) stop, while the
// pane's shell, its scrollback and the session record (with the agent's
// resume binding) stay, so the same conversation can be resumed in the same
// folder later.
//
// The agent is asked to exit first (SIGTERM: it closes its MCP servers
// itself). What is still running after the grace — the agent, or a process
// that was below it when the stop began and still has the same pid and image
// name and command line — is killed. Only processes found under the
// session's own verified agent are ever signalled, and a process table that
// cannot be read fails the stop (it is never read as "nothing runs").

import type { ProcessTreeEntry } from './AgentProcessTracker';

export const AGENT_STOP_GRACE_MS = 5_000;
const POLL_MS = 200;

export interface AgentStopDeps {
  /** The agent and every process below it, or null when no such agent runs. */
  tree: () => Promise<{ root: ProcessTreeEntry; descendants: ProcessTreeEntry[] } | null>;
  /** Of these, the ones still running (same pid and image name). */
  stillRunning: (entries: readonly ProcessTreeEntry[]) => Promise<ProcessTreeEntry[]>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  graceMs?: number;
  /** A conditional stop (main's idle stop of a reported worker): asked once
   *  the tree is known, right before the first signal; false refuses the
   *  stop (`turn_open`) and nothing is signalled. */
  stillIdle?: () => boolean;
}

export type AgentStopResult =
  | { ok: true; stopped: false }
  | { ok: true; stopped: true; pid: number; killed: number }
  | { ok: false; code: 'still_running'; pid: number }
  | { ok: false; code: 'turn_open' };

/** Whether a pane's turn is over by the daemon's own state: a turn known
 *  closed, no running turn, no prompt waiting. Pure. */
export function paneTurnClosed(state: { agentStatus: string; turnOpen: boolean | undefined }): boolean {
  return state.turnOpen === false && state.agentStatus !== 'running' && state.agentStatus !== 'awaiting_input';
}

export async function stopAgentTree(deps: AgentStopDeps): Promise<AgentStopResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const tree = await deps.tree();
  if (!tree) return { ok: true, stopped: false };
  if (deps.stillIdle && !deps.stillIdle()) return { ok: false, code: 'turn_open' };
  const all = [tree.root, ...tree.descendants];
  const signal = (pid: number, sig: NodeJS.Signals): void => {
    try {
      deps.kill(pid, sig);
    } catch {
      /* already gone */
    }
  };
  signal(tree.root.pid, 'SIGTERM');
  const graceMs = deps.graceMs ?? AGENT_STOP_GRACE_MS;
  for (let waited = 0; waited < graceMs; waited += POLL_MS) {
    if ((await deps.stillRunning([tree.root])).length === 0) break;
    await sleep(POLL_MS);
  }
  let left = await deps.stillRunning(all);
  for (const e of left) signal(e.pid, 'SIGKILL');
  if (left.length > 0) {
    await sleep(POLL_MS);
    left = await deps.stillRunning(all);
  }
  // Anything of the tree still running (a kill that was refused) is not a stop.
  if (left.length > 0) return { ok: false, code: 'still_running', pid: tree.root.pid };
  return { ok: true, stopped: true, pid: tree.root.pid, killed: all.length - left.length };
}
