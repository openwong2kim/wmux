import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  A2A_BRAIN_ALIAS,
  A2A_FEATURE_IMAGES,
  A2A_REMOTE_BODY_MAX,
  A2A_REMOTE_IMAGE_LIMITS,
  A2A_REMOTE_PROTOCOL,
  A2A_REMOTE_STATE_ENVELOPE_MAX,
  A2A_REMOTE_STATE_EVIDENCE_MAX,
  A2A_REMOTE_STATE_MESSAGE_MAX,
  isA2aRemoteImageMediaType,
  type A2aRemoteImageRef,
  type A2aLinkRecordV1,
  type A2aRemoteReceipt,
  type A2aRemoteEnvelope,
  type A2aRemoteTaskMarkerV1,
} from '../../shared/a2aRemote';
import { redactSecrets } from '../../shared/redactSecrets';
import {
  isRemoteWorkspaceId,
  remoteAlias,
  remoteWorkspaceId,
  sanitizeRemoteText,
  type A2aRemoteReplyInput,
  type A2aRemoteSendTaskInput,
  type A2aRemoteStateInput,
  type A2aRemoteTarget,
  type A2aRemoteTaskState,
} from '../../shared/a2aRemoteDelivery';
import type { CompletionEvidence, EvidenceItem, Message, Part, Task } from '../../shared/types';
import type { A2aTaskService } from '../a2a/A2aTaskService';
import type { LinkStore } from './linkStore';
import type { OutboxStore } from './outboxStore';
import { remoteTaskId } from './ids';

/**
 * Cross-host A2A, sending side: turn a local agent's send / reply / state
 * change on a remote task into a ledger entry plus an outbox envelope. The
 * daemon's RPC handlers (wiring step) are thin parses around these.
 */

/** `note`: what the sender should know about how it went (images omitted for an older peer). */
export type OutboundResult = { ok: true; taskId: string; note?: string } | { ok: false; error: string };

/** One image ready to leave: checked, stripped, kept in the sender store. */
/** Who attaches: its pane's terminal (main-verified), and the workspace it must belong to. */
export interface ImageCaller {
  ptyId?: string | undefined;
  workspaceId: string;
}

export interface PreparedImage {
  ref: A2aRemoteImageRef;
  /** The source file's name, for this PC's own ledger only (never sent). */
  name: string;
  /** The sender copy. */
  path: string;
  width: number;
  height: number;
}

/** The sender side of images (`images.1`). */
export interface OutboundImages {
  /**
   * Read the images an agent named, check, strip and keep them: from its
   * pane's folders when `ptyId` is a terminal of `workspaceId`, else from the
   * uploads folder only.
   */
  prepare(paths: readonly string[], caller: ImageCaller): Promise<{ ok: true; images: PreparedImage[] } | { ok: false; error: string }>;
  /** Whether the sender copy of an image is still here. */
  hasOutgoing(sha256: string): Promise<boolean>;
}

