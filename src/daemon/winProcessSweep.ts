// ─── Orphans a Windows tree stop leaves behind ──────────────────────────────
//
// stopAgentTree ends the agent first, then whatever of the tree it read is
// still running. A child the agent (or one of its MCP servers) started after
// that read is in no list, and Windows never reparents: it keeps running with
// a ppid that names a dead process. This sweep (fromTerminal's stop on
// Windows only) checks the tree against a fresh read right before the first
// signal, then finds such children by that ppid and ends the ones that are
// provably the tree's.
//
// A ppid alone proves nothing on Windows, where pids are reused: a process
// started before its "parent" names an earlier holder of that pid, and one
// started after the parent was gone is another process's child. Both are left
// alone, without failing the stop. A child that is the tree's (started while
// its parent ran) is ended only when it reads as one of the tree's programs;
// anything that cannot be read (no command line, no start time), started in
// the same millisecond as its parent, or is something else is left running
// and fails the stop, so the caller says Claude may still be running. Every
// kill is checked against a fresh read of the same pid, image, command line
// and start time right before it.

import type { ProcessTreeEntry } from './AgentProcessTracker';
import type { AgentStopSweep } from './agentStop';

/** A process the stop ended, as a sweep parent. */
export interface SweepParent {
  /** Its start time (epoch ms), undefined when unreadable. */
  created: number | undefined;
  /** By this time it was gone (taken right after its signal, or after the
   *  read that found it gone): nothing started later is its child. */
  goneByMs: number;
}

const ROUNDS = 5;
const POLL_MS = 200;
const AGENT_IMAGE = /^(claude|node|bun)(\.exe)?$/i;

/** Whether `e` reads as one of the tree's programs: Claude's own runtimes, an
 *  image the tree already ran, or an MCP server. */
function looksLikeTree(e: ProcessTreeEntry, treeImages: ReadonlySet<string>): boolean {
  return AGENT_IMAGE.test(e.name) || treeImages.has(e.name.toLowerCase()) || /mcp/i.test(e.cmdline ?? '');
}

/** The same process in two reads: pid, image, a command line both could
 *  read, and a start time both could read. */
export function sameProcess(a: ProcessTreeEntry, b: ProcessTreeEntry): boolean {
  return a.pid === b.pid && a.name === b.name && !!a.cmdline && a.cmdline === b.cmdline && a.created !== undefined && a.created === b.created;
}

/**
 * Which processes in `table` a stop orphaned: `kill`, the tree's children to
 * end; `left`, children that may be the tree's but cannot be shown to be its
 * programs (the stop fails). A process started before its parent, or after
 * its parent was gone (or with or after whoever holds the parent's pid now),
 * is not that parent's child and is in neither. Pure — exported for tests.
 */
export function planOrphanSweep(
  parents: ReadonlyMap<number, SweepParent>,
  table: readonly ProcessTreeEntry[],
  treeImages: ReadonlySet<string>,
): { kill: ProcessTreeEntry[]; left: ProcessTreeEntry[] } {
  const kill: ProcessTreeEntry[] = [];
  const left: ProcessTreeEntry[] = [];
  for (const c of table) {
    const parent = parents.get(c.ppid);
    if (!parent) continue;
    if (c.created === undefined) {
      left.push(c);
      continue;
    }
    // An earlier holder of the pid started it.
    if (parent.created !== undefined && c.created < parent.created) continue;
    // The parent is gone, so a process on its pid is a newer one, unless it
    // cannot be dated after the parent.
    const holder = table.find((t) => t.pid === c.ppid);
    if (holder && (holder.created === undefined || parent.created === undefined || holder.created <= parent.created)) {
      left.push(c);
      continue;
    }
    // Asymmetric ties: one with the pid's new holder may be the holder's
    // child, so it is not ours; one with the parent's end (taken right after
    // its signal) is, since with no holder nothing else can have started it.
    if (holder && holder.created !== undefined && c.created >= holder.created) continue;
    if (c.created > parent.goneByMs) continue;
    // A tie with the parent's start does not tell which came first.
    if (parent.created === undefined || c.created === parent.created || !c.cmdline || !looksLikeTree(c, treeImages)) {
      left.push(c);
      continue;
    }
    kill.push(c);
  }
  return { kill, left };
}

