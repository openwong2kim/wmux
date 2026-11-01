// === Cross-host A2A — local delivery layer (daemon <-> main <-> renderer) ===
//
// The wire contract between hosts is `a2aRemote.ts`. This file pins the
// shapes that stay INSIDE one host: the daemon RPCs main calls, the event the
// daemon broadcasts when a remote task lands, the synthetic workspace id a
// remote pane is represented by in the task ledger, and what the renderer
// answers for a remote-task delivery.
//
// Pure module: no node:* imports (the renderer imports it).

import { A2A_BRAIN_ALIAS, isRemoteTaskId, type A2aEndpointKind, type A2aRemoteReceipt, type A2aRemoteTaskMarkerV1, type HostId } from './a2aRemote';
import type { GatedSubmitRefusal } from './ptyMessageDelivery';
import { isTaskState, type Part, type Task, type TaskState } from './types';

/**
 * Daemon RPC method names for the delivery layer. Registered in the daemon's
 * RPC table by the wiring step; every handler is a thin parse around the
 * functions in `src/daemon/a2aRemote/{inbound,outbound}.ts` and
 * `A2aTaskService`.
 */
export const A2A_REMOTE_RPC = Object.freeze({
  /** → `{ tasks: Task[] }` — `A2aTaskService.listRemotePending()`. */
  pending: 'a2a.remote.pending',
  /** `{ taskId, delivered?: true, held?: reason }` → `{ ok: true } | { ok: false, error }`. */
  mark: 'a2a.remote.mark',
  /** → `{ targets: A2aRemoteTarget[] }` — every ACTIVE link, as an addressable alias. */
  targets: 'a2a.remote.targets',
  /** `A2aRemoteSendTaskInput` → `{ ok: true, taskId } | { ok: false, error }`. */
  sendTask: 'a2a.remote.sendTask',
  /** `A2aRemoteReplyInput` → `{ ok: true, taskId } | { ok: false, error }`. */
  reply: 'a2a.remote.reply',
  /** `A2aRemoteStateInput` → `{ ok: true } | { ok: false, error }`. */
  state: 'a2a.remote.state',
  /** → `{ tasks: Task[] }` — `A2aTaskService.listRemoteHeld()` (for a person to decide). */
  held: 'a2a.remote.held',
  /** `{ taskId, reason }` → `{ ok: true } | { ok: false, error }` — `rejectHeld`. */
  rejectHeld: 'a2a.remote.rejectHeld',
  /**
   * `{ taskId, workspaceId }` → `{ ok: true } | { ok: false, error }`: the
   * receiver of an inbound task read it (a2a_task_query); the sender gets a
   * `read` receipt.
   */
  read: 'a2a.remote.read',
  /**
   * `{ paths: string[], ptyId?, workspaceId? }` → `{ ok: true, images: A2aStagedImage[] } | { ok: false, error }`:
   * an agent's images for a pane on this PC, checked (the folders of `ptyId`
   * when it is a live terminal of `workspaceId`, else `~/.wmux/uploads`
   * only), stripped and kept in `~/.wmux/uploads/a2a/local`.
   */
  stageImages: 'a2a.attachments.stage',
} as const);

/** One image `A2A_REMOTE_RPC.stageImages` kept: `path` is what the receiving agent reads. */
export interface A2aStagedImage {
  path: string;
  sha256: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  /** The source file's name. */
  name: string;
}

/**
 * Renderer method main's RemoteA2aBridge calls for one reply/state item the
 * peer sent (`{ task, messageId, resnapshot? }` → `A2aRemoteDeliveryResult`).
 * Never registered on the pipe router: only main calls it.
 */
export const A2A_REMOTE_NOTIFY_METHOD = 'a2a.remote.notify';

/** Daemon broadcast when an inbound remote task was written to the ledger. */
export const A2A_REMOTE_INBOUND_EVENT = 'a2a.remote.inbound';

export interface A2aRemoteInboundEvent {
  type: typeof A2A_REMOTE_INBOUND_EVENT;
  taskId: string;
}

// ─── Synthetic workspace id ─────────────────────────────────────────────────

/**
 * A remote pane appears in the task ledger as workspace `remote:<linkId>`.
 * Local workspace ids are `ws-…`, so the two never collide, and the ordinary
 * "only the receiver workspace moves a task" rule applies to the peer as is.
 */
export const REMOTE_WORKSPACE_PREFIX = 'remote:';

export function remoteWorkspaceId(linkId: string): string {
  return REMOTE_WORKSPACE_PREFIX + linkId;
}

