// What a headless start's worker is doing on each task, sent to the PC that
// asked (`kind: 'status'`, behind `A2A_FEATURE_STATUS`). The delivery
// (headlessDelivery.ts) says what it sees each pass; this decides what goes:
//   - one status per change, at least STATUS_FLOOR_MS apart; `gone` and
//     `usage-limit` go at once;
//   - at most STATUS_CHANGES_MAX changes per task, then only `gone` and
//     `usage-limit` (the task's own states still reach the asker);
//   - only while the asking PC is connected and takes a status: nothing is
//     queued for a PC that is away, and the current status goes once when its
//     link comes back;
//   - never for a task that ended (the outbound side refuses it too).
// A status is never a reply and never a state change.

import type { A2aRemoteStatusV1 } from '../../shared/a2aRemote';
import type { HeadlessTaskStatus } from './headlessDelivery';

export const STATUS_FLOOR_MS = 5000;
export const STATUS_CHANGES_MAX = 120;

/** Whether a menu's labels go to the asking PC, or only how many there are. */
export type StatusLabels = 'send' | 'keep';

export interface HeadlessStatusDeps {
  /** The PC that sent the task: connected now, takes a status, and its link's epoch (new after each reconnect). */
  peer(taskId: string): { connected: boolean; takesStatus: boolean; epoch: string | null } | null;
  /** Queue one status for that PC (`A2aRemoteDelivery.sendStatus`). */
  send(taskId: string, status: A2aRemoteStatusV1): { ok: true } | { ok: false; error: string };
  labels(): StatusLabels;
  log(level: 'info' | 'warn', msg: string): void;
  now?: () => number;
}

interface Current {
  status: A2aRemoteStatusV1;
  /** The status without its `since`: what makes it a change. */
  key: string;
}

interface Tracked {
  current: Current | null;
  sent: { key: string; since: string; at: number; epoch: string | null } | null;
  changes: number;
  capped: boolean;
}

export class HeadlessStatusReporter {
  private readonly deps: HeadlessStatusDeps;
  private readonly now: () => number;
  private readonly tasks = new Map<string, Tracked>();

  constructor(deps: HeadlessStatusDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** One delivery pass: every task it works on. A task no longer in it is forgotten. */
  tick(statuses: readonly HeadlessTaskStatus[]): void {
    const seen = new Set<string>();
    for (const s of statuses) {
      seen.add(s.taskId);
      const t = this.tracked(s.taskId);
      if (s.kind !== null) this.observe(t, s);
      this.flush(s.taskId, t);
    }
    for (const taskId of [...this.tasks.keys()]) if (!seen.has(taskId)) this.tasks.delete(taskId);
  }

  /** The agent of these tasks is no longer running: said at once, before their tasks end. */
  gone(taskIds: readonly string[]): void {
    for (const taskId of taskIds) {
      const t = this.tracked(taskId);
      this.observe(t, { taskId, kind: 'gone' });
      this.flush(taskId, t);
      this.tasks.delete(taskId);
    }
  }

  private tracked(taskId: string): Tracked {
    let t = this.tasks.get(taskId);
    if (!t) {
      t = { current: null, sent: null, changes: 0, capped: false };
      this.tasks.set(taskId, t);
    }
    return t;
  }

  /** A new status starts its own `since`; the same one seen again keeps it. */
  private observe(t: Tracked, s: HeadlessTaskStatus): void {
    if (s.kind === null) return;
    const detail: NonNullable<A2aRemoteStatusV1['detail']> = { ...s.detail };
    if (detail.options && this.deps.labels() === 'keep') {
      detail.optionCount = detail.options.length;
      delete detail.options;
    }
    const body = { kind: s.kind, ...(Object.keys(detail).length > 0 ? { detail } : {}) };
    const key = JSON.stringify(body);
    if (t.current?.key === key) return;
    t.current = { key, status: { ...body, since: new Date(this.now()).toISOString() } };
  }

  private flush(taskId: string, t: Tracked): void {
    const current = t.current;
    if (!current) return;
    const peer = this.deps.peer(taskId);
    // Nothing is queued for a PC that is away, or that would refuse the kind.
    if (!peer?.connected || !peer.takesStatus) return;
    const changed = !t.sent || t.sent.key !== current.key || t.sent.since !== current.status.since;
    const reconnected = t.sent !== null && t.sent.epoch !== peer.epoch;
    if (!changed && !reconnected) return;
    const now = this.now();
    const urgent = current.status.kind === 'gone' || current.status.kind === 'usage-limit';
    if (changed && !urgent) {
      // Held until the floor passed: the newest status then goes, not each one in between.
      if (t.sent && now - t.sent.at < STATUS_FLOOR_MS) return;
      if (t.changes >= STATUS_CHANGES_MAX) {
        if (!t.capped) {
          t.capped = true;
          this.deps.log('info', `[headless] task ${taskId}: ${STATUS_CHANGES_MAX} status changes sent; only gone and usage-limit go from now on`);
        }
        return;
      }
    }
    const res = this.deps.send(taskId, current.status);
    if (!res.ok) {
      if (res.error !== 'ended') this.deps.log('warn', `[headless] task ${taskId}: its status could not be sent: ${res.error}`);
      return;
    }
    if (changed) t.changes += 1;
    t.sent = { key: current.key, since: current.status.since, at: now, epoch: peer.epoch };
  }
}