export interface OutboundDeps {
  linkStore: Pick<LinkStore, 'get' | 'list' | 'checkMessage'>;
  taskService: Pick<A2aTaskService, 'getTask' | 'createTask' | 'appendRemoteMessage' | 'cancelTask' | 'markRemote'>;
  outbox: Pick<OutboxStore, 'enqueue'>;
  /** Display alias of a link's remote pane (see `linkAlias`). */
  aliasFor: (link: A2aLinkRecordV1) => string;
  /** Absent: a message naming images is refused. */
  images?: OutboundImages;
  /** What the other PC takes (`A2aRemoteDelivery.peerFeatures`); undefined when it was never seen. */
  peerFeatures?: (hostId: string) => ReadonlySet<string> | undefined;
  now?: () => number;
  /** Test seam for envelope messageIds (defaults to a random UUID). */
  mintId?: () => string;
  /**
   * A link a remote start made on this PC: what goes out on it is redacted
   * (`redactSecrets`) and carries no images. A backstop, not a boundary: it
   * matches known key shapes and misses encoded ones.
   */
  spawnLink?: (linkId: string) => boolean;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/**
 * `<PC name>/<workspace>/<pane>` for a link's remote pane, `<PC name>/Moa`
 * for a brain end. The workspace part is the remote workspace's name, the
 * pane part its label; each falls back to its id when the link has no name.
 */
export function linkAlias(link: A2aLinkRecordV1, hostName: string | undefined): string {
  const pc = hostName || link.remote.hostId.slice(0, 8);
  if (link.remote.kind === 'brain') return `${pc.replace(/\//g, '-').trim() || '?'}/${A2A_BRAIN_ALIAS}`;
  return remoteAlias(pc, link.remote.workspaceName || link.remote.workspaceId, link.remote.label || link.remote.paneId || '');
}

/**
 * Aliases of every ACTIVE link, unique: when two links would read the same,
 * the later one (by creation) gets `#2`, the next `#3`, so an agent's exact
 * alias names exactly one link. Inbound task senders and the send targets
 * read this one table, so discover and send always agree.
 */
export function aliasTable(links: readonly A2aLinkRecordV1[], hostName: (hostId: string) => string | undefined): Map<string, string> {
  const active = links
    .filter((l) => l.state === 'active')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.linkId.localeCompare(b.linkId));
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const link of active) {
    const base = linkAlias(link, hostName(link.remote.hostId));
    let alias = base;
    for (let n = 2; used.has(alias); n++) alias = `${base}#${n}`;
    used.add(alias);
    out.set(link.linkId, alias);
  }
  return out;
}

/** Every ACTIVE link as an addressable target. */
export function listRemoteTargets(deps: Pick<OutboundDeps, 'linkStore' | 'aliasFor'>): A2aRemoteTarget[] {
  return deps.linkStore
    .list()
    .filter((l) => l.state === 'active')
    .map((l) => ({
      alias: deps.aliasFor(l),
      linkId: l.linkId,
      hostId: l.remote.hostId,
      kind: l.local.kind,
      local: { workspaceId: l.local.workspaceId, ...(l.local.paneId ? { paneId: l.local.paneId } : {}) },
      remote: {
        workspaceId: l.remote.workspaceId,
        ...(l.remote.paneId ? { paneId: l.remote.paneId } : {}),
        ...(l.remote.label ? { label: l.remote.label } : {}),
      },
      allowOutbound: l.allow.outbound,
    }));
}

/**
 * A new task from the link's local pane to its remote pane: an outbound ledger
 * task under the deterministic id, then a `task` envelope in the outbox. If the
 * envelope cannot be queued the task is canceled, so the ledger never shows a
 * task the peer will never get.
 */
export async function sendRemoteTask(deps: OutboundDeps, input: A2aRemoteSendTaskInput): Promise<OutboundResult> {
  const link = deps.linkStore.get(input.linkId);
  if (!link) return { ok: false, error: 'unknown-link' };
  if (link.local.kind === 'brain') {
    // Moa sends as its HQ workspace; main proved it from the commander token.
    if (link.local.workspaceId !== input.from.workspaceId || input.from.paneId !== undefined) {
      return { ok: false, error: 'forbidden: only this PC\'s Moa may send on this link' };
    }
  } else if (!input.from.paneId || link.local.workspaceId !== input.from.workspaceId || link.local.paneId !== input.from.paneId) {
    return { ok: false, error: 'forbidden: only the linked local pane may send on this link' };
  }
  const check = deps.linkStore.checkMessage(link.linkId, link.version, link.remote.hostId, 'outbound', 'task');
  if (!check.ok) return { ok: false, error: check.error };
  const att = await attachImages(deps, link, input.images, { ptyId: input.from.ptyId, workspaceId: input.from.workspaceId }, input.text);
  if (!att.ok) return att;
  const sizeErr = bodyError(att.text, att.images.length > 0);
  if (sizeErr) return { ok: false, error: sizeErr };

  const messageId = mint(deps);
  const taskId = remoteTaskId(link.linkId, messageId);
  const marker: A2aRemoteTaskMarkerV1 = { v: 1, linkId: link.linkId, hostId: link.remote.hostId, messageId, direction: 'outbound', kind: link.local.kind };
  const created = await deps.taskService.createTask({
    id: taskId,
    title: input.title || att.text.slice(0, 100) || countImages(att.images.length),
    from: { ...input.from },
    to: { workspaceId: remoteWorkspaceId(link.linkId), name: deps.aliasFor(link) },
    history: [ledgerMessage(messageId, 'user', att.text, att.images)],
    remote: marker,
  });
  if (!created.ok) return { ok: false, error: created.error };
  try {
    deps.outbox.enqueue(link.remote.hostId, envelope(deps, link, messageId, { kind: 'task', text: att.text, ...imagesField(att.images.map((i) => i.ref)) }));
  } catch (err) {
    await deps.taskService.cancelTask({ taskId, callerWorkspaceId: input.from.workspaceId });
    return { ok: false, error: `unavailable: could not queue the task (${errText(err)})` };
  }
  return { ok: true, taskId, ...(att.note ? { note: att.note } : {}) };
}