export function isRemoteWorkspaceId(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(REMOTE_WORKSPACE_PREFIX) && v.length > REMOTE_WORKSPACE_PREFIX.length;
}

/**
 * The address an agent uses for a remote pane: `<PC name>/<workspace>/<pane>`.
 * A '/' inside a part becomes '-', so the alias always splits into exactly
 * three parts and one part can never impersonate two.
 */
export function remoteAlias(hostName: string, workspaceName: string, paneLabel: string): string {
  return [hostName, workspaceName, paneLabel].map((p) => aliasPart(p)).join('/');
}

/**
 * One alias part: printable characters only (letters, marks, digits,
 * punctuation, symbols, plain spaces), '/' as '-', bounded. A remote name
 * can never carry a control character or an escape into an agent's prompt.
 */
export function aliasPart(raw: string): string {
  const kept = [...raw].filter((ch) => /[\p{L}\p{M}\p{N}\p{P}\p{S} ]/u.test(ch)).join('');
  return kept.replace(/\//g, '-').replace(/ {2,}/g, ' ').trim().slice(0, 64) || '?';
}

/**
 * Text a peer sent, made safe to paste into a terminal: ESC-introduced
 * sequences (CSI, OSC — e.g. OSC 52 clipboard writes —, DCS/SOS/PM/APC and
 * any other ESC pair, including the bracketed-paste end `ESC[201~`) are
 * removed, CR becomes a newline (no overwritten-line forgery), and every
 * other C0/C1 control and DEL is dropped. `\n` and `\t` stay. Applied where
 * the text is received AND again right before a pane write.
 */
export function sanitizeRemoteText(raw: string): string {
  return raw
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b[PX^_][\s\S]*?(?:\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]?/g, '')
    .replace(/\x9b[0-?]*[ -/]*[@-~]?/g, '')
    .replace(/\x9d[\s\S]*?(?:\x07|\x9c|$)/g, '')
    .replace(/\x1b[\s\S]?/g, '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- stripping controls is the point
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/**
 * A message body a peer sent, as `sanitizeRemoteText` makes it, and with no
 * line that starts like wmux's own lines (`[wmux] ...`, the image footer):
 * such a line is quoted (`> [wmux] ...`), also where a single-line pane shows
 * a newline as ␤. So a footer naming paths is always this PC's.
 */
export function sanitizeRemoteMessage(raw: string): string {
  return quoteWmuxLines(sanitizeRemoteText(raw));
}

/**
 * Quote (`> `) every line of `text` that reads as starting with `[wmux]`:
 * judged with format characters (zero-width, bidi) removed and NFKC applied
 * (fullwidth brackets and letters), after any whitespace or space separator.
 * Lines are split at newlines and at ␤, a single-line pane's newline.
 */
export function quoteWmuxLines(text: string): string {
  return text
    .split(/(\n|␤)/)
    .map((part, i) => (i % 2 === 0 && /^[\s\p{Z}]*\[wmux\]/iu.test(part.replace(/\p{Cf}/gu, '').normalize('NFKC')) ? `> ${part}` : part))
    .join('');
}

// ─── Daemon RPC payloads ────────────────────────────────────────────────────

/** One active link, as main sees it for alias addressing and discovery. */
export interface A2aRemoteTarget {
  alias: string;
  linkId: string;
  hostId: HostId;
  /** Both ends' kind (`isAllowedEndpointPair`: always the same on a link). */
  kind: A2aEndpointKind;
  /**
   * The local end bound to the link: the only sender on it. A pane end has a
   * `paneId`; a brain end (this PC's Moa) has none.
   */
  local: { workspaceId: string; paneId?: string };
  remote: { workspaceId: string; paneId?: string; label?: string };
  /** `link.allow.outbound`: this side may start new tasks on the link. */
  allowOutbound: boolean;
}

export interface A2aRemoteSendTaskInput {
  linkId: string;
  /**
   * The verified sender: the link's local pane and its pty now, or — on a
   * brain link — this PC's Moa (its HQ workspace, no pane).
   */
  from: { workspaceId: string; name: string; paneId?: string; ptyId?: string };
  title: string;
  text: string;
  /** Absolute paths of images to attach (`images.1`); read from the sender pane's folders only. */
  images?: string[];
}

export interface A2aRemoteReplyInput {
  taskId: string;
  /** The caller's workspace: must be the task's LOCAL side. */
  workspaceId: string;
  text: string;
  /** Absolute paths of images to attach, as on a new task. */
  images?: string[];
  /**
   * The caller's pane, as main verified it: whose folders `images` may come
   * from. Absent (no verified pane): only `~/.wmux/uploads`.
   */
  ptyId?: string;
}

export interface A2aRemoteStateInput {
  taskId: string;
  state: 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';
  /** Free text for the peer's ledger (e.g. the evidence summary). */
  summary?: string;
}

// ─── Delivery state on the ledger marker ─────────────────────────────────────

export type A2aRemoteHeldReason = NonNullable<A2aRemoteTaskMarkerV1['held']>;

/** Hold reasons earlier versions wrote for this PC's Moa, which is gone. */
const LEGACY_MOA_HELD_REASONS: ReadonlySet<string> = new Set(['brain-unavailable', 'brain-delivery-pending']);

/**
 * A hold reason as stored or sent by any version. A Moa hold is still
 * accepted (an older main, an older daemon log) and read as
 * `link-not-active`: the Moa link it waited on has ended, so it waits on a
 * person like any other hold.
 */
export function readHeldReason(held: string): A2aRemoteHeldReason {
  return LEGACY_MOA_HELD_REASONS.has(held) ? 'link-not-active' : (held as A2aRemoteHeldReason);
}

/**
 * Why a pane whose agent IS there could not take a delivery just now: its
 * agent is showing a prompt or dialog (an Enter would answer it), or a person
 * is typing in it. Not a hold: the delivery keeps retrying and goes in once
 * that clears. Main tells the daemon (`waiting` on the mark RPC), which tells
 * the sender once. An older daemon ignores the field.
 */
export type A2aRemoteWaitingCause = 'agent-prompt' | 'user-typing';

/**
 * What one "written nowhere" answer from the renderer says about the pane:
 * no agent there (`no_agent_pane`, the only answer that may end in a hold),
 * an agent there that is waiting (a cause), or nothing either way (`retry`:
 * the delivery stays on the retry path).
 */
export type A2aRemoteMissKind = 'no-agent' | A2aRemoteWaitingCause | 'retry';

/** Every gated refusal, decided here: a new one fails the type check until it is. */
const GATED_MISS: Readonly<Record<GatedSubmitRefusal['reason'], A2aRemoteWaitingCause | 'retry'>> = {
  approval_pending: 'agent-prompt',
  user_typing: 'user-typing',
  // The agent may well be there; none of these says it is gone.
  gate_unavailable: 'retry',
  write_failed: 'retry',
  fresh_context_timeout: 'retry',
  fresh_context_busy: 'retry',
  usage_limited: 'retry',
  agent_changed: 'retry',
  agent_unverified: 'retry',
  deadline: 'retry',
  guard_refused: 'retry',
};

/** The miss kind of a renderer `reason` (anything unknown is `retry`). */
export function missKindOf(reason: unknown): A2aRemoteMissKind {
  if (reason === 'no_agent_pane') return 'no-agent';
  return typeof reason === 'string' && Object.hasOwn(GATED_MISS, reason) ? GATED_MISS[reason as GatedSubmitRefusal['reason']] : 'retry';
}

export function isWaitingCause(v: unknown): v is A2aRemoteWaitingCause {
  return v === 'agent-prompt' || v === 'user-typing';
}

/** True for a hold reason only earlier versions wrote (a Moa hold). */
export function isLegacyHeldReason(held: string): boolean {
  return LEGACY_MOA_HELD_REASONS.has(held);
}

/**
 * One message the peer sent into an existing task (a reply, or a state
 * change), owed a delivery to our local pane: replies are written to the
 * pane, states are announced on the event bus. Exactly once per `messageId`.
 */
export interface A2aRemoteInboxItem {
  messageId: string;
  kind: 'reply' | 'state';
  /** For a 'state' item: the state the peer moved the task to. */
  state?: TaskState;
  /** For a 'state' item: the peer's `completed`, held here as a report (the task is input-required). */
  reported?: true;
  delivered?: boolean;
  held?: A2aRemoteHeldReason;
  /** When it was first held (the 24 h hold TTL counts from here). */
  heldAt?: string;
  note?: 'pasted-not-submitted';
  /** main started a paste and has not confirmed it yet. */
  attempted?: boolean;
}

/**
 * What the daemon keeps under `Task.metadata.remote`: the v1 contract marker
 * plus local delivery bookkeeping (never sent over the wire).
 */
export type A2aRemoteTaskState = A2aRemoteTaskMarkerV1 & {
  /** Inbound task: main started a paste and has not confirmed it yet. */
  attempted?: boolean;
  /** The last task state exchanged with the peer (sent, or applied from it). */
  stateSync?: TaskState;
  /** Our own replies on this task already queued for the peer (messageIds). */
  sent?: string[];
  /** Inbound task: when our side first read it (a2a_task_query). */
  readAt?: string;
  /** Inbound task: the furthest receipt already queued for the peer. */
  receiptSync?: A2aRemoteReceipt;
  /** Outbound task: when the peer said it handed the task over / its agent read it. */
  remoteDeliveredAt?: string;
  remoteReadAt?: string;
  /**
   * Either side: when the other PC had received (transport-acked) every
   * reply and state change this side queued on the task. Cleared when a new
   * one is queued, set again once that one is acked (#1922). A receipt of
   * arrival, not of the other side applying it.
   */
  replyDeliveredAt?: string;
  /** Inbound task: its paste stayed in the composer; counted as delivered. */
  note?: 'pasted-not-submitted';
  /** Inbound task: when it was first held. */
  heldAt?: string;
  inbox?: A2aRemoteInboxItem[];
};

/** A hold older than this is rejected automatically (`held-expired`). */
export const A2A_REMOTE_HOLD_TTL_MS = 24 * 60 * 60 * 1000;

/** The local side of a remote task: the party whose workspace is not `remote:`. */
export function localSideOf(task: Pick<Task, 'metadata'>): 'from' | 'to' {
  return isRemoteWorkspaceId(task.metadata.from.workspaceId) ? 'to' : 'from';
}

// ─── Renderer delivery result ───────────────────────────────────────────────

/**
 * What the renderer answers main's bridge for one remote-task delivery.
 *   - `delivered`: written to the pinned pane (or already was: `duplicate`).
 *   - `held`: refused for a reason that must not be retried blindly — the
 *     pane is gone, or another occupant holds it now. Never re-routed.
 *   - neither: not written this time (approval prompt, person typing, no
 *     agent in the pane); the bridge may try again later. `reason` says
 *     which (`missKindOf`).
 */
export type A2aRemoteDeliveryResult =
  | { ok: true; delivered: true; duplicate?: boolean; ptyId?: string; note?: 'pasted-not-submitted' }
  | { ok: true; delivered: false; held?: A2aRemoteHeldReason; reason?: string }
  | { ok?: false; error: string };

// ─── Moa panel: work exchanged with other PCs' Moa ─────────────────────────

/** One task between this PC's Moa and another PC's Moa, for the Moa panel. */
export interface MoaRemoteTask {
  taskId: string;
  title: string;
  state: TaskState;
  /** `sent`: this Moa asked; `received`: the other PC's Moa asked. */
  direction: 'sent' | 'received';
  /** The other PC's name. */
  host: string;
  updatedAt?: string;
  /** `sent` only: how far the other Moa got (its receipts). */
  receipt?: A2aRemoteReceipt;
}

/** The Moa panel lists at most this many, newest first. */
export const MOA_REMOTE_TASKS_MAX = 20;

/**
 * Pick the Moa-to-Moa tasks out of the HQ's task summaries (`a2a.task.query`
 * page view), newest first. One side is named `Moa` and the other `<PC>/Moa` —
 * a remote pane's alias always has three parts, so a pane task never matches.
 */
export function moaRemoteTasks(summaries: readonly unknown[]): MoaRemoteTask[] {
  const out: MoaRemoteTask[] = [];
  const peerHost = (name: unknown): string | null => {
    if (typeof name !== 'string') return null;
    const parts = name.split('/');
    return parts.length === 2 && parts[1] === A2A_BRAIN_ALIAS && parts[0] ? parts[0] : null;
  };
  for (const raw of summaries) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    if (!isRemoteTaskId(t.id) || !isTaskState(t.state)) continue;
    const sentTo = t.from === A2A_BRAIN_ALIAS ? peerHost(t.to) : null;
    const receivedFrom = t.to === A2A_BRAIN_ALIAS ? peerHost(t.from) : null;
    const host = sentTo ?? receivedFrom;
    if (!host) continue;
    out.push({
      taskId: t.id,
      title: typeof t.title === 'string' ? t.title : '',
      state: t.state,
      direction: sentTo ? 'sent' : 'received',
      host,
      ...(typeof t.updatedAt === 'string' ? { updatedAt: t.updatedAt } : {}),
      ...(sentTo && (t.remoteReceipt === 'delivered' || t.remoteReceipt === 'read') ? { receipt: t.remoteReceipt } : {}),
    });
  }
  // ISO-8601 sorts as text.
  return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, MOA_REMOTE_TASKS_MAX);
}

