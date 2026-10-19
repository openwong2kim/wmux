// ─── One holder set for every live-worker cap (#2393) ──────────────────────
//
// Four caps limit the fan-out workers that run at once:
//
//   maxConcurrentAgents        (agentSlots.ts)   bot holders past their reservation, plus bot turns
//   GLOBAL_CONCURRENT_WORKERS  (fanout.rpc.ts)   bot holders
//   a bot's worker budget      (fanout.rpc.ts)   bot holders of that bot
//   FANOUT_LIVE_TASK_CAP       (fanoutGuards.ts) every holder
//
// Each used to derive "who holds a slot" from its own inputs, so a fix to one
// never reached the others (#2255, #2314, #2321, #2339, #2387). This module
// computes one list of holders, one per task, from the records main already
// keeps, and every cap is a filter over it.
//
// A holder is `held`, `free` or `unknown`. Unknown counts as held, never as
// free. The rules read row statuses, reclaim record states, the durable
// "agent seen gone" facts and the daemon's last good read. Which task a pane
// or workspace is, and when its worker was last launched, come from the
// durable launch record (workerSlots.ts, #2411): every "is this evidence
// newer than the worker?" check compares with that launch time, never with a
// row's revision or edit time, so a ledger row edit never changes a holder.
//
// The one place the caps differ on a holder: a task only its fan-out
// reservation names (`reserved`: admitted, no agent slot, workspace or row
// yet) counts for the worker caps and the live cap, which booked it, but not
// for maxConcurrentAgents, which is what it waits for (counted there, it
// would wait on itself).
//
// In memory only: the set is rebuilt on every look from the records below.

import type { LedgerEntry, LedgerStatus } from '../../shared/ledger';
import { SLOT_ROW_GRACE_MS } from './agentSlots';

export type HolderState = 'held' | 'free' | 'unknown';

export interface WorkerHolder {
  /** The task; `workspace:<id>` for a stamped workspace no record names a
   *  task for, `reservation:<key>#<n>` for a booked task not minted yet,
   *  `grant#<n>` for an agent slot granted to no named task. */
  taskId: string;
  origin: 'bot' | 'owner';
  botId?: string;
  ownerWorkspaceId: string;
  /** The task's workspace (its row's, else the first one seen). */
  workspaceId?: string;
  preset?: string;
  title?: string;
  /** Its ledger row's status, when it has a row. */
  status?: LedgerStatus;
  state: HolderState;
  /** Only its fan-out reservation names it (see the header). */
  reserved: boolean;
  /** Why it is in this state (diagnostics, tests). */
  why: HolderReason;
}

export type HolderReason =
  | 'verdicted' | 'resumed' | 'starting' | 'stopped' | 'workspace-closed' | 'no-agent'
  | 'running' | 'no-read' | 'stale-read' | 'gone' | 'not-reclaimed' | 'not-known-gone' | 'no-task-record'
  | 'resuming';

/** One task a fan-out booked against the caps, until its spawn settles
 *  (FanOutGuards). Process memory only. */
export interface ReservedTask {
  /** The fan-out's scoped key. */
  key: string;
  ownerWorkspaceId: string;
  /** Set when a bot started the fan-out. */
  botId?: string;
  /** Set once the fan-out minted the task. */
  taskId?: string;
  phase: 'pending' | 'spawning';
}

/** The lineage stamp of an open task workspace. */
export interface HolderStamp {
  owner: string;
  origin?: { kind: string; botId?: string };
}

/** What a reclaim record says (workerReclaim.ts ReclaimedWorker). */
export interface HolderRecord {
  taskId: string;
  botId: string;
  ownerWorkspaceId: string;
  taskWorkspaceId: string;
  paneWorkspaceId?: string;
  title: string;
  state: 'stopping' | 'stopped' | 'resumed';
  ended: 'completed' | 'cancelled' | 'failed' | 'reported';
  /** When it reached its state. */
  at: number;
}