/**
 * A reply on a remote task from its LOCAL side: appended to the ledger history,
 * then queued as a `reply` envelope.
 */
export async function sendRemoteReply(deps: OutboundDeps, input: A2aRemoteReplyInput): Promise<OutboundResult> {
  const found = remoteTaskAndLink(deps, input.taskId);
  if (!found.ok) return found;
  const { task, link } = found;
  const localSide = isRemoteWorkspaceId(task.metadata.from.workspaceId) ? 'to' : 'from';
  if (task.metadata[localSide].workspaceId !== input.workspaceId) {
    return { ok: false, error: 'forbidden: the caller is not the local party of this task' };
  }
  const check = deps.linkStore.checkMessage(link.linkId, link.version, link.remote.hostId, 'outbound', 'reply', undefined, { onThisLink: true });
  if (!check.ok) return { ok: false, error: check.error };
  const att = await attachImages(deps, link, input.images, { ptyId: input.ptyId, workspaceId: input.workspaceId }, input.text);
  if (!att.ok) return att;
  const sizeErr = bodyError(att.text, att.images.length > 0);
  if (sizeErr) return { ok: false, error: sizeErr };

  const messageId = mint(deps);
  const appended = await deps.taskService.appendRemoteMessage({
    taskId: task.id,
    linkId: link.linkId,
    actorWorkspaceId: input.workspaceId,
    message: ledgerMessage(messageId, localSide === 'from' ? 'user' : 'agent', att.text, att.images),
  });
  if (!appended.ok) return { ok: false, error: appended.error };
  // The ledger holds the reply now; queueing it is the sync's job, which the
  // daemon also re-runs on start and periodically if this attempt fails.
  const synced = await syncRemoteTask(deps, task.id);
  if (!synced.ok) deps.log?.('warn', `[a2a-remote] reply on ${task.id} stored, queueing deferred: ${synced.error}`);
  return { ok: true, taskId: task.id, ...(att.note ? { note: att.note } : {}) };
}

/** What the outbound sync needs: the ledger (read + bookkeeping), the link gate and the outbox. */
export type StateDeps = Pick<OutboundDeps, 'linkStore' | 'outbox' | 'now' | 'mintId' | 'images' | 'spawnLink'> & {
  taskService: Pick<A2aTaskService, 'getTask' | 'markRemote'>;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
};

/**
 * A state the local ledger ALREADY committed on a remote task, for the peer.
 * The ledger is checked: a state the task is not in is refused, so this
 * cannot tell the peer something that did not happen here. Idempotent: the
 * sync sends each committed state once.
 */
export async function sendRemoteState(deps: StateDeps, input: A2aRemoteStateInput): Promise<OutboundResult> {
  const task = deps.taskService.getTask(input.taskId);
  if (!task || !task.metadata.remote) return { ok: false, error: 'unknown-task' };
  if (task.status.state !== input.state) {
    return { ok: false, error: `bad-request: task ${task.id} is ${task.status.state}, not ${input.state}` };
  }
  const synced = await syncRemoteTask(deps, task.id, input.summary !== undefined ? { summary: input.summary } : {});
  return synced.ok ? { ok: true, taskId: task.id } : synced;
}

