// Local A2A deliveries the gate could not check, kept to type later.
//
// A delivery refused with `gate_unavailable` (main could not rule out a
// folder-trust prompt), `usage_limited` (the pane is held until its limit
// resets) or `fresh_context_busy` (another delivery held the pane) is not
// about a person or a dialog: the pane may well take it a little later. Main
// keeps it here, the same text for the same task and pane once, and types it
// when the pane's agent stops or on the next sweep, through the full delivery
// gate each time. Everything a send checks is checked again then: the owner
// lane, read fresh from the daemon's task rows; a person typing; an approval.
// The task itself is stored in the daemon from the start, so the receiver can
// read it at any time with a2a_task_query. The queue lives in main's memory
// only: an app restart loses it.
//
// Bounds, after the remote held units (a2aRemote/held.ts): at most
// PER_TASK_CAP entries per task and pane, PER_PANE_CAP per pane and TOTAL_CAP
// in all. Past a cap the storing task gives up its own oldest entry; with
// none of its own there, the new one is not stored (never another sender's).
// Each entry is dropped PENDING_DELIVERY_TTL_MS after it was stored.

import type { GatedSubmitOptions, GatedSubmitRefusal, GatedSubmitResult } from '../../../shared/ptyMessageDelivery';
import { A2A_REMOTE_BODY_MAX } from '../../../shared/a2aRemote';

/** How long a stored delivery waits before it is dropped. */
export const PENDING_DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;
/** Stored deliveries per task and pane. */
export const PENDING_PER_TASK_CAP = 4;
/** Stored deliveries per pane. */
export const PENDING_PER_PANE_CAP = 8;
/** Stored deliveries in all. */
export const PENDING_TOTAL_CAP = 64;
/** The longest text kept, in UTF-16 units: the remote A2A body cap. A local
 *  delivery is usually a one-line nudge; anything longer is not kept. */
export const PENDING_TEXT_MAX = A2A_REMOTE_BODY_MAX;
/** How often stored deliveries are retried while any are kept. */
export const PENDING_SWEEP_MS = 60_000;
/** A task the daemon does not list yet may still be being written (a new
 *  task's row lands after its delivery), and a pane may read as ownerless
 *  while the window reloads: either counts only after this long. */
export const PENDING_TASK_ROW_GRACE_MS = 60_000;

export interface PendingDelivery {
  /** The daemon task the text belongs to. */
  taskId: string;
  ptyId: string;
  text: string;
  agent: string | null;
  /** The gate options to retry with: the task named for the sender check
   *  only when the send had a sender record, a new task's fresh-context
   *  fields kept. */
  opts: GatedSubmitOptions;
  /** The pane's agent at the refusal: its name, its pane session, and the
   *  time of its agent's last session-start hook (null without one). */
  agentName: string;
  incarnationId: string;
  sessionStartAt: number | null;
  storedAt: number;
  /** The pane's last refusal of it. */
  reason: GatedSubmitRefusal['reason'];
  /** When the pane first read as gone, while that lasts. */
  goneSince?: number;
}

export type PendingDropReason = 'cap' | 'expired' | 'task ended' | 'pane gone' | 'agent changed' | 'refused' | 'withdrawn';

/**
 * A stored delivery's task now: `ended` = listed in an ended state;
 * `missing` = not listed; null when that cannot be read, or the daemon
 * withholds the task from the receiving side for now.
 */
export type PendingTaskState = 'open' | 'ended' | 'missing' | 'pane gone' | null;

/**
 * Refusals that leave the pane as it was and that the pane can outgrow: a
 * stored delivery refused with one of these is tried again. Any other
 * refusal, or one after a paste, wrote something into the pane or will not
 * change by waiting, so the entry is dropped rather than repeat it.
 */
const RETRYABLE: ReadonlySet<GatedSubmitRefusal['reason']> = new Set<GatedSubmitRefusal['reason']>([
  'gate_unavailable',
  'usage_limited',
  'user_typing',
  'approval_pending',
  'fresh_context_busy',
  'agent_unverified',
  'deadline',
]);

