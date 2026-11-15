import { A2A_REMOTE_HOLD_TTL_MS, type A2aRemoteTaskState } from '../../shared/a2aRemoteDelivery';
import { TERMINAL_STATES, type Task } from '../../shared/types';
import type { A2aTaskService } from '../a2a/A2aTaskService';
import type { LinkStore } from './linkStore';
import type { OutboxStore } from './outboxStore';
import { sendHeldNotice, syncRemoteTask } from './outbound';

/**
 * Cross-host A2A: ending remote work that cannot be delivered.
 *
 *   rejectHeld        — a person rejected a held task (or its hold expired):
 *                       our copy ends and the peer is told.
 *   expireHeld        — the 24 h hold TTL. A task whose own first message was
 *                       never delivered ends, as rejectHeld(…, 'held-expired').
 *                       A held reply or state is dropped on its own; the task
 *                       stays open on both sides.
 *   sendHeldNotices   — tells the PC that sent a dropped reply, once, if it
 *                       takes a notice (`held-notice.1`).
 *   undoDroppedReopens — a task its remote sender reopened goes back to
 *                       `completed` once the message that reopened it was
 *                       dropped (its hold expired) and its notice settled,
 *                       and the sender is told.
 *   failTasksForLink  — the link was revoked or broke: every open remote task
 *                       on it fails (a reopen whose message never got here is
 *                       undone instead), and what the outbox still owes the
 *                       peer for those tasks is dropped. (The `link` notice
 *                       itself is the transport's job.)
 *
 * The person-approved RETRY of a hold needs the renderer (a new pty snapshot),
 * so it lives in main's RemoteA2aBridge.retryHeld.
 */

export interface HeldDeps {
  taskService: Pick<A2aTaskService, 'getTask' | 'cancelTask' | 'forceFailRemote' | 'listRemoteHeld' | 'listRemoteByLink' | 'listRemotePending' | 'listRemote' | 'markRemote' | 'undoReopen'>;
  linkStore: Pick<LinkStore, 'get' | 'list' | 'checkMessage'>;
  outbox: Pick<OutboxStore, 'enqueue' | 'pending' | 'refuse'>;
  now?: () => number;
  /** A link a remote start made (outbound.ts redacts what goes out on it). */
  spawnLink?: (linkId: string) => boolean;
  /**
   * Whether `hostId` takes a host's notice (`held-notice.1`), from its live
   * connection. Undefined: not connected now, so not known yet.
   */
  takesNotice?: (hostId: string) => boolean | undefined;
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

/**
 * Every hold older than `ttlMs`. A task whose own first message is held (it
 * was never delivered) ends, as before. A held reply or state is dropped on
 * its own and the task stays open: a later message on the task may well have
 * been delivered, and one message's hold says nothing about the thread.
 * Returns what was dropped: task ids, and `taskId#messageId` for a unit.
 */
export async function expireHeld(deps: HeldDeps, ttlMs = A2A_REMOTE_HOLD_TTL_MS): Promise<string[]> {
  const now = (deps.now ?? Date.now)();
  const expired: string[] = [];
  const past = (at: string | undefined): boolean => {
    const t = at ? Date.parse(at) : NaN;
    return !Number.isNaN(t) && now - t > ttlMs;
  };
  for (const task of deps.taskService.listRemoteHeld()) {
    const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
    if (!marker) continue;
    if (marker.held && past(marker.heldAt)) {
      // eslint-disable-next-line no-await-in-loop -- one task at a time keeps the log order readable
      const res = await rejectHeld(deps, task.id, 'held-expired');
      if (res.ok) expired.push(task.id);
      continue;
    }
    for (const item of marker.inbox ?? []) {
      if (!item.held || !past(item.heldAt)) continue;
      // eslint-disable-next-line no-await-in-loop -- one unit at a time, in the task's order
      const res = await deps.taskService.markRemote({ taskId: task.id, messageId: item.messageId, rejected: 'held-expired' });
      if (res.ok) expired.push(`${task.id}#${item.messageId}`);
    }
  }
  return expired;
}

/**
 * A task its remote sender reopened, whose reopening message was dropped when its hold expired, goes back to
 * `completed` (A2aTaskService.undoReopen holds the rules), and the sender is told. Only once every notice on the
 * task is settled (sent, or not to be sent): a notice goes to the sender before the state, and a task already ended
 * would send none. Returns the task ids undone.
 */
export async function undoDroppedReopens(deps: HeldDeps): Promise<string[]> {
  const undone: string[] = [];
  for (const task of deps.taskService.listRemote()) {
    const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
    const by = marker?.reopenedBy?.messageId;
    // Not while a notice on the task is still owed: a task that ended sends none.
    if (!by || (marker?.inbox ?? []).some((i) => i.rejected?.notice === 'pending')) continue;
    // eslint-disable-next-line no-await-in-loop -- per-task lock order
    const res = await deps.taskService.undoReopen({ taskId: task.id, messageId: by, reason: 'held-expired' });
    if (!res.ok || !res.undone) continue;
    undone.push(task.id);
    // eslint-disable-next-line no-await-in-loop -- one task at a time
    await syncRemoteTask(deps, task.id);
  }
  return undone;
}

/**
 * The notice for each dropped reply still `pending`, at most once: sent to a
 * peer connected now that takes it, marked `not-sent` for one that does not
 * (or for a state, or a task that ended), left pending while the peer is away.
 * The notice's id is derived from the message's, so a crash between queueing
 * and marking queues the same message again, which the peer takes once.
 */
export async function sendHeldNotices(deps: HeldDeps): Promise<number> {
  let sent = 0;
  for (const task of deps.taskService.listRemote()) {
    const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
    for (const item of marker?.inbox ?? []) {
      if (item.rejected?.notice !== 'pending') continue;
      const ended = (TERMINAL_STATES as readonly string[]).includes(task.status.state);
      const takes = item.kind === 'reply' && !ended ? deps.takesNotice?.(marker!.hostId) : false;
      if (takes === undefined) continue;
      if (takes) {
        const res = sendHeldNotice(deps, {
          taskId: task.id,
          messageId: item.messageId,
          at: item.rejected.at,
          ...(item.rejected.held === 'delivery-unconfirmed' ? { unconfirmed: true } : {}),
        });
        if (!res.ok) continue;
        sent += 1;
      }
      // eslint-disable-next-line no-await-in-loop -- one mark at a time
      await deps.taskService.markRemote({ taskId: task.id, messageId: item.messageId, notice: takes ? 'sent' : 'not-sent' });
    }
  }
  return sent;
}

/**
 * The link ended: fail every open remote task on it and refuse what the
 * outbox still owes the peer for this link (task / reply / state envelopes —
 * a `link` notice is left for the transport to deliver). A report the peer
 * made stays as it is (forceFailRemote): the peer finished that task.
 */
export async function failTasksForLink(
  deps: HeldDeps,
  linkId: string,
  reason: 'link_revoked' | 'link_broken',
): Promise<{ failed: string[]; refused: number }> {
  const failed: string[] = [];
  for (const task of deps.taskService.listRemoteByLink(linkId)) {
    // Reopened by its sender for a message that never reached the agent: completed again, here only (the link is
    // gone, so the sender's copy stays as it was).
    const reopenedBy = (task.metadata.remote as A2aRemoteTaskState | undefined)?.reopenedBy?.messageId;
    if (reopenedBy) {
      // eslint-disable-next-line no-await-in-loop -- per-task lock order
      const undo = await deps.taskService.undoReopen({ taskId: task.id, messageId: reopenedBy, reason: 'link-ended' });
      if (undo.ok && undo.undone) continue;
    }
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