const SYNCED_STATES: ReadonlySet<string> = new Set(['working', 'input-required', 'completed', 'failed', 'canceled']);

/**
 * The state message id is derived from the ledger transition (task, state,
 * time), so queueing the same committed state twice is one message to the peer.
 */
/** One receipt per (task, kind): a resend after a crash is the same message. */
export function receiptMessageId(taskId: string, receipt: A2aRemoteReceipt): string {
  return `rc-${crypto.createHash('sha256').update(`${taskId}\0${receipt}`).digest('hex').slice(0, 32)}`;
}

export function stateMessageId(task: Pick<Task, 'id' | 'status'>): string {
  const h = crypto.createHash('sha256').update(`${task.id}\0${task.status.state}\0${task.status.timestamp}`).digest('hex');
  return `st-${h.slice(0, 32)}`;
}

/**
 * Bring the peer up to date with OUR side of one remote task, from the ledger
 * (the source of truth): every reply of ours not yet queued, then the current
 * state if we have not told it yet. Each queued item is recorded on the
 * ledger marker afterwards; a crash in between only queues it again under the
 * same message id, which the peer answers as a duplicate. Run after every
 * local change, on daemon start and periodically.
 */
export async function syncRemoteTask(
  deps: StateDeps,
  taskId: string,
  opts: { summary?: string } = {},
): Promise<{ ok: true; queued: number } | { ok: false; error: string }> {
  const found = remoteTaskAndLink(deps, taskId);
  if (!found.ok) return found;
  const { task, link } = found;
  const marker = task.metadata.remote as A2aRemoteTaskState;
  const check = deps.linkStore.checkMessage(link.linkId, link.version, link.remote.hostId, 'outbound', 'reply', undefined, { onThisLink: true });
  if (!check.ok) return { ok: false, error: check.error };
  const ours: Message['role'] = isRemoteWorkspaceId(task.metadata.from.workspaceId) ? 'agent' : 'user';
  let queued = 0;
  try {
    for (const m of task.history) {
      if (m.role !== ours || m.messageId === marker.messageId || (marker.sent ?? []).includes(m.messageId)) continue;
      // eslint-disable-next-line no-await-in-loop -- recorded in order
      const body = await replyBody(deps, m);
      // A reply may be images only; one with neither is not sent.
      if (!body.text && body.images.length === 0) continue;
      deps.outbox.enqueue(link.remote.hostId, envelope(deps, link, m.messageId, { kind: 'reply', taskId: task.id, text: body.text, ...imagesField(body.images) }));
      // eslint-disable-next-line no-await-in-loop -- recorded in order
      await deps.taskService.markRemote({ taskId: task.id, sent: m.messageId });
      queued += 1;
    }
    // Inbound: tell the sender how far we got (handed over, then read).
    const receipt = marker.direction === 'inbound' ? (marker.readAt ? 'read' : marker.delivered === true ? 'delivered' : undefined) : undefined;
    if (receipt && marker.receiptSync !== receipt && marker.receiptSync !== 'read') {
      deps.outbox.enqueue(link.remote.hostId, envelope(deps, link, receiptMessageId(task.id, receipt), { kind: 'receipt', taskId: task.id, receipt }));
      await deps.taskService.markRemote({ taskId: task.id, receiptSync: receipt });
      queued += 1;
    }
    const state = task.status.state;
    // Only the receiver moves a task on the peer: one this PC sent tells it nothing but a cancel.
    const mayTell = marker.direction !== 'outbound' || state === 'canceled';
    if (mayTell && SYNCED_STATES.has(state) && marker.stateSync !== state) {
      const summary = (opts.summary ?? statusSummary(task))?.slice(0, 2000);
      deps.outbox.enqueue(link.remote.hostId, stateEnvelope(deps, link, task, summary));
      await deps.taskService.markRemote({ taskId: task.id, stateSync: state });
      queued += 1;
    }
  } catch (err) {
    return { ok: false, error: `unavailable: could not queue for the peer (${errText(err)})` };
  }
  return { ok: true, queued };
}