/** Everything the holder rules read, as plain data. */
export interface HolderSnapshot {
  now: number;
  /** Ledger rows: the rules pick the open ones and the ended ones that may
   *  still hold. */
  rows: readonly LedgerEntry[];
  /** Ended rows whose end the worker reclaim handles (isReclaimableEnd). */
  reclaimable: ReadonlySet<string>;
  /** An ended bot task the reclaim has not covered holds this long with its
   *  workspace closed (RECLAIM_CATCHUP_MS). */
  catchupMs: number;
  /** Open workspace ids, or null before the renderer pushed its tree. */
  workspaces: ReadonlySet<string> | null;
  /** Each open workspace's panes. */
  ptys: ReadonlyMap<string, readonly string[]>;
  /** The lineage stamps of the open workspaces. */
  stamps: ReadonlyMap<string, HolderStamp>;
  /** The daemon's sessions: `ok` read lately, `stale` a last good read that
   *  is old, `down` never read. A stale read stands (one-way): what it saw
   *  stopped stays stopped until a read sees otherwise. */
  read: 'ok' | 'stale' | 'down';
  /** Open workspaces whose panes all run no agent (last good read). */
  idle: ReadonlySet<string>;
  /** Open workspaces with a pane at work: an agent alive or a command
   *  running (last good read). */
  busy: ReadonlySet<string>;
  /** Workspaces an agent was seen running in (taskWorkspaceLiveness). */
  agentSeen: ReadonlySet<string>;
  /** Tasks whose own worker pane was seen running, wherever it is, with
   *  their bot when known (every such pane is a bot worker's). */
  agentTasks?: ReadonlyMap<string, string | undefined>;
  /** Ended tasks whose agent is known gone (agentGoneFacts.ts). */
  gone: ReadonlySet<string>;
  /** When that was seen (its fact's time), when known. */
  goneAt?: (taskId: string) => number | undefined;
  records: readonly HolderRecord[];
  /** Verify tasks whose verdict is recorded. */
  verdicted: ReadonlySet<string>;
  /** The task a workspace was created or relaunched for (its launch record,
   *  else its lineage stamp), or null. */
  taskOfWorkspace: (workspaceId: string) => string | null;
  /** The task a pane was created or relaunched for, or null. */
  taskOfPane: (ptyId: string) => string | null;
  /** When the task's worker was launched, if that launch came up or is
   *  coming up now (WorkerSlots.liveLaunchAt). */
  launchAt: (taskId: string) => number | undefined;
  /** The task's last recorded launch, whatever became of it
   *  (WorkerSlots.launchOf): when it began and who started it. */
  launchOf: (taskId: string) => { launchedAt: number; origin: 'bot' | 'owner'; botId?: string } | null;
  reservations: readonly ReservedTask[];
  /** Agent slots granted and not released yet (AgentSlots); `byOwner`: the
   *  owner's Resume took it. */
  grants: ReadonlyArray<{ taskId?: string; botId?: string; byOwner?: boolean }>;
  /** Spawned workspaces whose ledger row was not written (AgentSlots). */
  heldWorkspaces: readonly string[];
  /** When the last good read of the daemon's sessions started: what it saw
   *  idle says nothing of a worker launched after it. */
  readAt?: number;
  /** A task this recent counts while its worker comes up. */
  graceMs?: number;
}

const OPEN: ReadonlySet<string> = new Set(['working', 'input_required', 'review_requested']);
const isOpen = (s: string | undefined): boolean => !!s && OPEN.has(s);

interface Acc {
  row?: LedgerEntry;
  record?: HolderRecord;
  units: ReservedTask[];
  grants: number;
  /** Granted to a bot's resume (its budget check books it apart). */
  botResumes: number;
  /** Its own worker pane was seen running (a bot worker's). */
  sighted?: boolean;
  held: boolean;
  workspaces: Set<string>;
  stamp?: HolderStamp;
  botId?: string;
  owner?: string;
}