export interface PendingDeliveryDeps {
  /** The full delivery gate and write; it refuses as `agent_changed` when
   *  the pane's agent is not the one the entry was stored for. */
  submit: (entry: PendingDelivery) => Promise<GatedSubmitResult>;
  /** The task's state, read from the daemon's task rows. */
  taskState: (entry: PendingDelivery) => Promise<PendingTaskState>;
  log: (line: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
}

const defaultTimer = (fn: () => void, ms: number): { cancel: () => void } => {
  const t = setInterval(fn, ms);
  t.unref?.();
  return { cancel: () => clearInterval(t) };
};

/** Drop what is stored for `taskId`: its send turned out not to stand. */
export function withdrawStoredDeliveries(taskId: string): void {
  PendingDeliveries.active?.withdraw(taskId);
}

export class PendingDeliveries {
  /** The queue main runs (one per app); a2a.rpc withdraws through it. */
  static active: PendingDeliveries | null = null;
  /** Oldest first. */
  private entries: PendingDelivery[] = [];
  private readonly busy = new Set<string>();
  private timer: { cancel: () => void } | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: PendingDeliveryDeps) {
    this.now = deps.now ?? Date.now;
    PendingDeliveries.active = this;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Keep `entry`; false when it is not kept. The same text already kept
   *  for the same task and pane keeps its place and age (it may be being
   *  typed right now) and takes the pane's agent as it is now. */
  store(entry: PendingDelivery): boolean {
    const prior = this.entries.find((e) => e.taskId === entry.taskId && e.ptyId === entry.ptyId && e.text === entry.text);
    if (prior) {
      prior.agentName = entry.agentName;
      prior.incarnationId = entry.incarnationId;
      prior.sessionStartAt = entry.sessionStartAt;
      return true;
    }
    const own = this.entries.filter((e) => e.taskId === entry.taskId);
    const ownOnPane = own.filter((e) => e.ptyId === entry.ptyId);
    const onPane = this.entries.filter((e) => e.ptyId === entry.ptyId);
    // At each cap the storing task gives up its own oldest entry there.
    const giveUp = new Set<PendingDelivery>();
    const yieldOwn = (pool: PendingDelivery[], ownPool: PendingDelivery[], cap: number): boolean => {
      if (pool.filter((e) => !giveUp.has(e)).length < cap) return true;
      const oldest = ownPool.find((e) => !giveUp.has(e));
      if (!oldest) return false;
      giveUp.add(oldest);
      return true;
    };
    if (
      !yieldOwn(ownOnPane, ownOnPane, PENDING_PER_TASK_CAP) ||
      !yieldOwn(onPane, ownOnPane, PENDING_PER_PANE_CAP) ||
      !yieldOwn(this.entries, own, PENDING_TOTAL_CAP)
    ) {
      this.deps.log(`[delivery] did not store task ${JSON.stringify(entry.taskId)} for pane ${JSON.stringify(entry.ptyId)}: as many messages wait as are kept`);
      return false;
    }
    for (const e of giveUp) this.drop(e, 'cap');
    this.entries.push(entry);
    this.deps.log(`[delivery] stored task ${JSON.stringify(entry.taskId)} for pane ${JSON.stringify(entry.ptyId)}; it is typed when the pane can take it`);
    this.timer ??= (this.deps.setTimer ?? defaultTimer)(() => void this.sweep(), PENDING_SWEEP_MS);
    return true;
  }

  /** Is `entry` still kept (not typed, dropped or withdrawn)? */
  isKept(entry: PendingDelivery): boolean {
    return this.entries.includes(entry);
  }

  /** The oldest delivery stored for `taskId` on the pane, if any. */
  heldFor(ptyId: string, taskId: string): PendingDelivery | undefined {
    return this.entries.find((e) => e.ptyId === ptyId && e.taskId === taskId);
  }

  /** Drop every delivery stored for the pane: its agent ended. */
  dropPane(ptyId: string, reason: PendingDropReason): void {
    for (const e of this.entries.filter((x) => x.ptyId === ptyId)) this.drop(e, reason);
  }

  /** Drop every delivery stored for `taskId`. */
  withdraw(taskId: string): void {
    for (const e of this.entries.filter((x) => x.taskId === taskId)) this.drop(e, 'withdrawn');
  }

  /**
   * Try the pane's oldest stored delivery once, through the full gate. One
   * paste per pass: the next one waits for the next stop or sweep.
   */
  async retry(ptyId: string): Promise<void> {
    if (this.busy.has(ptyId)) return;
    this.busy.add(ptyId);
    try {
      this.expire();
      const entry = this.entries.find((e) => e.ptyId === ptyId);
      if (!entry) return;
      const state = await this.deps.taskState(entry).catch(() => null);
      if (state === 'pane gone') {
        entry.goneSince ??= this.now();
        if (this.now() - entry.goneSince >= PENDING_TASK_ROW_GRACE_MS) this.dropPane(ptyId, 'pane gone');
        return;
      }
      delete entry.goneSince;
      if (state === 'ended' || (state === 'missing' && this.now() - entry.storedAt >= PENDING_TASK_ROW_GRACE_MS)) {
        this.drop(entry, 'task ended');
        return;
      }
      if (state !== 'open') return;
      const result = await this.deps.submit(entry).catch((err: unknown): GatedSubmitResult => ({
        ok: false,
        reason: 'write_failed',
        detail: `delivery: ${err instanceof Error ? err.message : String(err)}`,
      }));
      // Dropped while the write ran: that is the newer state.
      if (!this.entries.includes(entry)) return;
      if (result.ok) {
        this.remove(entry);
        this.deps.log(`[delivery] typed stored task ${JSON.stringify(entry.taskId)} into pane ${JSON.stringify(ptyId)}`);
      } else if (result.reason === 'agent_changed') {
        this.drop(entry, 'agent changed');
      } else if (result.pasted && !result.cleared) {
        // Its text sits in the pane's composer: typing it again would paste it twice.
        this.remove(entry);
        this.deps.log(`[delivery] stored task ${JSON.stringify(entry.taskId)} was pasted into pane ${JSON.stringify(ptyId)} but not submitted (${result.reason}); not typed again`);
      } else if (result.pasted || !RETRYABLE.has(result.reason)) {
        this.drop(entry, 'refused', result.reason);
      } else {
        entry.reason = result.reason;
        // The pane's conversation was already cleared: the next try types the text alone.
        if (result.freshContextApplied) {
          const rest = { ...entry.opts };
          delete rest.newTask;
          delete rest.keepContext;
          entry.opts = rest;
        }
      }
    } finally {
      this.busy.delete(ptyId);
    }
  }

  /** Try each pane with a stored delivery once. */
  async sweep(): Promise<void> {
    this.expire();
    const panes = [...new Set(this.entries.map((e) => e.ptyId))];
    await Promise.all(panes.map((ptyId) => this.retry(ptyId)));
  }

  private expire(): void {
    const now = this.now();
    for (const e of [...this.entries]) {
      if (now - e.storedAt >= PENDING_DELIVERY_TTL_MS) this.drop(e, 'expired');
    }
  }

  private drop(entry: PendingDelivery, reason: PendingDropReason, refusal?: string): void {
    this.remove(entry);
    const why = refusal ? `${reason} (${refusal})` : reason;
    this.deps.log(`[delivery] dropped stored task ${JSON.stringify(entry.taskId)} for pane ${JSON.stringify(entry.ptyId)}: ${why}; the task stays readable with a2a_task_query`);
  }

  private remove(entry: PendingDelivery): void {
    this.entries = this.entries.filter((e) => e !== entry);
    if (this.entries.length === 0 && this.timer) {
      this.timer.cancel();
      this.timer = null;
    }
  }
}