/**
 * A task's state for the peer, with the report itself: the status message and
 * the evidence, which the sender's copy otherwise loses (only the summary used
 * to travel). The whole envelope stays within A2A_REMOTE_STATE_ENVELOPE_MAX as
 * JSON: an escaped character can take six bytes there, so it is measured, not
 * estimated. Over it, the message is cut, then evidence items are left off
 * from the end, and at worst the plain state goes with its summary alone.
 */
function stateEnvelope(deps: StateDeps, link: A2aLinkRecordV1, task: Task, summary: string | undefined): A2aRemoteEnvelope {
  let message = statusMessageText(task);
  let evidence = stateEvidence(task);
  const build = () => envelope(deps, link, stateMessageId(task), {
    kind: 'state',
    taskId: task.id,
    state: task.status.state,
    ...(summary ? { text: summary } : {}),
    ...(message ? { message } : {}),
    ...(evidence ? { evidence } : {}),
  });
  const fits = (e: A2aRemoteEnvelope) => Buffer.byteLength(JSON.stringify(e), 'utf8') <= A2A_REMOTE_STATE_ENVELOPE_MAX;
  let env = build();
  while (!fits(env) && message) {
    const bytes = Buffer.byteLength(message, 'utf8');
    message = bytes > 256 ? cutUtf8(message, Math.floor(bytes / 2)) : undefined;
    env = build();
  }
  while (!fits(env) && evidence && evidence.items.length > 0) {
    evidence = { ...evidence, items: evidence.items.slice(0, -1) };
    env = build();
  }
  if (!fits(env)) {
    message = undefined;
    evidence = undefined;
    env = build();
  }
  return env;
}

/**
 * The status message's text as peer text (controls stripped, as the peer would
 * strip them anyway), cut to A2A_REMOTE_STATE_MESSAGE_MAX bytes.
 */
function statusMessageText(task: Task): string | undefined {
  const text = sanitizeRemoteText((task.status.message?.parts ?? [])
    .flatMap((p) => (p.kind === 'text' ? [p.text] : []))
    .join('\n'));
  return text ? cutUtf8(text, A2A_REMOTE_STATE_MESSAGE_MAX) : undefined;
}

/**
 * The status evidence within A2A_REMOTE_STATE_EVIDENCE_MAX bytes: items that
 * do not fit are left off from the end, then the file list.
 */
function stateEvidence(task: Task): CompletionEvidence | undefined {
  const ev = (task.status as { evidence?: CompletionEvidence }).evidence;
  if (!ev) return undefined;
  const fits = (e: CompletionEvidence) => Buffer.byteLength(JSON.stringify(e), 'utf8') <= A2A_REMOTE_STATE_EVIDENCE_MAX;
  let out: CompletionEvidence = { summary: ev.summary, items: [...ev.items], ...(ev.files ? { files: [...ev.files] } : {}) };
  if (!fits(out) && out.files) out = { summary: out.summary, items: out.items };
  while (!fits(out) && out.items.length > 0) out = { ...out, items: out.items.slice(0, -1) };
  return fits(out) ? out : undefined;
}

/** `text` cut to at most `max` UTF-8 bytes, never inside a character. */
function cutUtf8(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  let cut = Buffer.from(text, 'utf8').subarray(0, max).toString('utf8');
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1);
  return cut;
}

function statusSummary(task: Task): string | undefined {
  const status = task.status as { evidence?: { summary?: string }; message?: Message };
  if (status.evidence?.summary) return status.evidence.summary;
  const part = status.message?.parts?.find((p) => p.kind === 'text');
  return part && part.kind === 'text' ? part.text : undefined;
}

// --- helpers --------------------------------------------------------------------