function safe(read: () => string | null): string | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** The holder set. Pure over its snapshot; never throws on well-formed input. */
export function computeHolders(s: HolderSnapshot): WorkerHolder[] {
  const grace = s.graceMs ?? SLOT_ROW_GRACE_MS;
  const acc = new Map<string, Acc>();
  const add = (id: string): Acc => {
    let a = acc.get(id);
    if (!a) {
      a = { units: [], grants: 0, botResumes: 0, held: false, workspaces: new Set() };
      acc.set(id, a);
    }
    return a;
  };
  const rowById = new Map<string, LedgerEntry>();
  // The row of a workspace: its latest (TaskLedger.findByTaskWorkspace).
  // A selector between rows naming one workspace, not a freshness check.
  const rowOfWs = new Map<string, LedgerEntry>();
  for (const r of s.rows) {
    rowById.set(r.id, r);
    const cur = rowOfWs.get(r.taskWorkspaceId);
    if (!cur || r.updatedAt > cur.updatedAt) rowOfWs.set(r.taskWorkspaceId, r);
  }
  const recordOf = new Map(s.records.map((r) => [r.taskId, r]));
  // A worker resumed before launch records were kept (#2411) is known by
  // its reclaim record only: the workspace it was reclaimed in and the one
  // it was resumed into.
  const recordOfWs = new Map<string, string>();
  for (const r of s.records) {
    if (!recordOfWs.has(r.taskWorkspaceId)) recordOfWs.set(r.taskWorkspaceId, r.taskId);
    if (r.paneWorkspaceId) recordOfWs.set(r.paneWorkspaceId, r.taskId);
  }
  const isOpenWs = (ws: string | undefined): boolean => !!ws && !!s.workspaces?.has(ws);
  // The reclaim's catch-up window runs from the task's last recorded launch:
  // a row edit never reopens it, and a row with no launch record is past it.
  const inWindow = (r: LedgerEntry): boolean => {
    const at = s.launchOf(r.id)?.launchedAt;
    return at !== undefined && s.now - at < s.catchupMs;
  };

  // Rows: every open one, and an ended one whose workspace is open or whose
  // worker the reclaim has not covered yet within its window.
  for (const r of s.rows) {
    if (isOpen(r.status)) {
      add(r.id).row = r;
      continue;
    }
    const rec = recordOf.get(r.id);
    if (isOpenWs(r.taskWorkspaceId) || isOpenWs(rec?.paneWorkspaceId) || s.agentTasks?.has(r.id) || s.agentSeen.has(r.taskWorkspaceId)
      || (s.reclaimable.has(r.id) && inWindow(r))) add(r.id).row = r;
  }
  // A resumed worker holds whether or not its row is still there, and so
  // does a worker whose own pane is seen running.
  for (const r of s.records) if (r.state === 'resumed') add(r.taskId);
  for (const [t, botId] of s.agentTasks ?? []) {
    const a = add(t);
    a.sighted = true;
    a.botId ??= botId;
  }
  // Reservations: one per task, the minted ones under their task.
  const anonymous = new Map<string, number>();
  for (const u of s.reservations) {
    let id = u.taskId;
    if (!id) {
      const n = anonymous.get(u.key) ?? 0;
      anonymous.set(u.key, n + 1);
      id = `reservation:${u.key}#${n}`;
    }
    const a = add(id);
    a.units.push(u);
    a.botId ??= u.botId;
    a.owner ??= u.ownerWorkspaceId;
  }
  s.grants.forEach((g, i) => {
    const a = add(g.taskId ?? `grant#${i}`);
    a.grants++;
    if (!g.byOwner) a.botResumes++;
    a.botId ??= g.botId;
  });
  /** The task a workspace belongs to: the launch it was created or
   *  relaunched for, else the row or reclaim record that names it, else the
   *  launch one of its panes was created for; else the workspace itself. */
  const taskOfWs = (ws: string): string => {
    const known = safe(() => s.taskOfWorkspace(ws)) ?? rowOfWs.get(ws)?.id ?? recordOfWs.get(ws);
    if (known) return known;
    for (const pty of s.ptys.get(ws) ?? []) {
      const t = safe(() => s.taskOfPane(pty));
      if (t) return t;
    }
    return `workspace:${ws}`;
  };
  for (const [ws, stamp] of s.stamps) {
    if (s.workspaces && !s.workspaces.has(ws)) continue;
    const a = add(taskOfWs(ws));
    a.workspaces.add(ws);
    a.stamp ??= stamp;
  }
  for (const ws of s.heldWorkspaces) {
    const a = add(taskOfWs(ws));
    a.workspaces.add(ws);
    a.held = true;
  }

  const out: WorkerHolder[] = [];
  for (const [taskId, a] of acc) {
    const row = a.row ?? rowById.get(taskId);
    const record = recordOf.get(taskId);
    const ws = new Set(a.workspaces);
    if (row) ws.add(row.taskWorkspaceId);
    if (record) {
      ws.add(record.taskWorkspaceId);
      if (record.paneWorkspaceId) ws.add(record.paneWorkspaceId);
    }
    const stamp = a.stamp ?? (row ? s.stamps.get(row.taskWorkspaceId) : undefined);
    const dispatched = row?.dispatch?.origin;
    const launch = dispatched ? null : s.launchOf(taskId);
    const botId = dispatched
      ? (dispatched.kind === 'bot' ? dispatched.botId : undefined)
      : (stamp?.origin?.kind === 'bot' ? stamp.origin.botId : undefined) ?? record?.botId ?? launch?.botId ?? a.botId;
    // Who started it: its row's dispatch, else its launch record; with
    // neither, an agent slot is granted and held, and a worker pane is
    // sighted, only for a bot's worker.
    const bot = !!botId || (!dispatched && (launch
      ? launch.origin === 'bot'
      : a.grants > 0 || a.held || !!a.sighted));
    const reserved = a.units.length > 0 && a.grants === 0 && !row && !record && ws.size === 0 && !a.held;
    const { state, why } = decide(s, taskId, a, row, record, ws, grace, inWindow);
    out.push({
      taskId,
      origin: bot ? 'bot' : 'owner',
      ...(botId ? { botId } : {}),
      ownerWorkspaceId: row?.ownerWorkspaceId ?? stamp?.owner ?? record?.ownerWorkspaceId ?? a.owner ?? '',
      ...(row?.taskWorkspaceId ?? [...ws][0] ? { workspaceId: row?.taskWorkspaceId ?? [...ws][0] } : {}),
      ...(row?.dispatch?.preset ? { preset: row.dispatch.preset } : {}),
      ...(row?.title ?? record?.title ? { title: row?.title ?? record?.title } : {}),
      ...(row ? { status: row.status } : {}),
      state,
      reserved,
      why,
    });
  }
  return out;
}

