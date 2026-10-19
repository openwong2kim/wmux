// ─── One budget for bots and workers together ──────────────────────────────
//
// Every bot turn runs its own agent process, and every fan-out worker keeps an
// interactive CLI with its MCP servers resident while its task is open. The
// factory caps how many of those run at once (`maxConcurrentAgents`, Settings
// › Bots): in use = bots running a turn + live bot workers (the holder set's
// bot holders, workerHolders.ts: open bot tasks whose worker still runs,
// ended ones not stopped yet, resumed workers, and the launches granted or
// held here).
//
// What the cap holds back is a NEW worker a bot starts: the task gets its
// worktree, then waits for a slot before its pane is spawned, first come first
// served (a spawned worker whose ledger row could not be written keeps its
// slot while its workspace lives). While it waits one system card in the bot's thread says so ("waiting
// for a slot") and the Bots page lists it; it starts as soon as a slot frees,
// or is not launched after SLOT_WAIT_MAX_MS. Bot turns themselves are not
// held here (globalConcurrentBots governs them), and work the owner starts
// (a pane's or the window's fan-out) is neither held nor counted: the cap is
// the bots' budget, and the owner's own sessions never starve it. The
// owner's Resume of a bot's stopped worker relaunches that bot worker, so it
// takes a free slot like a bot's resume does, or is refused (tryAcquire). A task row whose workspace is gone, or whose panes run no agent
// any more, holds no slot either (an open row can outlive its worker).

import { holderInputsChanged } from './holderInputs';
import type { LedgerEntry } from '../../shared/ledger';

export const SLOT_WAIT_MAX_MS = 30 * 60_000;
/** A granted slot neither released nor held by then (its launch ended on a
 *  path that did neither) stops counting: the cap never shrinks for good. */
export const SLOT_GRANT_MAX_MS = 15 * 60_000;
const POLL_MS = 2_000;
/** A task row this recent counts even when its workspace or its agent is
 *  not seen yet: a worker's pane and agent come up after its row. */
export const SLOT_ROW_GRACE_MS = 2 * 60_000;

/** Holders a slot-wait card names, at most, per kind. */
export const SLOT_HOLDERS_SHOWN_MAX = 6;

/** What holds the agent slots, for a slot-wait card: the English words
 *  (`holders`, kept for a reader that cannot word the rest) and the same as
 *  values the reader's language words (roomFormat.ts): the bots in a turn
 *  and the workers by title, each list newline-joined and cut at
 *  SLOT_HOLDERS_SHOWN_MAX, with their full counts. Pure. */
export function slotHolderArgs(bots: readonly string[], workers: readonly string[], inUse: number): {
  holders: string; bots: string; botCount: number; workers: string; workerCount: number;
} {
  const shown = (names: readonly string[]): string[] => names.slice(0, SLOT_HOLDERS_SHOWN_MAX);
  const list = (names: readonly string[]): string => names.length <= SLOT_HOLDERS_SHOWN_MAX
    ? names.join(', ')
    : `${shown(names).join(', ')} and ${names.length - SLOT_HOLDERS_SHOWN_MAX} more`;
  const quoted = workers.map((w) => `"${w}"`);
  const parts: string[] = [];
  if (bots.length > 0) parts.push(`${bots.length === 1 ? 'bot' : 'bots'} in a turn ${list(bots)}`);
  if (workers.length > 0) parts.push(`${workers.length === 1 ? 'worker' : 'workers'} ${list(quoted)}`);
  const rest = inUse - bots.length - workers.length;
  if (rest > 0) parts.push(`${rest} other ${rest === 1 ? 'worker' : 'workers'} starting, resumed or not yet reclaimed`);
  return {
    holders: parts.length > 0 ? parts.join('; ') : 'nothing the factory can name',
    bots: shown(bots).join('\n'),
    botCount: bots.length,
    workers: shown(workers).join('\n'),
    workerCount: workers.length,
  };
}