function remoteTaskAndLink(
  deps: StateDeps,
  taskId: string,
): { ok: true; task: Task; link: A2aLinkRecordV1 } | { ok: false; error: string } {
  const task = deps.taskService.getTask(taskId);
  const marker = task?.metadata.remote as A2aRemoteTaskMarkerV1 | undefined;
  if (!task || !marker || marker.v !== 1) return { ok: false, error: 'unknown-task' };
  const link = deps.linkStore.get(marker.linkId);
  if (!link) return { ok: false, error: 'unknown-link' };
  return { ok: true, task, link };
}

function envelope(
  deps: Pick<OutboundDeps, 'now' | 'spawnLink'>,
  link: A2aLinkRecordV1,
  messageId: string,
  body: Pick<A2aRemoteEnvelope, 'kind' | 'taskId' | 'text' | 'state' | 'message' | 'evidence' | 'receipt' | 'images'>,
): A2aRemoteEnvelope {
  return {
    protocol: A2A_REMOTE_PROTOCOL,
    linkId: link.linkId,
    linkVersion: link.version,
    messageId,
    // Marked on the link itself, so no path that sends on it can skip this.
    ...((link.spawned === true && link.proposer === 'remote') || deps.spawnLink?.(link.linkId) ? spawnLinkBody(body) : body),
    sentAt: new Date((deps.now ?? Date.now)()).toISOString(),
  };
}

/**
 * What may leave on a link a remote start made: every string redacted, no
 * images, and only the fields this build knows (rebuilt, not copied, so a
 * field added later cannot pass unredacted).
 */
function spawnLinkBody(
  body: Pick<A2aRemoteEnvelope, 'kind' | 'taskId' | 'text' | 'state' | 'message' | 'evidence' | 'receipt' | 'images'>,
): typeof body {
  const r = (v: string): string => redactSecrets(v);
  const evidence: CompletionEvidence | undefined = body.evidence
    ? {
      summary: r(body.evidence.summary),
      items: body.evidence.items.map((item): EvidenceItem =>
        item.kind === 'command'
          ? { kind: 'command', status: item.status, summary: r(item.summary), command: r(item.command), ...(item.output !== undefined ? { output: r(item.output) } : {}) }
          : {
            kind: item.kind, status: item.status, summary: r(item.summary),
            ...(item.location !== undefined ? { location: r(item.location) } : {}),
            ...(item.output !== undefined ? { output: r(item.output) } : {}),
          }),
      ...(body.evidence.files ? { files: body.evidence.files.map(r) } : {}),
    }
    : undefined;
  return {
    kind: body.kind,
    ...(body.taskId !== undefined ? { taskId: body.taskId } : {}),
    ...(body.text !== undefined ? { text: r(body.text) } : {}),
    ...(body.state !== undefined ? { state: body.state } : {}),
    ...(body.message !== undefined ? { message: r(body.message) } : {}),
    ...(evidence ? { evidence } : {}),
    // A receipt is one of two words; anything else is not sent.
    ...(body.receipt === 'delivered' || body.receipt === 'read' ? { receipt: body.receipt } : {}),
  };
}

/** A message for this PC's ledger: the text, then one file part per image (its sender copy). */
function ledgerMessage(messageId: string, role: Message['role'], text: string, images: readonly PreparedImage[]): Message {
  const parts: Part[] = text || images.length === 0 ? [{ kind: 'text', text }] : [];
  for (const i of images) {
    parts.push({
      kind: 'file',
      file: { name: i.name, mimeType: i.ref.mediaType, uri: pathToFileURL(i.path).href },
      metadata: { sha256: i.ref.sha256, bytes: i.ref.bytes, width: i.width, height: i.height },
    });
  }
  return { kind: 'message', messageId, role, parts };
}

/** The refs of a ledger message's images (file parts with a hash, not marked as not received), in order. */
export function imageRefsOf(m: Message): A2aRemoteImageRef[] {
  const out: A2aRemoteImageRef[] = [];
  for (const p of m.parts) {
    if (p.kind !== 'file' || p.metadata?.['notReceived'] !== undefined) continue;
    const sha256 = p.metadata?.['sha256'];
    const bytes = p.metadata?.['bytes'];
    const mediaType = p.file.mimeType;
    if (typeof sha256 !== 'string' || typeof bytes !== 'number' || !isA2aRemoteImageMediaType(mediaType)) continue;
    out.push({ sha256, mediaType, bytes });
  }
  return out;
}

