// ─── Stopping an agent process wmux spawned, with what it started (POSIX) ───
//
// A My Hermes agent (`hermes -p <profile> acp`) runs the owner's tools as its
// children, and Hermes starts each tool command in its own session
// (`start_new_session=True`), so neither a signal to the agent nor one to its
// process group reaches them, and once the agent is gone they are orphans
// that keep running as the owner. So the tree is read first, by parent PID,
// with each process's start time (an exited one waiting to be reaped counts
// as gone); then:
// 1. SIGINT to the agent alone, which lets Hermes run its own cleanup of its
//    tool groups (its ACP entry catches KeyboardInterrupt and exits), and up
//    to `interruptWaitMs` for it to exit;
// 2. SIGTERM to every process of the tree still alive, then after
//    `termGraceMs` SIGKILL to those still alive.
// Every read of the table follows the tree: a process stays tracked only
// while its PID still has the start time first read for it, and a process
// started meanwhile below a tracked one is added with its own. So a PID the
// OS reused is never touched, a command started during the waits is not
// missed, and nothing outside the agent's tree is ever signalled. A table
// that cannot be read (after a few tries) stops the agent alone, and says
// so. Windows uses its tree kill (taskkill /T), not this.

import { execFile } from 'node:child_process';

/** One row of the process table. */
export interface ProcRow {
  pid: number;
  ppid: number;
  /** The start time as `ps` prints it; compared as text only. */
  start: string;
  /** Exited, waiting to be reaped: nothing left to stop. */
  zombie?: boolean;
}

export interface AgentTreeStopDeps {
  /** The process table (default: `ps -A -o pid=,ppid=,stat=,lstart=`); null when it cannot be read. */
  table?: () => Promise<ProcRow[] | null>;
  /** Send a signal (default: process.kill). */
  signal?: (pid: number, sig: NodeJS.Signals) => void;
  /** Whether a PID exists (default: signal 0); used only when the table cannot be read. */
  alive?: (pid: number) => boolean;
  log?: (line: string) => void;
  interruptWaitMs?: number;
  termGraceMs?: number;
  pollMs?: number;
}

const INTERRUPT_WAIT_MS = 3_000;
const TERM_GRACE_MS = 2_000;
const POLL_MS = 100;
/** Reads of the table before it counts as unreadable. */
const TABLE_TRIES = 3;

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `ps -A -o pid=,ppid=,stat=,lstart=` output as rows. Pure. */
export function parseProcTable(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S.*\S)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), start: m[4], ...(m[3].startsWith('Z') ? { zombie: true } : {}) });
  }
  return rows;
}

/** `root` and every process below it by parent PID. Pure. */
export function treeOf(root: number, rows: readonly ProcRow[]): ProcRow[] {
  const byParent = new Map<number, ProcRow[]>();
  for (const r of rows) {
    const list = byParent.get(r.ppid);
    if (list) list.push(r);
    else byParent.set(r.ppid, [r]);
  }
  const top = rows.find((r) => r.pid === root);
  if (!top) return [];
  const out: ProcRow[] = [];
  const seen = new Set<number>();
  const stack = [top];
  while (stack.length > 0) {
    const r = stack.pop() as ProcRow;
    if (seen.has(r.pid)) continue;
    seen.add(r.pid);
    out.push(r);
    for (const c of byParent.get(r.pid) ?? []) stack.push(c);
  }
  return out;
}

function readTable(): Promise<ProcRow[] | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,stat=,lstart='], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => {
      resolve(err ? null : parseProcTable(String(stdout)));
    });
  });
}

/** The tracked processes that are still the same processes (PID and start
 *  time, not exited), plus every live process now below one of them that is
 *  not tracked yet (a command started since the last read), with its own
 *  start time. Pure. */
