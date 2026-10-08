import {
  A2A_BRAIN_ALIAS,
  A2A_REMOTE_BODY_MAX,
  A2A_REMOTE_MESSAGE_ID_RE,
  A2A_REMOTE_PROTOCOL,
  isA2aRemoteMessageKind,
  type A2aLinkRecordV1,
  type A2aRemoteDeliverResponse,
  type A2aRemoteEnvelope,
  type A2aRemoteReceipt,
  type A2aRemoteErrorCode,
  type A2aRemoteTaskMarkerV1,
  type HostId,
} from '../../shared/a2aRemote';
import { A2A_REMOTE_INBOUND_EVENT, remoteWorkspaceId, sanitizeRemoteText, type A2aRemoteInboundEvent } from '../../shared/a2aRemoteDelivery';
import { isTaskState, type Message } from '../../shared/types';
import type { A2aTaskService } from '../a2a/A2aTaskService';
import { remoteTaskId } from './ids';
import type { BrokenReason, LinkStore } from './linkStore';
import { isPlainObject, isSafeId } from './storeFile';

/**
 * Cross-host A2A, receiving side: apply one envelope an authenticated peer
 * sent. The sender's workspace/pane is never read off the wire — it is the
 * link's remote pane, represented in the ledger as workspace `remote:<linkId>`.
 *
 *   task  → a new inbound ledger task under `remoteTaskId(linkId, messageId)`,
 *           pinned to the link's local pane, not yet delivered; then the
 *           `a2a.remote.inbound` broadcast so main delivers it.
 *   reply → appended to that task's history.
 *   state → applied as `remote:<linkId>` under the ordinary authz rules.
 *   link  → the matching link-store transition.
 *
 * The same (linkId, messageId) with the same payload answers `duplicate: true`;
 * with a different payload, `conflict`.
 */

export interface InboundDeps {
  linkStore: Pick<LinkStore, 'get' | 'checkMessage' | 'applyRemoteAccept' | 'revoke' | 'markBroken'>;
  taskService: Pick<A2aTaskService, 'getTask' | 'createTask' | 'appendRemoteMessage' | 'applyRemoteState' | 'markRemote'>;
  broadcast: (event: A2aRemoteInboundEvent) => void;
  /** Display alias of a link's remote pane (`linkAlias`). */
  aliasFor: (link: A2aLinkRecordV1) => string;
  /** Display name of a local workspace, when the daemon knows it. */
  localWorkspaceName?: (workspaceId: string) => string | undefined;
}

const BROKEN: ReadonlySet<string> = new Set(['pane-closed', 'pane-moved', 'workspace-gone', 'exposure-revoked']);

export async function acceptInbound(
  raw: unknown,
  peer: { hostId: HostId },
  deps: InboundDeps,
): Promise<A2aRemoteDeliverResponse> {
  const parsed = parseEnvelope(raw);
  if ('error' in parsed) return fail(parsed.error);
  // Peer text is pasted into a terminal later: control characters and escape
  // sequences go here, before anything is stored (and again before the write).
  const env: A2aRemoteEnvelope =
    typeof parsed.envelope.text === 'string' ? { ...parsed.envelope, text: sanitizeRemoteText(parsed.envelope.text) } : parsed.envelope;
  if ((env.kind === 'task' || env.kind === 'reply') && !env.text) return fail('bad-request');

  if (env.kind === 'link') return applyLinkNotice(env, peer.hostId, deps);

  let onThisLink = false;
  if (env.kind === 'reply' || env.kind === 'state' || env.kind === 'receipt') {
    const marker = deps.taskService.getTask(env.taskId as string)?.metadata.remote as A2aRemoteTaskMarkerV1 | undefined;
    onThisLink = marker?.v === 1 && marker.linkId === env.linkId;
  }
  const check = deps.linkStore.checkMessage(env.linkId, env.linkVersion, peer.hostId, 'inbound', env.kind, undefined, { onThisLink });
  if (!check.ok) return fail(check.error);
  const link = check.link;
  const remoteWs = remoteWorkspaceId(link.linkId);

  if (env.kind === 'task') {
    const taskId = remoteTaskId(link.linkId, env.messageId);
    const text = env.text as string;
    const created = await deps.taskService.createTask(
      {
        id: taskId,
        title: text.split('\n', 1)[0].slice(0, 100),
        from: { workspaceId: remoteWs, name: deps.aliasFor(link) },
        // A brain end is this PC's Moa: its HQ workspace, no pane.
        to: link.local.kind === 'brain'
          ? { workspaceId: link.local.workspaceId, name: A2A_BRAIN_ALIAS }
          : {
            workspaceId: link.local.workspaceId,
            name: deps.localWorkspaceName?.(link.local.workspaceId) ?? link.local.workspaceId,
            paneId: link.local.paneId,
          },
        history: [textMessage(env.messageId, 'user', text)],
        remote: { v: 1, linkId: link.linkId, hostId: peer.hostId, messageId: env.messageId, direction: 'inbound', delivered: false, kind: link.local.kind },
      },
      { conflictOnBodyMismatch: true },
    );
    if (!created.ok) return fail('conflict' in created ? 'conflict' : 'unavailable', created.error);
    if (created.existed) return { ok: true, taskId, duplicate: true };
    deps.broadcast({ type: A2A_REMOTE_INBOUND_EVENT, taskId });
    return { ok: true, taskId, duplicate: false };
  }

  const taskId = env.taskId as string;
  if (env.kind === 'receipt') {
    // The peer got (or read) a task WE sent it: bookkeeping only, never a state.
    const marker = deps.taskService.getTask(taskId)?.metadata.remote as A2aRemoteTaskMarkerV1 | undefined;
    if (marker?.direction !== 'outbound') return fail('forbidden', 'a receipt is only for a task this host sent');
    const res = await deps.taskService.markRemote({ taskId, remoteReceipt: env.receipt as A2aRemoteReceipt });
    if (!res.ok) return fail('unavailable', res.error);
    return { ok: true, taskId, duplicate: false };
  }
  if (env.kind === 'reply') {
    const task = deps.taskService.getTask(taskId);
    // The peer is the sender of an inbound task and the receiver of an outbound one.
    const role: Message['role'] = task?.metadata.from.workspaceId === remoteWs ? 'user' : 'agent';
    const res = await deps.taskService.appendRemoteMessage({
      taskId,
      linkId: link.linkId,
      actorWorkspaceId: remoteWs,
      message: textMessage(env.messageId, role, env.text as string),
    });
    if (!res.ok) return fail('conflict' in res ? 'conflict' : 'unavailable', res.error);
    return { ok: true, taskId, duplicate: res.duplicate };
  }

  const res = await deps.taskService.applyRemoteState({
    taskId,
    linkId: link.linkId,
    messageId: env.messageId,
    to: env.state as NonNullable<A2aRemoteEnvelope['state']>,
    ...(env.text ? { summary: env.text } : {}),
  });
  if (!res.ok) return fail(stateErrorCode(res), res.error);
  return { ok: true, taskId, duplicate: res.duplicate };
}

