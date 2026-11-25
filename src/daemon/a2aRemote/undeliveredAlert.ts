import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import { A2A_REMOTE_RECORD_V, REMOTE_UNDELIVERED_ALERT_MS, remoteUndeliveredText, type HostId } from '../../shared/a2aRemote';
import { A2A_REMOTE_HOLD_TTL_MS, localSideOf, type A2aRemoteTaskState } from '../../shared/a2aRemoteDelivery';
import type { Task } from '../../shared/types';
import { loadStore, type StoreLog } from './storeFile';

/**
 * Cross-host A2A, sending side: a task sent to another PC that has no
 * `delivered` receipt REMOTE_UNDELIVERED_ALERT_MS after it was made is told to
 * the sender once, with the link's state. Before this the send answered
 * `queued` and nothing more was said: a PC that never got the task, or never
 * handed it to its agent, looked the same as one still working on it.
 *
 * A task counts as arrived (no alert) once the other PC moved it, replied on
 * it, sent a worker status for it, or sent any receipt. Only an open task, at
 * most A2A_REMOTE_HOLD_TTL_MS old, is alerted: an older one would have been
 * dropped there anyway, and this keeps the first run after an upgrade from
 * naming tasks long forgotten.
 *
 * "Once" holds across restarts: the alerted task ids are kept in
 * UNDELIVERED_ALERTS_FILE until their task ends or goes.
 */

export const UNDELIVERED_ALERTS_FILE = 'a2a-undelivered-alerts.json';

/** What the sending PC knows about one task's way to the other PC. */
export interface UndeliveredContext {
  /** The other PC acknowledged the task's own envelope (or made it there: a remote start's first task). */
  received(task: Task, marker: A2aRemoteTaskState): boolean;
  /** The link's state now ('active', 'broken', …), or 'unknown' when it is gone. */
  linkState(linkId: string): string;
  connected(hostId: HostId): boolean;
  /** A worker status came for it (in memory only). */
  hasStatus(taskId: string): boolean;
  hostName(hostId: HostId): string | undefined;
}

export interface UndeliveredAlert {
  taskId: string;
  hostId: HostId;
  /** The sending pane, when the task names it. */
  ptyId?: string;
  text: string;
}

/** The open tasks this PC sent that are due an alert now and have not had one. Pure. */
export function dueUndeliveredAlerts(tasks: readonly Task[], alerted: ReadonlySet<string>, ctx: UndeliveredContext, now: number): UndeliveredAlert[] {
  const out: UndeliveredAlert[] = [];
  for (const task of tasks) {
    const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
    if (marker?.direction !== 'outbound' || alerted.has(task.id)) continue;
    // Moved, answered, receipted or reported on by the other PC: it is there.
    if (task.status.state !== 'submitted' || marker.remoteDeliveredAt || task.history.some((m) => m.role === 'agent') || ctx.hasStatus(task.id)) continue;
    const age = now - Date.parse(task.metadata.createdAt);
    if (!(age >= REMOTE_UNDELIVERED_ALERT_MS) || age > A2A_REMOTE_HOLD_TTL_MS) continue;
    const ptyId = task.metadata[localSideOf(task)].ptyId;
    out.push({
      taskId: task.id,
      hostId: marker.hostId,
      ...(ptyId ? { ptyId } : {}),
      text: remoteUndeliveredText({
        pc: ctx.hostName(marker.hostId),
        seconds: Math.round(age / 1000),
        received: ctx.received(task, marker),
        link: ctx.linkState(marker.linkId),
        connected: ctx.connected(marker.hostId),
      }),
    });
  }
  return out;
}

interface AlertsFileV1 { v: 1; taskIds: string[] }

function coerce(raw: unknown): AlertsFileV1 | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const ids = r['taskIds'];
  if (r['v'] !== A2A_REMOTE_RECORD_V || !Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id.length <= 200)) return null;
  return { v: 1, taskIds: ids as string[] };
}

/** The task ids already alerted. A file that cannot be written keeps the set in memory (once per run, then). */
export class UndeliveredAlertStore {
  readonly filePath: string;
  private readonly ids: Set<string>;
  private readonly writable: boolean;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  /** The set differs from the file (a write failed): written again on the next update, alerting nothing again. */
  private dirty = false;

  constructor(opts: { dir: string; log?: StoreLog; now?: () => number; write?: (filePath: string, data: unknown) => void }) {
    this.filePath = path.join(opts.dir, UNDELIVERED_ALERTS_FILE);
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    const loaded = loadStore({
      filePath: this.filePath,
      fileName: UNDELIVERED_ALERTS_FILE,
      coerce,
      now: opts.now ?? Date.now,
      log: this.log,
      level: 'warn',
      emptyMeans: 'a task without a delivered receipt may be alerted once more',
    });
    this.writable = loaded.writable;
    this.ids = new Set(loaded.value?.taskIds ?? []);
  }

  get alerted(): ReadonlySet<string> {
    return this.ids;
  }

  /** Record `taskIds` as alerted, and forget ids no longer in `open` (their task ended or went). */
  update(taskIds: readonly string[], open: ReadonlySet<string>): void {
    let changed = false;
    for (const id of [...this.ids]) {
      if (!open.has(id)) { this.ids.delete(id); changed = true; }
    }
    for (const id of taskIds) {
      if (!this.ids.has(id)) { this.ids.add(id); changed = true; }
    }
    if ((!changed && !this.dirty) || !this.writable) return;
    try {
      this.write(this.filePath, { v: 1, taskIds: [...this.ids] } satisfies AlertsFileV1);
      this.dirty = false;
      scheduleTokenFileReHarden(this.filePath);
    } catch (err) {
      this.dirty = true;
      this.log('warn', `[a2a-remote] ${UNDELIVERED_ALERTS_FILE}: not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