/** What the slot count reads of one daemon session (daemon.listSessions). */
export interface SlotPaneInfo {
  state?: unknown;
  agentProcessAlive?: unknown;
  /** OSC 133: a foreground command owns the pane (absent: unknown). */
  commandRunning?: unknown;
  /** The daemon respawned the pane at its own restart and has seen no agent
   *  there since (absent from a daemon that does not say). */
  recoveredAgentUnconfirmed?: unknown;
}

/** Whether a pane runs no agent for the slot count: gone, no live PTY, its
 *  agent seen to exit, or a fresh shell the daemon respawned at its restart
 *  with no agent seen since and no command running in it. An agent never attributed otherwise is not known
 *  dead (an older daemon may simply not say). Pure. */
export function paneRunsNoAgent(s: SlotPaneInfo | undefined): boolean {
  if (!s) return true;
  if (s.state === 'dead' || s.state === 'suspended') return true;
  if (s.agentProcessAlive === false) return true;
  return s.agentProcessAlive !== true && s.commandRunning !== true && s.recoveredAgentUnconfirmed === true;
}

/** Whether a pane shows something running: its agent seen alive, or a
 *  foreground command in its shell. Pure. */
export function paneShowsWork(s: SlotPaneInfo | undefined): boolean {
  return !!s && (s.agentProcessAlive === true || s.commandRunning === true);
}

/** Whether a ledger row holds an agent slot while no holder set is
 *  installed (before the worker lifecycle host starts; it decides from then
 *  on, workerHolders.ts): an open bot task. The owner's own fan-outs do not
 *  count; a completed, cancelled or failed row never does. Pure. */
export function rowHoldsAgentSlot(row: Pick<LedgerEntry, 'dispatch'> & { status?: LedgerEntry['status'] }): boolean {
  if (row.dispatch?.origin?.kind !== 'bot') return false;
  return row.status !== 'completed' && row.status !== 'cancelled' && row.status !== 'failed';
}

export interface WaitingWorker {
  taskId: string;
  title: string;
  botId: string;
  ownerWorkspaceId: string;
  /** The room thread the bot started it from. */
  threadId?: string;
  since: number;
}

export interface AgentSlotPorts {
  cap: () => number;
  /** Bots running a turn now. */
  runningBots: () => number;
  /** Live workers, the slots granted and held here among them (the holder
   *  set, workerHolders.ts, reads those through pendingSlots). */
  liveWorkers: () => number;
  /** Whether a spawned worker whose ledger row was not written still holds
   *  its slot: its workspace lives and still no row counts it. Absent: a held
   *  slot is released at once. */
  stillHeld?: (workspaceId: string) => boolean;
  /** A worker started waiting (a card, a Bots page refresh). */
  onWaiting?: (w: WaitingWorker, inUse: number, cap: number) => void;
  /** The waiting list changed. */
  changed?: () => void;
  log?: (msg: string) => void;
  now?: () => number;
  maxWaitMs?: number;
  pollMs?: number;
}

export type SlotGrant =
  | { ok: true; release: () => void; hold: (workspaceId: string) => void }
  | { ok: false; reason: string };

interface Waiter {
  w: WaitingWorker;
  resolve: (g: SlotGrant) => void;
  /** Why the launch is no longer wanted (the bot was stopped), or null. */
  refusal?: () => string | null;
}

interface Grant {
  botId?: string;
  taskId?: string;
  /** The owner's Resume took it (not a bot's). */
  byOwner?: boolean;
  at: number;
}

export class AgentSlots {
  /** Granted slots not yet released or held. */
  private readonly grants = new Set<Grant>();
  /** Spawned workers with no ledger row, counted until stillHeld says no. */
  private readonly held = new Set<string>();
  private readonly queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  constructor(private readonly ports: AgentSlotPorts) {}

  /** Agents counted against the cap now. Never throws. */
  inUse(): number {
    this.prune();
    let n = 0;
    try {
      n += Math.max(0, this.ports.runningBots());
    } catch {
      /* counted as what could be read */
    }
    try {
      n += Math.max(0, this.ports.liveWorkers());
    } catch {
      // Fail closed: the slots granted and held here still count when the
      // workers that include them cannot be read.
      n += this.grants.size + this.held.size;
    }
    return n;
  }

