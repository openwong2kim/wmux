import { pathToFileURL } from 'node:url';
import {
  A2A_BRAIN_ALIAS,
  A2A_REMOTE_BODY_MAX,
  parseA2aRemoteImageRefs,
  parseA2aRemoteNotice,
  parseA2aRemoteStatus,
  type A2aRemoteImageRef,
  A2A_REMOTE_MESSAGE_ID_RE,
  A2A_REMOTE_PROTOCOL,
  isA2aRemoteMessageKind,
  type A2aLinkRecordV1,
  type A2aRemoteDeliverResponse,
  type A2aRemoteEnvelope,
  type A2aRemoteReceipt,
  type A2aRemoteStatusV1,
  type A2aRemoteErrorCode,
  type A2aRemoteTaskMarkerV1,
  type HostId,
} from '../../shared/a2aRemote';
import { A2A_REMOTE_INBOUND_EVENT, heldNoticeText, remoteWorkspaceId, sanitizeRemoteMessage, type A2aRemoteInboundEvent, type A2aRemoteTaskState } from '../../shared/a2aRemoteDelivery';
import { normalizeCompletionEvidenceWire } from '../../shared/completionEvidence';
import { isTaskState, TERMINAL_STATES, type CompletionEvidence, type EvidenceItem, type Message, type Part } from '../../shared/types';
import type { A2aImageStore, ImageNotReceived } from './imageStore';
import type { A2aTaskService } from '../a2a/A2aTaskService';
import { remoteTaskId } from './ids';
import type { BrokenReason, LinkStore } from './linkStore';
import { isPlainObject, isSafeId } from './storeFile';
import { isSpawnEnvelope } from './spawnReceiver';
import { heldNoticeMessageId } from './outbound';
import { isContinueEnvelope } from './continueReceiver';
import { isBundleEnvelope } from './bundleBox';

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
 *   link  → the matching link-store transition; a share offer
 *           (`link.state` `offer` / `offer-withdrawn`, linkId = offerId)
 *           goes to the offer handler instead.
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
  /** Share offers (`link.state` `offer` / `offer-withdrawn`); absent, they are an unknown link. */
  offers?: { applyInbound(env: A2aRemoteEnvelope, peer: { hostId: HostId }): A2aRemoteDeliverResponse | Promise<A2aRemoteDeliverResponse> };
  /** Images on task / reply envelopes (`images.1`); absent, refs are ignored and only the text is taken. */
  images?: InboundImages;
  /** Links a remote start made here: no images on them, and (followUps 'ask') new tasks held for their card. */
  spawnLinks?: { isSpawnLink(linkId: string): boolean; holdsFollowUps(linkId: string): boolean };
  /** Remote spawn (`link` states `spawn`, `spawn-result`, `spawn-targets`); absent, they are an unknown link. */
  spawn?: { applyInbound(env: A2aRemoteEnvelope, peer: { hostId: HostId }): A2aRemoteDeliverResponse | Promise<A2aRemoteDeliverResponse> };
  /** Continuing a conversation from another PC (the `link` states `continue*`); absent, they are an unknown link. */
  continue?: { applyInbound(env: A2aRemoteEnvelope, peer: { hostId: HostId }): A2aRemoteDeliverResponse | Promise<A2aRemoteDeliverResponse> };
  /** Bringing back an agent's work as a bundle (the `link` states `bundle-*`, bundleBox.ts); absent, they are an unknown link. */
  bundles?: { applyInbound(env: A2aRemoteEnvelope, peer: { hostId: HostId }): A2aRemoteDeliverResponse | Promise<A2aRemoteDeliverResponse> };
  /**
   * Where a worker's status on a task this PC sent goes (`kind: 'status'`): the newest per task, in memory.
   * Absent, a status is refused as unknown.
   */
  remoteStatus?: {
    /** One more status from this PC may be taken now (a per-peer flood guard); false: dropped quietly. */
    admit?(hostId: HostId): boolean;
    /** A status that passed the checks, from `hostId` (a per-task gap is applied there). */
    note(taskId: string, status: A2aRemoteStatusV1, hostId: HostId): void;
    /** True the first time a task's `gone` is seen (its log line); false after, until the task is forgotten. */
    firstGone?(taskId: string): boolean;
    forget(taskId: string): void;
  };
  /**
   * A host's notice about one of our own messages (`held-notice.1`): how many
   * a link may bring (past it they are taken and dropped, one log line per
   * window), and the one log line for a notice that names no message of ours.
   * Absent: a notice is taken with no limit.
   */
  remoteNotice?: {
    admit(linkId: string): boolean;
    unknownOnce(linkId: string): boolean;
  };
  /** New tasks each PC may send this one (`PeerTaskBudget`); absent, no limit. */
  taskBudget?: PeerTaskBudget;
  /** Where a refusal's detail goes: this PC's log. The peer gets the code alone. */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/**
 * New tasks one PC may send this PC per hour, on any link; resends are not
 * counted. Past it a task is answered `unavailable`: nothing is lost, the
 * sender holds it (and what follows it to this PC) and sends it again later.
 * It counts every link, not only spawn links: each link is one a person
 * accepted, but a peer that floods one should slow down, not cost this PC
 * unbounded work; the limit is far above a person's or an agent's pace.
 */