/** Link lifecycle notice. A notice the link already reflects is a duplicate. */
function applyLinkNotice(env: A2aRemoteEnvelope, hostId: HostId, deps: InboundDeps): A2aRemoteDeliverResponse {
  const notice = env.link;
  const rec = deps.linkStore.get(env.linkId);
  if (notice && rec && rec.remote.hostId === hostId && alreadyApplied(rec, notice)) return { ok: true, duplicate: true };
  const check = deps.linkStore.checkMessage(env.linkId, env.linkVersion, hostId, 'inbound', 'link', notice);
  if (!check.ok) return fail(check.error);
  const n = notice as NonNullable<A2aRemoteEnvelope['link']>;
  try {
    if (n.state === 'active') deps.linkStore.applyRemoteAccept(env.linkId, n.version);
    else if (n.state === 'revoked') deps.linkStore.revoke(env.linkId, 'remote');
    else {
      if (!n.reason || !BROKEN.has(n.reason)) return fail('bad-request', 'broken notice needs a broken reason');
      deps.linkStore.markBroken(env.linkId, n.reason as BrokenReason, n.version);
    }
  } catch (err) {
    // A failed write: the peer retries, and a transition that did land in
    // memory then answers as a duplicate.
    return fail('unavailable', err instanceof Error ? err.message : String(err));
  }
  return { ok: true, duplicate: false };
}

function alreadyApplied(rec: A2aLinkRecordV1, notice: NonNullable<A2aRemoteEnvelope['link']>): boolean {
  if (notice.state === 'revoked') return rec.state === 'revoked';
  return rec.state === notice.state && rec.version === notice.version;
}

function stateErrorCode(res: { error: string; conflict?: true }): A2aRemoteErrorCode {
  if (res.conflict) return 'conflict';
  if (res.error.includes('append failed')) return 'unavailable';
  if (res.error.includes('only the receiver') || res.error.includes('not a party')) return 'forbidden';
  if (res.error.includes('no task')) return 'unknown-task';
  return 'bad-request';
}

type Parsed = { envelope: A2aRemoteEnvelope } | { error: A2aRemoteErrorCode };

/** Shape and size checks before anything touches the link store or the ledger. */
function parseEnvelope(raw: unknown): Parsed {
  if (!isPlainObject(raw)) return { error: 'bad-request' };
  if (raw['protocol'] !== A2A_REMOTE_PROTOCOL) return { error: 'protocol' };
  const { linkId, linkVersion, messageId, kind, taskId, text, state, link, sentAt } = raw;
  if (!isSafeId(linkId) || typeof messageId !== 'string' || !A2A_REMOTE_MESSAGE_ID_RE.test(messageId) || typeof sentAt !== 'string') return { error: 'bad-request' };
  if (typeof linkVersion !== 'number' || !Number.isInteger(linkVersion)) return { error: 'bad-request' };
  if (!isA2aRemoteMessageKind(kind)) return { error: 'bad-request' };
  if (text !== undefined && typeof text !== 'string') return { error: 'bad-request' };
  if (typeof text === 'string' && Buffer.byteLength(text, 'utf8') > A2A_REMOTE_BODY_MAX) return { error: 'too-large' };
  switch (kind) {
    case 'task':
      if (typeof text !== 'string' || !text) return { error: 'bad-request' };
      break;
    case 'reply':
      if (!isSafeId(taskId) || typeof text !== 'string' || !text) return { error: 'bad-request' };
      break;
    case 'state':
      if (!isSafeId(taskId) || !isTaskState(state)) return { error: 'bad-request' };
      break;
    case 'link':
      if (!isPlainObject(link) || typeof link['state'] !== 'string' || typeof link['version'] !== 'number') return { error: 'bad-request' };
      break;
    case 'receipt':
      if (!isSafeId(taskId) || (raw['receipt'] !== 'delivered' && raw['receipt'] !== 'read')) return { error: 'bad-request' };
      break;
  }
  return { envelope: raw as unknown as A2aRemoteEnvelope };
}

function textMessage(messageId: string, role: Message['role'], text: string): Message {
  return { kind: 'message', messageId, role, parts: [{ kind: 'text', text }] };
}

function fail(error: A2aRemoteErrorCode, message?: string): A2aRemoteDeliverResponse {
  return { ok: false, error, ...(message ? { message } : {}) };
}
