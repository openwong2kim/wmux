import { A2A_REMOTE_HOLD_TTL_MS, type A2aRemoteTaskState } from '../../shared/a2aRemoteDelivery';
import type { Task } from '../../shared/types';
import type { A2aTaskService } from '../a2a/A2aTaskService';
import type { LinkStore } from './linkStore';
import type { OutboxStore } from './outboxStore';
import { syncRemoteTask } from './outbound';

/**
 * Cross-host A2A: ending remote work that cannot be delivered.
 *
 *   rejectHeld        — a person rejected a held task (or its hold expired):
 *                       our copy ends and the peer is told.
 *   expireHeld        — the 24 h hold TTL, as rejectHeld(…, 'held-expired').
 *   failTasksForLink  — the link was revoked or broke: every open remote task
 *                       on it fails, and what the outbox still owes the peer
 *                       for those tasks is dropped. (The `link` notice itself
 *                       is the transport's job.)
 *
 * The person-approved RETRY of a hold needs the renderer (a new pty snapshot),
 * so it lives in main's RemoteA2aBridge.retryHeld.
 */

export interface HeldDeps {
  taskService: Pick<A2aTaskService, 'getTask' | 'cancelTask' | 'forceFailRemote' | 'listRemoteHeld' | 'listRemoteByLink' | 'listRemotePending' | 'markRemote'>;
  linkStore: Pick<LinkStore, 'get' | 'list' | 'checkMessage'>;
  outbox: Pick<OutboxStore, 'enqueue' | 'pending' | 'refuse'>;
  now?: () => number;
}

export type RejectHeldResult =
  | { ok: true; taskId: string; state: 'failed' | 'canceled'; queued: boolean }
  | { ok: false; error: string };

/**
 * End a held remote task here and queue the matching state for the peer.
 *   - inbound (the peer sent it): `failed` with the reason — we are the
 *     receiver, and the peer's ledger takes a receiver's failure from any open
 *     state (A2aTaskService.applyRemoteState).
 *   - outbound (a reply to our task could not reach our pane): `canceled` — we
 *     are the sender, and a sender may only cancel on the peer's ledger.
 * Nothing is queued when the link is no longer active; the local end stands.
 */
export async function rejectHeld(deps: HeldDeps, taskId: string, reason: string): Promise<RejectHeldResult> {
  const task = deps.taskService.getTask(taskId);
  const marker = task?.metadata.remote as A2aRemoteTaskState | undefined;
  if (!task || !marker || marker.v !== 1) return { ok: false, error: 'unknown-task' };
  if (!isHeld(marker)) return { ok: false, error: 'not-held' };
  const summary = `rejected on the receiving host: ${reason}`;
  let state: 'failed' | 'canceled';
  if (marker.direction === 'inbound') {
    const res = await deps.taskService.forceFailRemote({ taskId, reason: summary, forced: 'remote_held_rejected' });
    if (!res.ok) return res;
    state = 'failed';
  } else {
    const res = await deps.taskService.cancelTask({ taskId, callerWorkspaceId: task.metadata.from.workspaceId });
    if (!res.ok) return res;
    state = 'canceled';
  }
  const queued = await syncRemoteTask(deps, taskId, { summary });
  return { ok: true, taskId, state, queued: queued.ok };
}

/** Reject every hold older than `ttlMs`. Returns the ids rejected. */
export async function expireHeld(deps: HeldDeps, ttlMs = A2A_REMOTE_HOLD_TTL_MS): Promise<string[]> {
  const now = (deps.now ?? Date.now)();
  const expired: string[] = [];
  for (const task of deps.taskService.listRemoteHeld()) {
    const since = oldestHold(task);
    if (since === null || now - since <= ttlMs) continue;
    // eslint-disable-next-line no-await-in-loop -- one task at a time keeps the log order readable
    const res = await rejectHeld(deps, task.id, 'held-expired');
    if (res.ok) expired.push(task.id);
  }
  return expired;
}

/**
 * The link ended: fail every open remote task on it and refuse what the
 * outbox still owes the peer for this link (task / reply / state envelopes —
 * a `link` notice is left for the transport to deliver).
 */
export async function failTasksForLink(
  deps: HeldDeps,
  linkId: string,
  reason: 'link_revoked' | 'link_broken',
): Promise<{ failed: string[]; refused: number }> {
  const failed: string[] = [];
  for (const task of deps.taskService.listRemoteByLink(linkId)) {
    // eslint-disable-next-line no-await-in-loop -- per-task lock order
    const res = await deps.taskService.forceFailRemote({ taskId: task.id, reason, forced: 'remote_link_ended' });
    if (res.ok && res.failed) failed.push(task.id);
  }
  // Nothing more is delivered on an ended link: what the peer sent and our
  // pane never got is held (link-not-active), never pasted later.
  for (const task of deps.taskService.listRemotePending()) {
    const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
    if (marker?.linkId !== linkId) continue;
    const units = [
      ...(marker.direction === 'inbound' && marker.delivered !== true && !marker.held ? [undefined] : []),
      ...(marker.inbox ?? []).filter((i) => i.delivered !== true && !i.held).map((i) => i.messageId),
    ];
    for (const messageId of units) {
      // eslint-disable-next-line no-await-in-loop -- per-task lock order
      await deps.taskService.markRemote({ taskId: task.id, ...(messageId ? { messageId } : {}), held: 'link-not-active' });
    }
  }
  let refused = 0;
  const link = deps.linkStore.get(linkId);
  if (link) {
    for (const rec of deps.outbox.pending(link.remote.hostId)) {
      if (rec.envelope.linkId !== linkId || rec.envelope.kind === 'link') continue;
      deps.outbox.refuse(link.remote.hostId, rec.seq, 'link-not-active');
      refused += 1;
    }
  }
  return { failed, refused };
}

function isHeld(marker: A2aRemoteTaskState): boolean {
  return !!marker.held || (marker.inbox ?? []).some((i) => !!i.held);
}

function oldestHold(task: Task): number | null {
  const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
  if (!marker) return null;
  const stamps = [marker.held ? marker.heldAt : undefined, ...(marker.inbox ?? []).map((i) => (i.held ? i.heldAt : undefined))]
    .filter((v): v is string => typeof v === 'string')
    .map((v) => Date.parse(v))
    .filter((v) => !Number.isNaN(v));
  return stamps.length ? Math.min(...stamps) : null;
}