// ─── Images a delivered message carries (`images.1`, and same-PC sends) ─────

/**
 * One image of a delivered message: the receiver's own file (`path`, made on
 * this PC, never taken from a peer), or why it is not here.
 */
export interface A2aDeliveredImage {
  sha256: string;
  mediaType?: string;
  path?: string;
  notReceived?: string;
}

/** The images of a message's parts: its file parts with a hash, in order. */
export function deliveredImagesOf(parts: readonly Part[] | undefined): A2aDeliveredImage[] {
  const out: A2aDeliveredImage[] = [];
  for (const p of parts ?? []) {
    if (!p || p.kind !== 'file' || typeof p.metadata?.['sha256'] !== 'string') continue;
    const sha256 = p.metadata['sha256'];
    const mediaType = typeof p.file?.mimeType === 'string' ? { mediaType: p.file.mimeType } : {};
    const path = p.metadata['path'];
    const missing = p.metadata['notReceived'];
    if (typeof path === 'string' && path) out.push({ sha256, ...mediaType, path });
    else out.push({ sha256, ...mediaType, notReceived: typeof missing === 'string' ? missing : 'missing' });
  }
  return out;
}

/** The ledger file parts for delivered images (what `deliveredImagesOf` reads back). */
export function deliveredImageParts(images: readonly A2aDeliveredImage[]): Part[] {
  return images.map((i) => ({
    kind: 'file' as const,
    file: i.mediaType ? { mimeType: i.mediaType } : {},
    metadata: { sha256: i.sha256, ...(i.path ? { path: i.path } : { notReceived: i.notReceived ?? 'missing' }) },
  }));
}