export const INBOUND_TASKS_PER_HOST_PER_HOUR = 120;
const HOUR_MS = 60 * 60 * 1000;

/** Arrivals of new tasks per PC over the last hour (in memory). */
export class PeerTaskBudget {
  private readonly arrivals = new Map<HostId, number[]>();
  constructor(
    private readonly max = INBOUND_TASKS_PER_HOST_PER_HOUR,
    private readonly now: () => number = Date.now,
  ) {}

  admit(hostId: HostId): boolean {
    const now = this.now();
    const recent = (this.arrivals.get(hostId) ?? []).filter((t) => now - t < HOUR_MS);
    const ok = recent.length < this.max;
    if (ok) recent.push(now);
    this.arrivals.set(hostId, recent);
    return ok;
  }

  /** Take back the arrival `admit` just counted (the task was not stored). */
  unadmit(hostId: HostId): void {
    this.arrivals.get(hostId)?.pop();
  }
}

export interface InboundImages {
  store: Pick<A2aImageStore, 'claim' | 'received' | 'storeReceived'>;
  /** Failed pulls per `${hostId}:${messageId}:${sha256}` (in memory): past PULL_MAX_ATTEMPTS an image counts as not received. */
  pullAttempts: Map<string, number>;
}

/**
 * How an envelope's images reach this PC. Absent: the peer is this PC's
 * JOINER and uploaded them before posting (`claim` them from staging). Set:
 * the peer is the SERVER this PC joined, and the image must be fetched from
 * it. A failure that `permanent` marks will not change on a retry.
 */
export type ImagePull = (ref: A2aRemoteImageRef) => Promise<{ ok: true; bytes: Buffer } | { ok: false; permanent: boolean; detail: string; aborted?: boolean }>;

/** Transient pull failures of one image before it counts as not received (and the text is delivered anyway). */
export const PULL_MAX_ATTEMPTS = 3;

const BROKEN: ReadonlySet<string> = new Set(['pane-closed', 'pane-moved', 'workspace-gone', 'exposure-revoked']);

/**
 * Apply one envelope from an authenticated peer. A refusal answers with its
 * code only (`A2aRemoteErrorCode`): the detail behind it (a store error, a
 * check's own words) is logged here and never sent to the peer.
 */
export async function acceptInbound(
  raw: unknown,
  peer: { hostId: HostId; pull?: ImagePull },
  deps: InboundDeps,
): Promise<A2aRemoteDeliverResponse> {
  let answer: A2aRemoteDeliverResponse;
  try {
    answer = await applyInbound(raw, peer, deps);
  } catch (err) {
    answer = { ok: false, error: 'unavailable', message: err instanceof Error ? err.message : String(err) };
  }
  if (answer.ok || answer.message === undefined) return answer;
  deps.log?.('warn', `[a2a-remote] message from ${peer.hostId} refused (${answer.error}): ${answer.message}`);
  return { ok: false, error: answer.error };
}