  /** The slots granted and not released yet, and the spawned workspaces
   *  held with no ledger row: what the holder set counts of this budget. */
  pendingSlots(): { grants: Array<{ taskId?: string; botId?: string; byOwner?: boolean }>; held: string[] } {
    this.prune();
    return {
      grants: [...this.grants].map((g) => ({ ...(g.taskId ? { taskId: g.taskId } : {}), ...(g.botId ? { botId: g.botId } : {}), ...(g.byOwner ? { byOwner: true } : {}) })),
      held: [...this.held],
    };
  }

  /** Drops grants past SLOT_GRANT_MAX_MS and held workspaces stillHeld no
   *  longer keeps. */
  private prune(): void {
    const at = (this.ports.now ?? Date.now)();
    for (const g of [...this.grants]) {
      if (at - g.at < SLOT_GRANT_MAX_MS) continue;
      (this.ports.log ?? ((m: string) => console.warn(m)))(`[factory] the agent slot granted for ${g.taskId ?? 'a launch'} was never released; it no longer counts`);
      this.grants.delete(g);
      holderInputsChanged();
    }
    for (const ws of [...this.held]) {
      let keep = false;
      try {
        keep = this.ports.stillHeld?.(ws) ?? false;
      } catch {
        keep = true; // cannot tell: keep counting it
      }
      if (!keep) {
        this.held.delete(ws);
        holderInputsChanged();
      }
    }
  }

  waiting(): WaitingWorker[] {
    return this.queue.map((q) => ({ ...q.w }));
  }

  /** The tasks of `botId` waiting for a slot or holding a granted one (their
   *  launch is under way and not yet registered). */
  inFlight(botId: string): string[] {
    const out = new Set<string>();
    for (const q of this.queue) if (q.w.botId === botId) out.add(q.w.taskId);
    for (const g of this.grants) if (g.botId === botId && g.taskId) out.add(g.taskId);
    return [...out];
  }

  /** Wait for a slot for a bot's new worker (FIFO). `refusal` is asked on
   *  every re-check while it waits: a reason ends the wait unlaunched. */
  acquire(w: Omit<WaitingWorker, 'since'>, refusal?: () => string | null): Promise<SlotGrant> {
    if (this.disposed) return Promise.resolve({ ok: false, reason: 'the agent factory stopped' });
    if (this.queue.length === 0 && this.inUse() < this.cap()) return Promise.resolve(this.grant(w));
    const now = this.ports.now ?? Date.now;
    const waiter: WaitingWorker = { ...w, since: now() };
    return new Promise<SlotGrant>((resolve) => {
      this.queue.push({ w: waiter, resolve, ...(refusal ? { refusal } : {}) });
      try {
        this.ports.onWaiting?.(waiter, this.inUse(), this.cap());
      } catch {
        /* the card is best effort */
      }
      this.ports.changed?.();
      this.arm();
    });
  }

  /** A slot now, or null when none is free (or others wait first): for a
   *  start that does not wait (a bot's resume answers its tool call). `w`:
   *  the task it is for, so the slot and that task count as one. */
  tryAcquire(w?: { botId?: string; taskId?: string; byOwner?: boolean }): SlotGrant | null {
    if (this.disposed || this.queue.length > 0 || this.inUse() >= this.cap()) return null;
    return this.grant(w);
  }

  /** The cap in force (at least 1). */
  limit(): number {
    return this.cap();
  }