function decide(
  s: HolderSnapshot,
  taskId: string,
  a: Acc,
  row: LedgerEntry | undefined,
  record: HolderRecord | undefined,
  ws: ReadonlySet<string>,
  grace: number,
  inWindow: (r: LedgerEntry) => boolean,
): { state: HolderState; why: HolderReason } {
  // The worker's launch now (a first spawn, a respawn, a resume or a
  // relaunch in its pane): evidence older than it says nothing of it.
  const launch = s.launchAt(taskId);
  const stopped = record?.state === 'stopped' && !(launch !== undefined && launch > record.at);
  // A read that started before the stop saw the worker before it was
  // stopped: what it saw running says nothing against that stop.
  const readBeforeStop = stopped && (s.readAt === undefined || s.readAt <= (record as HolderRecord).at);
  const seen = (set: ReadonlySet<string>): boolean => !readBeforeStop
    && ([...ws].some((w) => set.has(w)) || (set === s.agentSeen && !!s.agentTasks?.has(taskId)));
  const launchedLately = launch !== undefined && s.now - launch < grace;
  // A read that started before the launch saw the pane before its agent.
  const readBeforeLaunch = launch !== undefined && (s.readAt === undefined || launch >= s.readAt);
  const open = s.workspaces ? [...ws].filter((w) => s.workspaces?.has(w)) : [...ws];
  // A verify task's verdict was the reason it ran: once recorded, it holds
  // nothing, whatever its panes show.
  if (row?.dispatch?.preset === 'verify' && row.status === 'review_requested' && s.verdicted.has(taskId)) return { state: 'free', why: 'verdicted' };
  if (record?.state === 'resumed') return { state: 'held', why: 'resumed' };
  // A spawn under way (booked, granted or not yet settled); a granted slot
  // for a reclaimed worker is its resume.
  if (a.units.length > 0) return { state: 'held', why: 'starting' };
  if (a.grants > 0) return { state: 'held', why: record && a.botResumes > 0 ? 'resuming' : 'starting' };
  if (!row) {
    // A stamped workspace or a held slot that no row names (a crash before
    // the ledger register, a workspace a resume left behind): it holds while
    // a pane of it may run an agent, as an open task does.
    if (stopped && !seen(s.busy) && !seen(s.agentSeen)) return { state: 'free', why: 'stopped' };
    // Its own agent seen running anywhere (a pane moved out of it) holds.
    if (seen(s.agentSeen)) return { state: 'held', why: 'running' };
    if (launchedLately) return { state: 'held', why: 'starting' };
    if (s.workspaces && open.length === 0) return { state: 'free', why: 'workspace-closed' };
    if (s.read === 'down' || readBeforeLaunch) return { state: 'unknown', why: 'no-read' };
    if (open.every((w) => (s.ptys.get(w)?.length ?? 0) === 0 || s.idle.has(w))) return { state: 'free', why: 'no-agent' };
    return s.read === 'ok' ? { state: 'held', why: 'no-task-record' } : { state: 'unknown', why: 'stale-read' };
  }
  if (isOpen(row.status)) {
    // Its worker was stopped (paused for review) and the row still says so:
    // a status that has not moved, whatever was edited on the row, unless a
    // worker relaunched there.
    if (stopped && record?.ended === 'reported' && row.status === 'review_requested'
      && !seen(s.busy) && !seen(s.agentSeen)) return { state: 'free', why: 'stopped' };
    // Launched lately: its pane and agent come up after the launch record.
    if (launchedLately) return { state: 'held', why: 'starting' };
    // Its own agent seen running anywhere (a pane moved out of its
    // workspace) holds, whatever its workspace shows.
    if (seen(s.agentSeen)) return { state: 'held', why: 'running' };
    if (s.workspaces && open.length === 0) return { state: 'free', why: 'workspace-closed' };
    if (s.read === 'down' || readBeforeLaunch) return { state: 'unknown', why: 'no-read' };
    // Its workspaces run no agent: one read idle, any other idle or left
    // with no pane (an earlier workspace a respawn moved it out of).
    if (open.some((w) => s.idle.has(w)) && open.every((w) => s.idle.has(w) || (s.ptys.get(w)?.length ?? 0) === 0)) return { state: 'free', why: 'no-agent' };
    return s.read === 'ok' ? { state: 'held', why: 'running' } : { state: 'unknown', why: 'stale-read' };
  }
  // Ended. An agent seen running holds, whatever a record or a fact says.
  if (seen(s.agentSeen)) return { state: 'held', why: 'running' };
  if (stopped) return { state: 'free', why: 'stopped' };
  // A fact older than the worker's last launch says nothing of it.
  const goneAt = s.gone.has(taskId) ? s.goneAt?.(taskId) : undefined;
  if (s.gone.has(taskId) && !(launch !== undefined && goneAt !== undefined && launch > goneAt)) return { state: 'free', why: 'gone' };
  if (open.length === 0 || !s.workspaces) {
    // Its workspace is closed (or not known yet): a bot worker the reclaim
    // has not covered still holds within the window; any other is free.
    return s.reclaimable.has(taskId) && inWindow(row)
      ? { state: 'unknown', why: 'not-reclaimed' }
      : { state: 'free', why: 'workspace-closed' };
  }
  return { state: 'unknown', why: 'not-known-gone' };
}

