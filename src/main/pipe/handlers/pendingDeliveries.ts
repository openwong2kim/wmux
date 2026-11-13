// Local A2A deliveries the gate could not check, kept to type later.
//
// A delivery refused with `gate_unavailable` (main could not rule out a
// folder-trust prompt) or `usage_limited` (the pane is held until its limit
// resets) is not about a person or a dialog: the pane may well take it a
// little later. Main keeps it here, one entry per task, and types it when the
// pane's agent stops or on the next sweep, through the full delivery gate
// each time. Everything a send checks is checked again then: the owner lane,
// read fresh from the daemon's task rows; a person typing; an approval. The
// task itself is stored in the daemon from the start, so the receiver can read
// it at any time with a2a_task_query.
//
// Bounds, after the remote held units (a2aRemote/held.ts): at most
// PER_PANE_CAP entries per pane and TOTAL_CAP in all, the oldest dropped
// first, and each entry dropped PENDING_DELIVERY_TTL_MS after it was stored.

import type { GatedSubmitOptions, GatedSubmitResult } from '../../../shared/ptyMessageDelivery';

/** How long a stored delivery waits before it is dropped. */
export const PENDING_DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;
/** Stored deliveries per pane; a new one past it drops that pane's oldest. */
export const PENDING_PER_PANE_CAP = 8;
/** Stored deliveries in all; a new one past it drops the oldest anywhere. */
export const PENDING_TOTAL_CAP = 64;
/** How often stored deliveries are retried while any are kept. */
export const PENDING_SWEEP_MS = 60_000;
/** A task the daemon does not list yet may still be being written (a new
 *  task's row lands after its delivery): it counts as ended only after this. */
export const PENDING_TASK_ROW_GRACE_MS = 60_000;

export interface PendingDelivery {
  /** The daemon task the text belongs to. */
  taskId: string;
  ptyId: string;
  text: string;
  agent: string | null;
  /** The gate options to retry with: the task named for the sender check,
   *  a new task's fresh-context fields kept. */
  opts: GatedSubmitOptions;
  /** The pane's agent at the refusal: its name and its session. */
  agentName: string;
  incarnationId: string;
  storedAt: number;
}

export type PendingDropReason = 'replaced' | 'cap' | 'expired' | 'task ended' | 'pane gone' | 'agent changed';

/** A stored delivery's task now: null when that cannot be read. */
export type PendingTaskState = 'open' | 'ended' | 'pane gone' | null;

export interface PendingDeliveryDeps {
  /** The full delivery gate and write. */
  submit: (entry: PendingDelivery) => Promise<GatedSubmitResult>;
  /** The task's state, read from the daemon's task rows. */
  taskState: (entry: PendingDelivery) => Promise<PendingTaskState>;
  /** The pane's agent session now: null when it cannot be read. */
  agentSession: (ptyId: string) => Promise<string | null>;
  log: (line: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
}

const defaultTimer = (fn: () => void, ms: number): { cancel: () => void } => {
  const t = setInterval(fn, ms);
  t.unref?.();
  return { cancel: () => clearInterval(t) };
};

export class PendingDeliveries {
  /** Oldest first. */
  private entries: PendingDelivery[] = [];
  private readonly busy = new Set<string>();
  private timer: { cancel: () => void } | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: PendingDeliveryDeps) {
    this.now = deps.now ?? Date.now;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Keep `entry`; a stored delivery for the same task is replaced. */
  store(entry: PendingDelivery): void {
    const prior = this.entries.find((e) => e.taskId === entry.taskId);
    if (prior) this.drop(prior, 'replaced');
    this.entries.push(entry);
    const ofPane = this.entries.filter((e) => e.ptyId === entry.ptyId);
    if (ofPane.length > PENDING_PER_PANE_CAP) this.drop(ofPane[0], 'cap');
    if (this.entries.length > PENDING_TOTAL_CAP) this.drop(this.entries[0], 'cap');
    this.deps.log(`[delivery] stored task ${JSON.stringify(entry.taskId)} for pane ${JSON.stringify(entry.ptyId)}; it is typed when the pane can take it`);
    this.timer ??= (this.deps.setTimer ?? defaultTimer)(() => void this.sweep(), PENDING_SWEEP_MS);
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
        this.drop(entry, 'pane gone');
        return;
      }
      if (state === 'ended' && this.now() - entry.storedAt >= PENDING_TASK_ROW_GRACE_MS) {
        this.drop(entry, 'task ended');
        return;
      }
      if (state !== 'open') return;
      const session = await this.deps.agentSession(ptyId).catch(() => null);
      if (session === null) return;
      if (session !== entry.incarnationId) {
        this.drop(entry, 'agent changed');
        return;
      }
      const result = await this.deps.submit(entry).catch((err: unknown): GatedSubmitResult => ({
        ok: false,
        reason: 'write_failed',
        detail: `delivery: ${err instanceof Error ? err.message : String(err)}`,
      }));
      // Replaced or dropped while the write ran: that is the newer state.
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

  private drop(entry: PendingDelivery, reason: PendingDropReason): void {
    this.remove(entry);
    if (reason === 'replaced') return;
    this.deps.log(`[delivery] dropped stored task ${JSON.stringify(entry.taskId)} for pane ${JSON.stringify(entry.ptyId)}: ${reason}; the task stays readable with a2a_task_query`);
  }

  private remove(entry: PendingDelivery): void {
    this.entries = this.entries.filter((e) => e !== entry);
    if (this.entries.length === 0 && this.timer) {
      this.timer.cancel();
      this.timer = null;
    }
  }
}