  /** Re-check the queue now (a task ended, a turn ended). */
  kick(): void {
    if (this.disposed || this.queue.length === 0) return;
    const now = (this.ports.now ?? Date.now)();
    const maxWait = this.ports.maxWaitMs ?? SLOT_WAIT_MAX_MS;
    let changed = false;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      let why: string | null = null;
      try {
        why = q.refusal?.() ?? null;
      } catch (err) {
        why = `the launch check failed: ${String(err)}`;
      }
      if (!why && now - q.w.since >= maxWait) why = `no agent slot freed within ${Math.round(maxWait / 60_000)} minutes`;
      if (!why) continue;
      this.queue.splice(i, 1);
      q.resolve({ ok: false, reason: why });
      changed = true;
    }
    while (this.queue.length > 0 && this.inUse() < this.cap()) {
      const q = this.queue.shift() as Waiter;
      q.resolve(this.grant(q.w));
      changed = true;
    }
    if (changed) this.ports.changed?.();
    if (this.queue.length > 0) this.arm();
  }

  /** Refuse every waiter (factory stopped or disposed). */
  dispose(reason = 'the agent factory stopped'): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const q of this.queue.splice(0)) q.resolve({ ok: false, reason });
  }

  private cap(): number {
    try {
      const c = this.ports.cap();
      return Number.isFinite(c) && c >= 1 ? c : 1;
    } catch {
      return 1;
    }
  }

  private grant(w?: { botId?: string; taskId?: string; byOwner?: boolean }): SlotGrant {
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.grants.delete(g);
      holderInputsChanged();
      this.kick();
    };
    const g: Grant = { ...(w?.botId ? { botId: w.botId } : {}), ...(w?.taskId ? { taskId: w.taskId } : {}), ...(w?.byOwner ? { byOwner: true } : {}), at: (this.ports.now ?? Date.now)() };
    this.grants.add(g);
    holderInputsChanged();
    return {
      ok: true,
      release,
      hold: (workspaceId) => {
        if (released) return;
        if (workspaceId && this.ports.stillHeld) {
          this.held.add(workspaceId);
          holderInputsChanged();
        }
        release();
      },
    };
  }

  private arm(): void {
    if (this.timer || this.disposed) return;
    const t = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, this.ports.pollMs ?? POLL_MS);
    t.unref?.();
    this.timer = t;
  }
}

/** The open workspaces whose panes all run no agent any more, read from the
 *  daemon at most every `refreshMs`. `get()` answers at once from the last
 *  read (starting a new one in the background when it is stale); `fresh()`
 *  waits for a read when the last one is stale, so a decision never rests on
 *  a snapshot older than `refreshMs` however long ago the previous check ran.
 *  A failed read keeps the last snapshot. */
export class IdleSnapshot {
  private idle: ReadonlySet<string> = new Set();
  private readAt = 0;
  private reading: Promise<void> | null = null;

  constructor(
    private readonly read: () => Promise<ReadonlySet<string>>,
    private readonly refreshMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The last snapshot (none until the first read). */
  get(): ReadonlySet<string> {
    void this.fresh();
    return this.idle;
  }

  /** Resolves once the snapshot is no older than `refreshMs` (or its read failed). */
  fresh(): Promise<void> {
    if (this.reading) return this.reading;
    if (this.readAt > 0 && this.now() - this.readAt < this.refreshMs) return Promise.resolve();
    this.reading = this.read().then((next) => {
      this.idle = next;
      this.readAt = this.now();
    }).catch(() => undefined).finally(() => {
      this.reading = null;
    });
    return this.reading;
  }
}

let current: AgentSlots | null = null;
let livenessRefresh: (() => Promise<void>) | null = null;

/** Set by the worker lifecycle host: how to bring what the holder set reads
 *  of the workers' panes up to date before a decision. */
export function setSlotLivenessRefresh(refresh: (() => Promise<void>) | null): void {
  livenessRefresh = refresh;
}

/** Brings what the holder set reads of the workers' panes up to date.
 *  Never rejects. */
export async function refreshSlotLiveness(): Promise<void> {
  try {
    await livenessRefresh?.();
  } catch {
    /* decided on what is known */
  }
}

export function setAgentSlots(next: AgentSlots | null): void {
  current = next;
}

export function getAgentSlots(): AgentSlots | null {
  return current;
}
