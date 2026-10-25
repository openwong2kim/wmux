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
// that was below it when the stop began and still has the same pid, image
// name and command line (on Windows also creation time) — is killed. Only
// processes found under the session's own verified agent are ever signalled,
// and a process table that cannot be read fails the stop (it is never read as
// "nothing runs"). A process the tree could not place for sure (`uncertain`),
// or one a later read cannot prove the same, is never signalled, but the stop
// is not confirmed while it still runs.

import type { ProcessTreeEntry } from './AgentProcessTracker';

export const AGENT_STOP_GRACE_MS = 5_000;
const POLL_MS = 200;

export interface AgentStopDeps {
  /** The agent and every process below it, or null when no such agent runs.
   *  `uncertain`: processes that may be below it, never signalled. */
  tree: () => Promise<{ root: ProcessTreeEntry; descendants: ProcessTreeEntry[]; uncertain?: ProcessTreeEntry[] } | null>;
  /** Of these, the ones still running (same pid, image name and command
   *  line). Split, `unsure` are the ones not proven the same process (on
   *  Windows, a creation time missing on either side): never killed. */
  stillRunning: (entries: readonly ProcessTreeEntry[]) => Promise<ProcessTreeEntry[] | { same: ProcessTreeEntry[]; unsure: ProcessTreeEntry[] }>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  graceMs?: number;
  /** A conditional stop (main's idle stop of a reported worker): asked once
   *  the tree is known, right before the first signal; false refuses the
   *  stop (`turn_open`) and nothing is signalled. */
  stillIdle?: () => boolean;
  /** Windows (fromTerminal's stop, winProcessSweep.ts): the tree read can
   *  be seconds old by the first signal, and a child started after it
   *  outlives its killed parent. */
  sweep?: AgentStopSweep;
  now?: () => number;
}

export interface AgentStopSweep {
  /** Once the tree is known, before the first signal, from a fresh read:
   *  null when that read does not show the same root (or cannot be read), or
   *  shows running a descendant it cannot confirm (or an uncertain one): a
   *  clean stop cannot be proven, so nothing may be signalled. Otherwise the
   *  descendants it shows as the same processes (`kill`) and those it does
   *  not (`unsure`, gone by that read: never signalled). Never throws. */
  arm: (tree: { root: ProcessTreeEntry; descendants: ProcessTreeEntry[]; uncertain?: ProcessTreeEntry[] }) => Promise<{ kill: ProcessTreeEntry[]; unsure: ProcessTreeEntry[] } | null>;
  /** Once the tree is gone, with the time each of its processes was first
   *  seen gone (the read that found it so): 'left'
   *  when a process the stop may have orphaned still runs, which fails the
   *  stop. */
  run: (goneBy: ReadonlyMap<number, number>) => Promise<'clean' | 'left'>;
}

export type AgentStopResult =
  | { ok: true; stopped: false }
  | { ok: true; stopped: true; pid: number; killed: number }
  | { ok: false; code: 'still_running'; pid: number }
  | { ok: false; code: 'turn_open' }
  // The sweep's read did not confirm the tree: nothing was signalled.
  | { ok: false; code: 'unverified' };

/** Whether a pane's turn is over by the daemon's own state: a turn known
 *  closed, no running turn, no prompt waiting. Pure. */
export function paneTurnClosed(state: { agentStatus: string; turnOpen: boolean | undefined }): boolean {
  return state.turnOpen === false && state.agentStatus !== 'running' && state.agentStatus !== 'awaiting_input';
}

export async function stopAgentTree(deps: AgentStopDeps): Promise<AgentStopResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const tree = await deps.tree();
  if (!tree) return { ok: true, stopped: false };
  const armed = deps.sweep ? await deps.sweep.arm(tree) : null;
  if (deps.sweep && !armed) return { ok: false, code: 'unverified' };
  if (deps.stillIdle && !deps.stillIdle()) return { ok: false, code: 'turn_open' };
  const all = armed ? [tree.root, ...armed.kill] : [tree.root, ...tree.descendants];
  const now = deps.now ?? Date.now;
  // When each process of the tree was known gone, for the sweep.
  const goneBy = new Map<number, number>();
  const signal = (pid: number, sig: NodeJS.Signals): void => {
    try {
      deps.kill(pid, sig);
    } catch {
      /* already gone */
    }
  };
  // Each read also records, for the sweep, when a process was first seen gone.
  const running = async (entries: readonly ProcessTreeEntry[]) => {
    const r = await deps.stillRunning(entries);
    const split = Array.isArray(r) ? { same: r, unsure: [] } : r;
    const readAt = now();
    for (const e of entries) {
      if (!goneBy.has(e.pid) && !split.same.includes(e) && !split.unsure.includes(e)) goneBy.set(e.pid, readAt);
    }
    return split;
  };
  signal(tree.root.pid, 'SIGTERM');
  const graceMs = deps.graceMs ?? AGENT_STOP_GRACE_MS;
  for (let waited = 0; waited < graceMs; waited += POLL_MS) {
    const root = await running([tree.root]);
    if (root.same.length + root.unsure.length === 0) break;
    await sleep(POLL_MS);
  }
  const pending = [...all, ...(tree.uncertain ?? []), ...(armed?.unsure ?? [])];
  let left = await running(pending);
  // Killed: only a process of the tree proven to be the one found then.
  const toKill = left.same.filter((e) => all.some((a) => a.pid === e.pid));
  for (const e of toKill) signal(e.pid, 'SIGKILL');
  if (toKill.length > 0) {
    await sleep(POLL_MS);
    left = await running(pending);
  }
  // Anything of the tree still running (a kill that was refused, a process
  // never signalled because it was uncertain or unsure) is not a stop.
  if (left.same.length + left.unsure.length > 0) return { ok: false, code: 'still_running', pid: tree.root.pid };
  if (deps.sweep) {
    if ((await deps.sweep.run(goneBy).catch(() => 'left' as const)) === 'left') return { ok: false, code: 'still_running', pid: tree.root.pid };
  }
  return { ok: true, stopped: true, pid: tree.root.pid, killed: all.length };
}