/** A `remoteImages` / `attachments` param main handed the renderer: well-formed entries only. */
export function parseDeliveredImages(v: unknown): A2aDeliveredImage[] {
  if (!Array.isArray(v)) return [];
  const out: A2aDeliveredImage[] = [];
  for (const raw of v.slice(0, 4)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256)) continue;
    const mediaType = typeof r.mediaType === 'string' ? { mediaType: r.mediaType } : {};
    if (typeof r.path === 'string' && r.path) out.push({ sha256: r.sha256, ...mediaType, path: r.path });
    else out.push({ sha256: r.sha256, ...mediaType, notReceived: typeof r.notReceived === 'string' ? r.notReceived : 'missing' });
  }
  return out;
}

/** What a one-line nudge adds for a message with images (the paths are in a2a_task_query). */
export function imagesNudgeSuffix(images: readonly A2aDeliveredImage[]): string {
  return images.length > 0 ? ` — ${countImages(images.length)} attached` : '';
}

/** "1 image" / "3 images". */
export function countImages(n: number): string {
  return n === 1 ? '1 image' : `${n} images`;
}

/**
 * The lines a pasted message ends with, so the receiving agent can read its
 * images by path: one path per line (the pane's own spelling of it via
 * `panePath`), then how many could not be received. Empty when there are
 * none. Every path is quoted: a pane that takes one line folds the newlines
 * into `␤`, and the quotes still say where each path ends.
 */
export function imageFooter(images: readonly A2aDeliveredImage[], panePath: (path: string) => string = (p) => p): string {
  const here = images.filter((i) => i.path);
  const lost = images.length - here.length;
  const lines: string[] = [];
  if (here.length > 0) {
    lines.push(`[wmux] ${countImages(here.length)} attached, saved on this PC (read ${here.length === 1 ? 'it' : 'them'} by path):`);
    for (const i of here) lines.push(quotePath(panePath(i.path as string)));
  }
  if (lost > 0) lines.push(`[wmux] ${countImages(lost)} could not be received`);
  return lines.join('\n');
}

/** A POSIX path in single quotes, a Windows one in double quotes (which it cannot contain). */
function quotePath(p: string): string {
  return p.startsWith('/') ? `'${p.replace(/'/g, `'\\''`)}'` : `"${p}"`;
}

/** `text` with its image footer, if any. */
export function withImageFooter(text: string, images: readonly A2aDeliveredImage[], panePath?: (path: string) => string): string {
  const footer = imageFooter(images, panePath);
  if (!footer) return text;
  return text ? `${text}\n\n${footer}` : footer;
}