async function applyInbound(
  raw: unknown,
  peer: { hostId: HostId; pull?: ImagePull },
  deps: InboundDeps,
): Promise<A2aRemoteDeliverResponse> {
  const parsed = parseEnvelope(raw);
  if ('error' in parsed) return fail(parsed.error);
  // Peer text is pasted into a terminal later: control characters and escape
  // sequences go here, before anything is stored (and again before the write).
  const env: A2aRemoteEnvelope = {
    ...parsed.envelope,
    ...(typeof parsed.envelope.text === 'string' ? { text: sanitizeRemoteMessage(parsed.envelope.text) } : {}),
    ...(typeof parsed.envelope.message === 'string' ? { message: sanitizeRemoteMessage(parsed.envelope.message) } : {}),
    ...(parsed.envelope.evidence ? { evidence: sanitizeEvidence(parsed.envelope.evidence) } : {}),
  };
  // A message with images may have no text (an image-only reply).
  if ((env.kind === 'task' || env.kind === 'reply') && !env.text && !env.images) return fail('bad-request');

  // A spawn or continue request names no link: it is answered before any link check.
  if (deps.spawn && isSpawnEnvelope(env)) return deps.spawn.applyInbound(env, peer);
  if (deps.continue && isContinueEnvelope(env)) return deps.continue.applyInbound(env, peer);
  if (deps.bundles && isBundleEnvelope(env)) return deps.bundles.applyInbound(env, peer);
  if (env.kind === 'link' && deps.offers && (env.link?.state === 'offer' || env.link?.state === 'offer-withdrawn')) {
    return deps.offers.applyInbound(env, peer);
  }
  if (env.kind === 'link') return applyLinkNotice(env, peer.hostId, deps);
  // A status past the peer's flood guard: taken and dropped before any check, so neither a refusal
  // for the peer to retry nor a log line per message comes of it.
  if (env.kind === 'status' && deps.remoteStatus?.admit && !deps.remoteStatus.admit(peer.hostId)) {
    return { ok: true, taskId: env.taskId as string, duplicate: true };
  }

  let onThisLink = false;
  if (env.kind === 'reply' || env.kind === 'state' || env.kind === 'receipt' || env.kind === 'status') {
    const marker = deps.taskService.getTask(env.taskId as string)?.metadata.remote as A2aRemoteTaskMarkerV1 | undefined;
    onThisLink = marker?.v === 1 && marker.linkId === env.linkId;
  }
  const check = deps.linkStore.checkMessage(env.linkId, env.linkVersion, peer.hostId, 'inbound', env.kind, undefined, { onThisLink });
  if (!check.ok) return fail(check.error);
  const link = check.link;
  const remoteWs = remoteWorkspaceId(link.linkId);
  // A link a remote start made carries no images either way.
  if ((link.spawned === true || deps.spawnLinks?.isSpawnLink(link.linkId)) && env.images && env.images.length > 0) {
    return fail('bad-request', 'a link a remote start made carries no images');
  }

  if (env.kind === 'task') {
    const taskId = remoteTaskId(link.linkId, env.messageId);
    const text = env.text ?? '';
    // A task already here is answered from the ledger: its images were taken then.
    const known = deps.taskService.getTask(taskId) !== undefined;
    // Counted before its images are fetched and stored; a resend of a task already here is not a new one.
    const budget = known ? undefined : deps.taskBudget;
    if (budget && !budget.admit(peer.hostId)) return fail('unavailable', 'too many new tasks from that PC in the last hour; it sends this one again later');
    const parts = await messageParts(env, peer, deps, known);
    if ('error' in parts) {
      budget?.unadmit(peer.hostId);
      return fail(parts.error);
    }
    const created = await deps.taskService.createTask(
      {
        id: taskId,
        title: (text || imagesTitle(env.images)).split('\n', 1)[0].slice(0, 100),
        from: { workspaceId: remoteWs, name: deps.aliasFor(link) },
        // A brain end is this PC's Moa: its HQ workspace, no pane.
        to: link.local.kind === 'brain'
          ? { workspaceId: link.local.workspaceId, name: A2A_BRAIN_ALIAS }
          : {
            workspaceId: link.local.workspaceId,
            name: deps.localWorkspaceName?.(link.local.workspaceId) ?? link.local.workspaceId,
            paneId: link.local.paneId,
          },
        history: [{ kind: 'message', messageId: env.messageId, role: 'user', parts: parts.parts }],
        remote: {
          v: 1, linkId: link.linkId, hostId: peer.hostId, messageId: env.messageId, direction: 'inbound', delivered: false, kind: link.local.kind,
          // A later instruction to an agent a remote start made waits for its card here (followUps 'ask').
          ...(deps.spawnLinks?.holdsFollowUps(link.linkId) ? { held: 'awaiting-approval' as const, heldAt: new Date().toISOString() } : {}),
        } as A2aRemoteTaskMarkerV1,
      },
      { conflictOnBodyMismatch: true },
    );
    if (!created.ok || created.existed) {
      budget?.unadmit(peer.hostId);
      if (!created.ok) return fail('conflict' in created ? 'conflict' : 'unavailable', created.error);
      return { ok: true, taskId, duplicate: true };
    }
    deps.broadcast({ type: A2A_REMOTE_INBOUND_EVENT, taskId });
    return { ok: true, taskId, duplicate: false };
  }

  const taskId = env.taskId as string;
  if (env.kind === 'status') {
    // What the worker on the peer is doing on a task WE sent: kept in memory, never a reply or a state.
    const task = deps.taskService.getTask(taskId);
    const marker = task?.metadata.remote as A2aRemoteTaskMarkerV1 | undefined;
    if (!deps.remoteStatus) return fail('bad-request', 'this PC takes no status');
    if (marker?.direction !== 'outbound') return fail('forbidden', 'a status is only for a task this host sent');
    const open = !(TERMINAL_STATES as readonly string[]).includes(task!.status.state);
    // The agent there is gone: said in this PC's log, since the task ends right after and its status with it.
    // Only this PC's own ids and the fixed kind; nothing the peer wrote. Once per open task: a peer repeating it is not logged again.
    if ((env.status as A2aRemoteStatusV1).kind === 'gone' && open && (deps.remoteStatus.firstGone?.(taskId) ?? true)) {
      deps.log?.('info', `[a2a-remote] task ${taskId} on link ${link.linkId}: the agent on that PC is gone`);
    }
    // A task that ended has no worker status any more: taken, and dropped.
    if (open) deps.remoteStatus.note(taskId, env.status as A2aRemoteStatusV1, peer.hostId);
    return { ok: true, taskId, duplicate: false };
  }
  if (env.kind === 'receipt') {
    // The peer got (or read) a task WE sent it: bookkeeping only, never a state.
    const marker = deps.taskService.getTask(taskId)?.metadata.remote as A2aRemoteTaskMarkerV1 | undefined;
    if (marker?.direction !== 'outbound') return fail('forbidden', 'a receipt is only for a task this host sent');
    const res = await deps.taskService.markRemote({ taskId, remoteReceipt: env.receipt as A2aRemoteReceipt });
    if (!res.ok) return fail('unavailable', res.error);
    return { ok: true, taskId, duplicate: false };
  }
  if (env.kind === 'reply' && env.notice) {
    // The other host's notice about a message WE sent on this task: never an answer, never a state.
    const task = deps.taskService.getTask(taskId);
    const marker = task?.metadata.remote as A2aRemoteTaskState | undefined;
    if (deps.remoteNotice && !deps.remoteNotice.admit(link.linkId)) return { ok: true, taskId, duplicate: true };
    if (!task || (TERMINAL_STATES as readonly string[]).includes(task.status.state)) return { ok: true, taskId, duplicate: true };
    const about = env.notice.messageId;
    // A notice's id is derived from the message it is about, so there is one per message; the task must be
    // this link's, and the message one this PC sent on it. Any other notice is answered like every drop.
    // The link test cannot fail here: checkMessage above already refused (unknown-task) a task that is not
    // this link's, a local one included. It stays as defense in depth, and is not tested for that reason.
    if (env.messageId !== heldNoticeMessageId(about) || marker?.linkId !== link.linkId || !marker.sent?.includes(about)) {
      // Only this PC's ids in the line; nothing the peer wrote.
      if (deps.remoteNotice?.unknownOnce(link.linkId) ?? true) {
        deps.log?.('warn', `[a2a-remote] link ${link.linkId}: a notice about a message this PC did not send on task ${taskId}; dropped`);
      }
      return { ok: true, taskId, duplicate: true };
    }
    // Once per message, ever: a notice about it already stored is not shown again.
    const noticeId = heldNoticeMessageId(about);
    const seen = task.history.some((m) => m.messageId === noticeId || noticeAbout(m.metadata) === about)
      || (marker.inbox ?? []).some((i) => i.kind === 'notice' && i.messageId === noticeId);
    if (seen) return { ok: true, taskId, duplicate: true };
    const role: Message['role'] = task.metadata.from.workspaceId === remoteWs ? 'user' : 'agent';
    const res = await deps.taskService.appendRemoteMessage({
      taskId,
      linkId: link.linkId,
      actorWorkspaceId: remoteWs,
      // The words are this PC's own, with its own record of when it sent the message.
      message: {
        kind: 'message',
        messageId: env.messageId,
        role,
        parts: [{ kind: 'text', text: heldNoticeText(about, marker.sentAt?.[about], env.notice.unconfirmed === true) }],
        metadata: { wmuxNotice: { kind: env.notice.kind, messageId: about, ...(env.notice.unconfirmed ? { unconfirmed: true } : {}) } },
      },
    });
    if (!res.ok) return fail('conflict' in res ? 'conflict' : 'unavailable', res.error);
    return { ok: true, taskId, duplicate: res.duplicate };
  }
  if (env.kind === 'reply') {
    const task = deps.taskService.getTask(taskId);
    // The peer is the sender of an inbound task and the receiver of an outbound one.
    const role: Message['role'] = task?.metadata.from.workspaceId === remoteWs ? 'user' : 'agent';
    const parts = await messageParts(env, peer, deps, task?.history.some((m) => m.messageId === env.messageId) === true);
    if ('error' in parts) return fail(parts.error);
    const res = await deps.taskService.appendRemoteMessage({
      taskId,
      linkId: link.linkId,
      actorWorkspaceId: remoteWs,
      message: { kind: 'message', messageId: env.messageId, role, parts: parts.parts },
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
    ...(env.message ? { message: env.message } : {}),
    ...(env.evidence ? { evidence: env.evidence } : {}),
  });
  if (!res.ok) return fail(stateErrorCode(res), res.error);
  // A task that ended has no worker status any more.
  if ((TERMINAL_STATES as readonly string[]).includes(env.state as string)) deps.remoteStatus?.forget(taskId);
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
/** The message id a stored host notice is about (`metadata.wmuxNotice.messageId`), if it is one. */
function noticeAbout(metadata: Record<string, unknown> | undefined): string | undefined {
  const notice = metadata?.['wmuxNotice'];
  if (!notice || typeof notice !== 'object' || Array.isArray(notice)) return undefined;
  const about = (notice as Record<string, unknown>)['messageId'];
  return typeof about === 'string' ? about : undefined;
}

function parseEnvelope(raw: unknown): Parsed {
  if (!isPlainObject(raw)) return { error: 'bad-request' };
  if (raw['protocol'] !== A2A_REMOTE_PROTOCOL) return { error: 'protocol' };
  const { linkId, linkVersion, messageId, kind, taskId, text, state, link, sentAt } = raw;
  const images = parseA2aRemoteImageRefs(raw['images']);
  if (images === null) return { error: 'bad-request' };
  if (images && kind !== 'task' && kind !== 'reply') return { error: 'bad-request' };
  if (!isSafeId(linkId) || typeof messageId !== 'string' || !A2A_REMOTE_MESSAGE_ID_RE.test(messageId) || typeof sentAt !== 'string') return { error: 'bad-request' };
  if (typeof linkVersion !== 'number' || !Number.isInteger(linkVersion)) return { error: 'bad-request' };
  if (!isA2aRemoteMessageKind(kind)) return { error: 'bad-request' };
  if (text !== undefined && typeof text !== 'string') return { error: 'bad-request' };
  if (typeof text === 'string' && Buffer.byteLength(text, 'utf8') > A2A_REMOTE_BODY_MAX) return { error: 'too-large' };
  switch (kind) {
    case 'task':
      if (!images && (typeof text !== 'string' || !text)) return { error: 'bad-request' };
      break;
    case 'reply':
      if (!isSafeId(taskId) || (!images && (typeof text !== 'string' || !text))) return { error: 'bad-request' };
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
    case 'status':
      if (!isSafeId(taskId) || !parseA2aRemoteStatus(raw['status'])) return { error: 'bad-request' };
      break;
  }
  const envelope = { ...raw } as unknown as A2aRemoteEnvelope;
  if (images) envelope.images = images;
  else delete envelope.images;
  // A host's notice rides on a reply only, checked strictly: one that does not parse is refused, never
  // taken as a plain reply (its fixed text would then reach the agent as a message).
  if (raw['notice'] !== undefined) {
    const notice = kind === 'reply' ? parseA2aRemoteNotice(raw['notice']) : null;
    if (!notice) return { error: 'bad-request' };
    envelope.notice = notice;
  }
  // A state's message and evidence are optional extras: one that is malformed
  // or too large is left off and the state still applies, as from an older peer.
  const message = raw['message'];
  if (kind !== 'state' || typeof message !== 'string' || !message || Buffer.byteLength(message, 'utf8') > A2A_REMOTE_BODY_MAX) {
    delete envelope.message;
  }
  const evidence = kind === 'state' ? normalizeCompletionEvidenceWire(raw['evidence']) : null;
  if (evidence) envelope.evidence = evidence;
  else delete envelope.evidence;
  // A status, checked and capped; its labels are shown to agents and people, so cleaned like any peer text.
  const status = kind === 'status' ? parseA2aRemoteStatus(raw['status']) : null;
  if (status) {
    const options = status.detail?.options?.map((o) => sanitizeRemoteMessage(o));
    envelope.status = options ? { ...status, detail: { ...status.detail, options } } : status;
  } else delete envelope.status;
  return { envelope };
}

/** Peer evidence is shown and stored like peer text: its strings are sanitized the same way. */
function sanitizeEvidence(ev: CompletionEvidence): CompletionEvidence {
  const clean = (v: string) => sanitizeRemoteMessage(v);
  const items = ev.items.map((it): EvidenceItem => ({
    ...it,
    summary: clean(it.summary),
    ...('command' in it && typeof it.command === 'string' ? { command: clean(it.command) } : {}),
    ...(typeof it.output === 'string' ? { output: clean(it.output) } : {}),
    ...('location' in it && typeof it.location === 'string' ? { location: clean(it.location) } : {}),
  }) as EvidenceItem);
  // A path is not rewritten: one with a C1 control, or a bidi or other format
  // character that can make it read as another path, is left off.
  const files = ev.files?.filter((f) => !/[\u0080-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u.test(f));
  return { summary: clean(ev.summary), items, ...(files ? { files } : {}) };
}

/**
 * The ledger parts of a task / reply: its text, then one file part per image
 * — with the receiver's own path when the image is here, without one (and
 * why) when it could not be received. `known`: the ledger has this message
 * already, so nothing is fetched or claimed (the parts only key the
 * duplicate check: text and hashes).
 *
 * A joiner's upload that is not here yet answers `attachment-missing` (it
 * uploads again); a pull from the server that failed for now answers
 * `unavailable` (the stream redelivers it), until PULL_MAX_ATTEMPTS.
 */
async function messageParts(
  env: A2aRemoteEnvelope,
  peer: { hostId: HostId; pull?: ImagePull },
  deps: InboundDeps,
  known: boolean,
): Promise<{ parts: Part[] } | { error: A2aRemoteErrorCode }> {
  const parts: Part[] = env.text ? [{ kind: 'text', text: env.text }] : [];
  const images = deps.images;
  if (!env.images || !images) return { parts: parts.length > 0 ? parts : [{ kind: 'text', text: '' }] };
  for (const ref of env.images) {
    const meta = { sha256: ref.sha256, bytes: ref.bytes };
    if (known) {
      parts.push({ kind: 'file', file: { mimeType: ref.mediaType }, metadata: meta });
      continue;
    }
    let got: { ok: true; path: string; info: { width: number; height: number } } | { ok: false; reason: ImageNotReceived };
    if (!peer.pull) {
      got = await images.store.claim(peer.hostId, ref);
      if (!got.ok && got.reason === 'missing') return { error: 'attachment-missing' };
    } else {
      got = (await images.store.received(peer.hostId, ref)) ?? (await pullOne(env, ref, peer as { hostId: HostId; pull: ImagePull }, images));
      if (!got.ok && got.reason === 'missing' && (images.pullAttempts.get(pullKey(peer.hostId, env, ref)) ?? 0) < PULL_MAX_ATTEMPTS) {
        return { error: 'unavailable' };
      }
    }
    if (got.ok) {
      images.pullAttempts.delete(pullKey(peer.hostId, env, ref));
      parts.push({
        kind: 'file',
        file: { mimeType: ref.mediaType, uri: pathToFileURL(got.path).href },
        // `path` is how the receiving agent is told where it is (the paste and a2a_task_query).
        metadata: { ...meta, width: got.info.width, height: got.info.height, path: got.path },
      });
    } else {
      images.pullAttempts.delete(pullKey(peer.hostId, env, ref));
      parts.push({ kind: 'file', file: { mimeType: ref.mediaType }, metadata: { ...meta, notReceived: got.reason } });
    }
  }
  return { parts };
}

/** Fetch one image from the server; a transient failure counts an attempt and reads as `missing` until the last. */
async function pullOne(
  env: A2aRemoteEnvelope,
  ref: A2aRemoteImageRef,
  peer: { hostId: HostId; pull: ImagePull },
  images: InboundImages,
): Promise<{ ok: true; path: string; info: { width: number; height: number } } | { ok: false; reason: ImageNotReceived }> {
  const res = await peer.pull(ref);
  if (res.ok) return images.store.storeReceived(peer.hostId, ref, res.bytes);
  const key = pullKey(peer.hostId, env, ref);
  // This PC stopped the fetch (its stream ended, or it is shutting down): not an attempt.
  if (res.aborted) return { ok: false, reason: 'missing' };
  // A permanent failure needs no more attempts.
  const n = res.permanent ? PULL_MAX_ATTEMPTS : (images.pullAttempts.get(key) ?? 0) + 1;
  images.pullAttempts.set(key, n);
  return { ok: false, reason: 'missing' };
}

function pullKey(hostId: HostId, env: A2aRemoteEnvelope, ref: A2aRemoteImageRef): string {
  return `${hostId}:${env.messageId}:${ref.sha256}`;
}

/** A title for an image-only task. */
function imagesTitle(images: readonly A2aRemoteImageRef[] | undefined): string {
  const n = images?.length ?? 0;
  return n === 1 ? '1 image' : `${n} images`;
}

function fail(error: A2aRemoteErrorCode, message?: string): A2aRemoteDeliverResponse {
  return { ok: false, error, ...(message ? { message } : {}) };
}