/**
 * A reply as it goes to the peer, rebuilt from the ledger: its text, and the
 * images whose sender copy is still here. One that is gone is dropped with a
 * note in the text instead.
 */
async function replyBody(deps: Pick<StateDeps, 'images'>, m: Message): Promise<{ text: string; images: A2aRemoteImageRef[] }> {
  const text = m.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('');
  const refs = imageRefsOf(m);
  if (refs.length === 0) return { text, images: [] };
  const images: A2aRemoteImageRef[] = [];
  for (const ref of refs) {
    // eslint-disable-next-line no-await-in-loop -- a handful of stats
    if (deps.images && (await deps.images.hasOutgoing(ref.sha256))) images.push(ref);
  }
  const lost = refs.length - images.length;
  if (lost === 0) return { text, images };
  return { text: withNote(text, `[${countImages(lost)} omitted: this PC no longer has ${lost === 1 ? 'it' : 'them'}]`), images };
}

type Attached = { ok: true; text: string; images: PreparedImage[]; note?: string } | { ok: false; error: string };

/**
 * The images of an outgoing message. The other PC must take them
 * (`images.1`): one that does not gets the text with a note instead (an
 * older build would drop the refs unseen), and one never seen is refused,
 * since nothing says which of the two it is.
 */
async function attachImages(
  deps: Pick<OutboundDeps, 'images' | 'peerFeatures'>,
  link: A2aLinkRecordV1,
  paths: readonly string[] | undefined,
  caller: ImageCaller,
  text: string,
): Promise<Attached> {
  if (!paths || paths.length === 0) return { ok: true, text, images: [] };
  // A spawn's link carries no images either way (the other PC refuses them).
  if (link.spawned === true) return { ok: false, error: 'bad-request: a link a remote start made carries no images' };
  if (paths.length > A2A_REMOTE_IMAGE_LIMITS.PER_MESSAGE) {
    return { ok: false, error: `bad-request: at most ${A2A_REMOTE_IMAGE_LIMITS.PER_MESSAGE} images on one message` };
  }
  if (!deps.images) return { ok: false, error: 'unavailable: this PC cannot send images' };
  const features = deps.peerFeatures?.(link.remote.hostId);
  if (!features) {
    return {
      ok: false,
      error:
        'unavailable: the other PC has not connected to this one since they were paired, so it is not known whether its wmux takes images; ' +
        'send again once it has connected, or send without images',
    };
  }
  const n = countImages(paths.length);
  if (!features.has(A2A_FEATURE_IMAGES)) {
    return {
      ok: true,
      text: withNote(text, `[${n} omitted: the receiving PC's wmux does not take images]`),
      images: [],
      note: `The other PC's wmux does not take images: the text was sent with a note that ${n} ${paths.length === 1 ? 'was' : 'were'} omitted.`,
    };
  }
  const prepared = await deps.images.prepare(paths, caller);
  return prepared.ok ? { ok: true, text, images: prepared.images } : prepared;
}

function withNote(text: string, note: string): string {
  return text ? `${text}\n\n${note}` : note;
}

function countImages(n: number): string {
  return n === 1 ? '1 image' : `${n} images`;
}

function imagesField(images: readonly A2aRemoteImageRef[]): { images?: A2aRemoteImageRef[] } {
  return images.length > 0 ? { images: [...images] } : {};
}

function bodyError(text: string, hasImages = false): string | null {
  if (typeof text !== 'string' || (text.length === 0 && !hasImages)) return 'bad-request: empty message';
  return Buffer.byteLength(text, 'utf8') > A2A_REMOTE_BODY_MAX ? 'too-large' : null;
}

function mint(deps: Pick<OutboundDeps, 'mintId'>): string {
  return (deps.mintId ?? ((): string => crypto.randomUUID()))();
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