type Tree = { root: ProcessTreeEntry; descendants: ProcessTreeEntry[]; uncertain?: ProcessTreeEntry[] };

/**
 * The pre-signal check: which of the tree `read` shows as the same processes
 * the tree read found. Null when the root is not one of them; otherwise the
 * descendants that are (`kill`) and those that are not (`unsure`). Pure —
 * exported for tests.
 */
export function confirmTree(tree: Tree, table: readonly ProcessTreeEntry[]): { kill: ProcessTreeEntry[]; unsure: ProcessTreeEntry[] } | null {
  const shown = (e: ProcessTreeEntry) => table.some((t) => sameProcess(e, t));
  if (!shown(tree.root)) return null;
  return { kill: tree.descendants.filter(shown), unsure: tree.descendants.filter((e) => !shown(e)) };
}

export interface OrphanSweepDeps {
  /** One fresh process table with start times. Throws when unreadable. */
  read: () => Promise<ProcessTreeEntry[]>;
  kill: (pid: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** One stop's sweep: `arm` checks the tree against a fresh read before the
 *  first signal, `run` ends its orphans once it is gone (a few rounds, for
 *  their own children). */
export function createOrphanSweep(deps: OrphanSweepDeps): AgentStopSweep {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // The stop's own processes, as the sweep's first parents. A process the
  // tree only may hold (uncertain, unsure) counts with no start time: what
  // it left behind is never ended, only reported.
  let parents: { entry: ProcessTreeEntry; created: number | undefined }[] = [];
  return {
    async arm(tree) {
      let table: ProcessTreeEntry[];
      try {
        table = await deps.read();
      } catch {
        // Nothing can be checked against what is running now.
        return null;
      }
      const confirmed = confirmTree(tree, table);
      if (!confirmed) return null;
      // A descendant that cannot be confirmed and still runs (by pid and image)
      // would never be signalled, so the stop could not be proven: refuse
      // before the root is touched.
      const runs = (e: ProcessTreeEntry) => table.some((t) => t.pid === e.pid && t.name === e.name);
      if ([...confirmed.unsure, ...(tree.uncertain ?? [])].some(runs)) return null;
      parents = [
        ...[tree.root, ...confirmed.kill].map((entry) => ({ entry, created: entry.created })),
        ...[...confirmed.unsure, ...(tree.uncertain ?? [])].map((entry) => ({ entry, created: undefined })),
      ];
      return confirmed;
    },
    async run(goneBy) {
      const treeImages = new Set(parents.map((p) => p.entry.name.toLowerCase()));
      const startedAt = now();
      const known = new Map<number, SweepParent>(parents.map((p) => [p.entry.pid, { created: p.created, goneByMs: goneBy.get(p.entry.pid) ?? startedAt }]));
      // Swept processes and when each was known gone (right after its kill).
      let ended: { proc: ProcessTreeEntry; goneByMs: number }[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const table = await deps.read();
        // A kill that did not take.
        if (ended.some((k) => table.some((t) => sameProcess(t, k.proc)))) return 'left';
        for (const k of ended) known.set(k.proc.pid, { created: k.proc.created, goneByMs: k.goneByMs });
        ended = [];
        const plan = planOrphanSweep(known, table, treeImages);
        if (plan.left.length > 0) return 'left';
        if (plan.kill.length === 0) return 'clean';
        const fresh = await deps.read();
        const freshAt = now();
        for (const k of plan.kill) {
          const current = fresh.find((t) => t.pid === k.pid);
          // Its pid went to another process meanwhile: its children cannot be told apart.
          if (current && !sameProcess(current, k)) return 'left';
          if (!current) {
            ended.push({ proc: k, goneByMs: freshAt });
            continue;
          }
          try {
            deps.kill(k.pid);
          } catch {
            // Refused or gone, it cannot be told: not proven ended.
            return 'left';
          }
          ended.push({ proc: k, goneByMs: now() });
        }
        await sleep(POLL_MS);
      }
      return 'left';
    },
  };
}