export interface HolderCounts {
  /** Every holder not free: the fan-out live cap. */
  live: number;
  /** Bot holders: the factory-wide worker cap. */
  workers: number;
  /** Bot holders past their reservation: the agent budget (with bot turns). */
  agents: number;
  /** Bot holders of the bot asked about: its worker budget. */
  bot: number;
  /** ...of which a spawn is under way. */
  botStarting: number;
}

/** The caps' counts over one holder list. Pure. */
export function holderCounts(holders: readonly WorkerHolder[], botId?: string): HolderCounts {
  const out: HolderCounts = { live: 0, workers: 0, agents: 0, bot: 0, botStarting: 0 };
  for (const h of holders) {
    if (h.state === 'free') continue;
    out.live++;
    if (h.origin !== 'bot') continue;
    out.workers++;
    if (!h.reserved) out.agents++;
    if (botId !== undefined && h.botId === botId) {
      out.bot++;
      if (h.why === 'starting' || h.why === 'resuming') out.botStarting++;
    }
  }
  return out;
}

export interface LiveHolders {
  holders: WorkerHolder[];
  /** Whether the open workspaces were known (the renderer pushed its tree). */
  workspacesKnown: boolean;
}

let source: (() => HolderSnapshot) | null = null;
let sourceKey: (() => readonly unknown[]) | null = null;
let memo: { key: readonly unknown[]; value: LiveHolders } | null = null;

/** Set by the worker lifecycle host: how to read a snapshot now, and the
 *  key of what it reads (holderInputs.ts's counter, ledger transitions,
 *  workspace-tree pushes, the last daemon read). One look answers every cap
 *  that asks in the same turn of the event loop (a fan-out tick asks several
 *  times) while its key is unchanged; the next turn looks again. Without a
 *  key, every look is fresh. */
export function setHolderSource(next: (() => HolderSnapshot) | null, key?: () => readonly unknown[]): void {
  source = next;
  sourceKey = next ? key ?? null : null;
  memo = null;
}

const sameKey = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

/** The holder set now, or null while no source is installed (the old
 *  per-cap counts answer then). Throws when the snapshot cannot be read. */
export function liveHolders(): LiveHolders | null {
  if (!source) return null;
  const key = sourceKey ? sourceKey() : null;
  if (key && memo && sameKey(key, memo.key)) {
    return { holders: memo.value.holders.slice(), workspacesKnown: memo.value.workspacesKnown };
  }
  const snap = source();
  const value = { holders: computeHolders(snap), workspacesKnown: snap.workspaces !== null };
  if (key) {
    const entry = { key, value };
    memo = entry;
    // Only for the rest of this turn: time-bound rules (a launch's grace,
    // the catch-up window) and records no key covers are read again next turn.
    queueMicrotask(() => {
      if (memo === entry) memo = null;
    });
  }
  return { holders: value.holders.slice(), workspacesKnown: value.workspacesKnown };
}