export function followTree(tracked: readonly ProcRow[], rows: readonly ProcRow[]): ProcRow[] {
  const live = rows.filter((r) => !r.zombie);
  const now = new Map(live.map((r) => [r.pid, r.start]));
  const out = new Map<number, ProcRow>();
  for (const r of tracked) if (now.get(r.pid) === r.start) out.set(r.pid, r);
  for (const r of [...out.values()]) {
    for (const d of treeOf(r.pid, live)) if (!out.has(d.pid)) out.set(d.pid, d);
  }
  return [...out.values()];
}

/** Stop the agent `pid` and every process it started (see the head of this
 *  file). Resolves once they are gone or signalled with SIGKILL. When the
 *  table cannot be read (after a few tries), only the agent is stopped, and
 *  only while it was last seen alive; that is logged as incomplete. Never
 *  throws. */
export async function stopAgentTree(pid: number, deps: AgentTreeStopDeps = {}): Promise<void> {
  const table = deps.table ?? readTable;
  const signal = deps.signal ?? ((p: number, sig: NodeJS.Signals) => { process.kill(p, sig); });
  const alive = deps.alive ?? defaultAlive;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const send = (p: number, sig: NodeJS.Signals): void => {
    try {
      signal(p, sig);
    } catch {
      /* already gone */
    }
  };
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const poll = deps.pollMs ?? POLL_MS;
  const termGraceMs = deps.termGraceMs ?? TERM_GRACE_MS;
  /** The table, tried a few times: a single failed `ps` is not "all gone". */
  const read = async (): Promise<ProcRow[] | null> => {
    for (let i = 0; i < TABLE_TRIES; i++) {
      if (i > 0) await sleep(poll);
      const rows = await table();
      if (rows) return rows;
    }
    return null;
  };
  /** No table: the agent alone, SIGTERM then SIGKILL, and only while it was
   *  last seen alive (it is wmux's own child, not yet reaped). */
  const agentOnly = async (agentSeen: boolean, when: string): Promise<void> => {
    log(`[acp-brain] the process table could not be read ${when}; stopping only the agent (pid ${pid}), so a command it started may be left running`);
    if (!agentSeen || !alive(pid)) return;
    send(pid, 'SIGTERM');
    const until = Date.now() + termGraceMs;
    while (alive(pid) && Date.now() < until) await sleep(poll);
    if (alive(pid)) send(pid, 'SIGKILL');
  };

  const first = await read();
  if (!first) return agentOnly(true, 'before the stop');
  let tracked = followTree(treeOf(pid, first), first);
  // Not in the table (gone, or the PID is no longer the agent's): nothing is signalled.
  const agent = tracked.find((r) => r.pid === pid);
  if (!agent) return;
  const agentLive = (): boolean => tracked.some((r) => r.pid === agent.pid && r.start === agent.start);
  /** Re-read the table into `tracked`; false when it cannot be read. */
  const update = async (): Promise<boolean> => {
    const rows = await read();
    if (!rows) return false;
    tracked = followTree(tracked, rows);
    return true;
  };

  // 1. Hermes's own cleanup first. The table was read just above, with no
  //    wait in between: the agent's PID and start time match it now.
  send(agent.pid, 'SIGINT');
  const until = Date.now() + (deps.interruptWaitMs ?? INTERRUPT_WAIT_MS);
  while (Date.now() < until) {
    await sleep(poll);
    const seen = agentLive();
    if (!(await update())) return agentOnly(seen, 'while waiting for the agent');
    if (!agentLive()) break;
  }
  // 2. What is left, with whatever it started meanwhile.
  {
    const seen = agentLive();
    if (!(await update())) return agentOnly(seen, 'before SIGTERM');
  }
  if (tracked.length === 0) return;
  for (const r of tracked) send(r.pid, 'SIGTERM');
  const graceUntil = Date.now() + termGraceMs;
  while (tracked.length > 0 && Date.now() < graceUntil) {
    await sleep(poll);
    const seen = agentLive();
    if (!(await update())) return agentOnly(seen, 'after SIGTERM');
  }
  {
    const seen = agentLive();
    if (!(await update())) return agentOnly(seen, 'before SIGKILL');
  }
  for (const r of tracked) send(r.pid, 'SIGKILL');
}
