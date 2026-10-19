// ─── Rooms for the phone — read-only, over the desktop bridge ──────────────
//
// The agent factory's rooms live in Electron main (factory/rooms/<ws>.jsonl).
// The daemon has no copy: `GET /api/rooms/:workspaceId/threads` and
// `GET /api/rooms/:workspaceId/cards` ask main over the desktop bridge with
// the two named commands below, and main answers from its RoomWriter
// (main/phone/PhoneFactory.ts).
//
// This module is the allowlist for that reply, used on both sides: main
// projects with it and the daemon parses what main forwarded with it. A
// field not listed here never reaches the phone; a card that does not parse
// is dropped alone. Every card kind passes (a kind is a well-formed name,
// not one from a list): a client draws a kind it does not know by its title
// and body. The bridge drops a reply over 128 KiB, so main fits every page to
// PHONE_ROOM_LIMITS.replyBytes.

import { BOT_ID_RE } from './bot';
import { APPROVAL_ID_RE } from './botApproval';
import { isBotSecretName } from './botSecret';
import { parseThreadId, ROOM_LIMITS, type CardKind, type RoomCard, type ThreadId, type ThreadStatus, type ThreadSummary } from './room';
import { PHONE_BOT_ROLES, clampSidebarString, type PhoneBotRole } from './phoneFleetSidebar';
import { PHONE_NOTICE_ARG_MAX, PHONE_ROOM_NOTICE_CODES } from './phoneRoomNotices';
import { parseRoomAttachments, type RoomAttachment } from './roomAttachments';

/** Bridge commands; `workspaces.` routes them through main's PhoneWorkspaces. */
export const PHONE_ROOM_THREADS_COMMAND = 'workspaces.roomThreads';
export const PHONE_ROOM_CARDS_COMMAND = 'workspaces.roomCards';
/** `{workspaceId, attachmentId}` → `{attachment: {mediaType, bytes}}` when a
 *  kept owner card of that room carries the photo, else `{notFound: true}`.
 *  The daemon then reads the stored copy from disk itself: a photo never
 *  rides the bridge (its replies are capped at 128 KiB). */
export const PHONE_ROOM_ATTACHMENT_COMMAND = 'workspaces.roomAttachment';

export const PHONE_ROOM_LIMITS = {
  /** Threads one list carries (open questions first, as the room sorts them). */
  threads: 100,
  /** Cards per page when `limit` is omitted, and the most a page holds. */
  pageDefault: 50,
  pageMax: ROOM_LIMITS.PAGE,
  /** Serialized reply budget: under the bridge's 128 KiB, with room for the envelope. */
  replyBytes: 112 * 1024,
  title: ROOM_LIMITS.TITLE_MAX,
  body: ROOM_LIMITS.CARD_BODY_MAX,
  name: 64,
  ref: 200,
  url: 500,
} as const;

/** The room's own workspace-id rule (main/factory/roomWriter.ts). */
const ROOM_WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const CARD_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isPhoneRoomWorkspaceId(value: unknown): value is string {
  return typeof value === 'string' && ROOM_WORKSPACE_ID_RE.test(value) && value !== '.' && value !== '..';
}

/** A card kind as the phone sees it: one of CardKind today, and any later
 *  kind passes too (the client draws an unknown one generically). */
export type PhoneRoomCardKind = CardKind | (string & Record<never, never>);

/** A kind name: what CardKind's names look like, so a later kind passes. */
const CARD_KIND_RE = /^[a-z][a-z0-9_]{0,39}$/;

function cardKind(value: unknown): PhoneRoomCardKind | undefined {
  return typeof value === 'string' && CARD_KIND_RE.test(value) ? value : undefined;
}

const THREAD_STATUSES: readonly ThreadStatus[] = ['open', 'quiet', 'closed'];

export type PhoneRoomActor =
  | { kind: 'bot'; botId: string; role?: PhoneBotRole; name?: string }
  | { kind: 'human' }
  | { kind: 'system' };

export interface PhoneRoomRefs {
  pr?: number;
  issue?: number;
  headSha?: string;
  taskId?: string;
  botId?: string;
  handoffId?: string;
  check?: string;
  factId?: string;
  decisionId?: string;
  /** An `approval` card's request (shared/phoneBotApprovals.ts). */
  approvalId?: string;
  url?: string;
  /** The bots the card is addressed to (an owner message's addressees, a
   *  bot card's mentions). */
  botIds?: string[];
  /** The subject's thread when the card sits in another one (an `approval`
   *  card in `general` links its PR's thread). */
  threadId?: ThreadId;
  /** A `routine` card's routine. */
  routineId?: string;
  /** A `secret_request` card: the env name asked for, never a value. */
  secretName?: string;
  /** A `login_request` card: the service (`github`, `website`, …). */
  label?: string;
}

/** One card as the phone sees it: no other workspace's ids, and no
 *  idempotency key except the clientMessageId a phone sent an owner card under. */
export interface PhoneRoomCard {
  id: string;
  seq: number;
  threadId: ThreadId;
  kind: PhoneRoomCardKind;
  at: number;
  actor: PhoneRoomActor;
  title: string;
  body?: string;
  refs?: PhoneRoomRefs;
  state?: 'open' | 'resolved';
  replyTo?: string;
  closes?: true;
  /** A `question` card that is the bot's greeting question (asked in its
   *  first wake); it closes once the bot has a job. */
  greeting?: true;
  /** An owner (`human`) card a phone sent only: the clientMessageId it was
   *  sent under, so the app can find its own message. */
  clientMessageId?: string;
  /** A system card's stable code and values (shared/phoneRoomNotices.ts),
   *  for a published code only; `title` keeps the English text. */
  notice?: PhoneRoomNotice;
  /** An `approval` card only: the act its request asks for (`merge`,
   *  `comment`, …, `skill`; any later name passes). */
  approvalAction?: string;
  /** An owner (`human`) card only: the photos sent with it, drawn from
   *  `GET /api/rooms/:workspaceId/attachments/:id`. */
  attachments?: PhoneRoomAttachment[];
}

/** A photo as the phone sees it: no upload name, no path. */
export type PhoneRoomAttachment = Omit<RoomAttachment, 'upload'>;

export interface PhoneRoomNotice {
  code: string;
  args?: Record<string, string | number>;
}

export type PhoneRoomThread = Omit<ThreadSummary, 'lastKind'> & { lastKind: PhoneRoomCardKind };

export interface PhoneRoomThreadsReply {
  workspaceId: string;
  threads: PhoneRoomThread[];
  /** More threads exist than PHONE_ROOM_LIMITS.threads. */
  truncated?: true;
}

export interface PhoneRoomCardsReply {
  workspaceId: string;
  /** The thread read, or null for the whole room. */
  threadId: ThreadId | null;
  cards: PhoneRoomCard[];
  /** Pass back as `sinceSeq` for the next page. */
  nextSinceSeq: number;
  /** More cards follow `nextSinceSeq`. */
  hasMore: boolean;
}

// ── Sanitizers (both sides) ────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function seqNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** A card id as the phone may see it, or undefined. */
export function cardId(value: unknown): string | undefined {
  return typeof value === 'string' && CARD_ID_RE.test(value) ? value : undefined;
}

function line(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? clampSidebarString(value, max) : undefined;
}

// Bidi overrides and isolates can reorder what is drawn; C0 controls other
// than tab and newline, DEL and C1 break renderers. Markdown keeps its lines.
// eslint-disable-next-line no-control-regex
const BODY_UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

function body(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let out = value.replace(BODY_UNSAFE, '');
  if (out.length > PHONE_ROOM_LIMITS.body) {
    out = out.slice(0, PHONE_ROOM_LIMITS.body);
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  }
  return out.trim() ? out : undefined;
}

/** An http(s) URL of at most PHONE_ROOM_LIMITS.url characters, or undefined. */
export function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > PHONE_ROOM_LIMITS.url) return undefined;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? value : undefined;
  } catch {
    return undefined;
  }
}

const own = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** An arg string: no control characters but newline (a list's separator),
 *  at most PHONE_NOTICE_ARG_MAX characters. */
function noticeString(value: string): string {
  // eslint-disable-next-line no-control-regex
  let out = value.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '');
  if (out.length > PHONE_NOTICE_ARG_MAX) {
    out = out.slice(0, PHONE_NOTICE_ARG_MAX);
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  }
  return out;
}

/** A notice as the phone may see it: a published code, and only that code's
 *  args, each of its type. Undefined otherwise. Idempotent. */
export function parsePhoneRoomNotice(value: unknown): PhoneRoomNotice | undefined {
  if (!isRecord(value) || typeof value.code !== 'string' || !own(PHONE_ROOM_NOTICE_CODES, value.code)) return undefined;
  const spec = PHONE_ROOM_NOTICE_CODES[value.code].args;
  const args: Record<string, string | number> = {};
  if (isRecord(value.args)) {
    for (const [key, v] of Object.entries(value.args)) {
      if (!own(spec, key)) continue;
      if (spec[key] === 'number' && typeof v === 'number' && Number.isFinite(v)) args[key] = v;
      else if (spec[key] === 'string' && typeof v === 'string') args[key] = noticeString(v);
    }
  }
  return Object.keys(args).length > 0 ? { code: value.code, args } : { code: value.code };
}

/** An approval request's action name: what ApprovalAction's names look
 *  like, so a later action passes (the client treats one it does not know
 *  as approved on the desktop only). */
const APPROVAL_ACTION_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** A card's actor as the phone may see it, or undefined. Idempotent. */
export function parsePhoneRoomActor(value: unknown): PhoneRoomActor | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'human') return { kind: 'human' };
  if (value.kind === 'system') return { kind: 'system' };
  if (value.kind !== 'bot') return undefined;
  const botId = cardId(value.botId);
  if (!botId) return undefined;
  const role = (PHONE_BOT_ROLES as readonly unknown[]).includes(value.role) ? value.role as PhoneBotRole : undefined;
  const name = line(value.name, PHONE_ROOM_LIMITS.name);
  return { kind: 'bot', botId, ...(role ? { role } : {}), ...(name ? { name } : {}) };
}

function parseRefs(value: unknown): PhoneRoomRefs | undefined {
  if (!isRecord(value)) return undefined;
  const out: PhoneRoomRefs = {};
  const pr = positive(value.pr);
  if (pr !== undefined) out.pr = pr;
  const issue = positive(value.issue);
  if (issue !== undefined) out.issue = issue;
  for (const key of ['headSha', 'taskId', 'botId', 'handoffId', 'check', 'factId', 'decisionId', 'routineId', 'label'] as const) {
    const v = line(value[key], PHONE_ROOM_LIMITS.ref);
    if (v !== undefined) out[key] = v;
  }
  if (typeof value.approvalId === 'string' && APPROVAL_ID_RE.test(value.approvalId)) out.approvalId = value.approvalId;
  const url = httpUrl(value.url);
  if (url !== undefined) out.url = url;
  if (Array.isArray(value.botIds)) {
    const ids = [...new Set(value.botIds.filter((id): id is string => typeof id === 'string' && BOT_ID_RE.test(id)))].slice(0, ROOM_LIMITS.MENTIONS_MAX);
    if (ids.length > 0) out.botIds = ids;
  }
  const linked = parseThreadId(value.threadId);
  if (linked) out.threadId = linked;
  if (isBotSecretName(value.secretName)) out.secretName = value.secretName;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A card as the phone may see it, or null when it is not one. Idempotent. */
export function parsePhoneRoomCard(value: unknown): PhoneRoomCard | null {
  if (!isRecord(value)) return null;
  const id = cardId(value.id);
  const seq = seqNumber(value.seq);
  const threadId = parseThreadId(value.threadId);
  const kind = cardKind(value.kind);
  const at = positive(value.at);
  const actor = parsePhoneRoomActor(value.actor);
  const title = line(value.title, PHONE_ROOM_LIMITS.title) ?? '';
  if (!id || seq === undefined || !threadId || !kind || at === undefined || !actor) return null;
  const text = body(value.body);
  const refs = parseRefs(value.refs);
  const replyTo = cardId(value.replyTo);
  const clientMessageId = kind === 'human' && actor.kind === 'human' ? phoneMessageId(value.clientMessageId) : undefined;
  const notice = actor.kind === 'system' ? parsePhoneRoomNotice(value.notice) : undefined;
  const approvalAction = kind === 'approval' && typeof value.approvalAction === 'string' && APPROVAL_ACTION_RE.test(value.approvalAction) ? value.approvalAction : undefined;
  const attachments = kind === 'human' && actor.kind === 'human' ? parseRoomAttachments(value.attachments, { keepUpload: false }) : undefined;
  return {
    id, seq, threadId, kind, at, actor, title,
    ...(text !== undefined ? { body: text } : {}),
    ...(refs ? { refs } : {}),
    ...(value.state === 'open' || value.state === 'resolved' ? { state: value.state } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(value.closes === true ? { closes: true as const } : {}),
    ...(value.greeting === true && kind === 'question' ? { greeting: true as const } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(notice ? { notice } : {}),
    ...(approvalAction ? { approvalAction } : {}),
    ...(attachments ? { attachments } : {}),
  };
}

/** A thread summary as the phone may see it, or null. Idempotent. */
export function parsePhoneRoomThread(value: unknown): PhoneRoomThread | null {
  if (!isRecord(value)) return null;
  const threadId = parseThreadId(value.threadId);
  const lastAt = seqNumber(value.lastAt);
  const lastSeq = seqNumber(value.lastSeq);
  const cardCount = seqNumber(value.cardCount);
  const openQuestions = seqNumber(value.openQuestions);
  const lastKind = cardKind(value.lastKind);
  const status = (THREAD_STATUSES as readonly unknown[]).includes(value.status) ? value.status as ThreadStatus : undefined;
  const unread = value.unread === null ? null : seqNumber(value.unread);
  if (!threadId || lastAt === undefined || lastSeq === undefined || cardCount === undefined || openQuestions === undefined ||
      !lastKind || !status || unread === undefined) return null;
  return {
    threadId,
    title: line(value.title, PHONE_ROOM_LIMITS.title) ?? '',
    lastAt, lastSeq, cardCount, openQuestions, lastKind, status, unread,
  };
}

/** Main's threads reply as the daemon serves it, or null when it is not one. */
export function parsePhoneRoomThreadsReply(value: unknown, workspaceId: string): PhoneRoomThreadsReply | null {
  if (!isRecord(value) || value.workspaceId !== workspaceId || !Array.isArray(value.threads)) return null;
  const threads: PhoneRoomThread[] = [];
  const seen = new Set<string>();
  for (const raw of value.threads.slice(0, PHONE_ROOM_LIMITS.threads)) {
    const t = parsePhoneRoomThread(raw);
    if (!t || seen.has(t.threadId)) continue;
    seen.add(t.threadId);
    threads.push(t);
  }
  const truncated = value.truncated === true || value.threads.length > PHONE_ROOM_LIMITS.threads;
  return { workspaceId, threads, ...(truncated ? { truncated: true as const } : {}) };
}

/** Main's cards reply as the daemon serves it, or null when it is not one.
 *  Cards are kept in seq order and must belong to the thread asked for. */
export function parsePhoneRoomCardsReply(value: unknown, workspaceId: string, threadId: ThreadId | null): PhoneRoomCardsReply | null {
  if (!isRecord(value) || value.workspaceId !== workspaceId || !Array.isArray(value.cards)) return null;
  if ((value.threadId ?? null) !== threadId) return null;
  const nextSinceSeq = seqNumber(value.nextSinceSeq);
  if (nextSinceSeq === undefined || typeof value.hasMore !== 'boolean') return null;
  const cards: PhoneRoomCard[] = [];
  let last = -1;
  for (const raw of value.cards.slice(0, PHONE_ROOM_LIMITS.pageMax)) {
    const c = parsePhoneRoomCard(raw);
    if (!c || c.seq <= last || (threadId !== null && c.threadId !== threadId)) continue;
    last = c.seq;
    cards.push(c);
  }
  return { workspaceId, threadId, cards, nextSinceSeq, hasMore: value.hasMore };
}

// ── Main's side ────────────────────────────────────────────────────────────

/** The id a phone sent a message under, or undefined. */
function phoneMessageId(value: unknown): string | undefined {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length <= ROOM_LIMITS.CLIENT_ID_MAX && /^[^\u0000-\u001f]+$/.test(value) ? value : undefined;
}

/** A phone message's card is posted as `phone:<caller hash>:<clientMessageId>`
 *  (factoryWiring.factoryPhoneMessage); the phone sees only its own part. */
const PHONE_POST_ID = /^phone:[0-9a-f]{16}:(.+)$/s;

/** A room card projected for the phone; `bot` resolves an actor's role and
 *  name, `approvalAction` an `approval` card's request's action. */
export function phoneRoomCard(
  card: RoomCard,
  bot: (botId: string) => { role: PhoneBotRole; name: string } | null,
  approvalAction?: (approvalId: string) => string | null,
): PhoneRoomCard | null {
  const actor = card.actor.kind === 'bot'
    ? (() => {
        const info = bot(card.actor.botId);
        return { kind: 'bot' as const, botId: card.actor.botId, ...(info ? { role: info.role, name: info.name } : {}) };
      })()
    : { kind: card.actor.kind };
  const { clientPostId, ...rest } = card;
  const sent = clientPostId ? PHONE_POST_ID.exec(clientPostId)?.[1] : undefined;
  const approvalId = card.kind === 'approval' ? card.refs?.approvalId : undefined;
  const action = approvalId && approvalAction ? approvalAction(approvalId) : null;
  return parsePhoneRoomCard({ ...rest, actor, ...(sent ? { clientMessageId: sent } : {}), ...(action ? { approvalAction: action } : {}) });
}

const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

/**
 * The largest page under the reply budget. A forward page (`sinceSeq`) keeps
 * its oldest cards and says `hasMore` with `nextSinceSeq` at the last one
 * kept; the newest page (no `sinceSeq`) keeps its newest cards. At least one
 * card always stays: one card is far under the budget.
 */
export function fitPhoneRoomPage(reply: PhoneRoomCardsReply, forward: boolean, budget: number = PHONE_ROOM_LIMITS.replyBytes): PhoneRoomCardsReply {
  if (bytes(reply) <= budget || reply.cards.length <= 1) return reply;
  const envelope = bytes({ ...reply, cards: [] });
  const sizes = reply.cards.map((c) => bytes(c) + 1);
  let total = envelope;
  let keep = 0;
  if (forward) {
    while (keep < sizes.length && total + sizes[keep] <= budget) total += sizes[keep++];
    const cards = reply.cards.slice(0, Math.max(1, keep));
    return { ...reply, cards, nextSinceSeq: cards[cards.length - 1].seq, hasMore: true };
  }
  while (keep < sizes.length && total + sizes[sizes.length - 1 - keep] <= budget) total += sizes[sizes.length - 1 - keep++];
  return { ...reply, cards: reply.cards.slice(sizes.length - Math.max(1, keep)) };
}

/**
 * The thread list under the count and byte budgets: threads are dropped from
 * the end of the room's order (`truncated` says so), and `general` is always
 * kept, whatever its rank.
 */
export function fitPhoneRoomThreads(reply: PhoneRoomThreadsReply, budget: number = PHONE_ROOM_LIMITS.replyBytes): PhoneRoomThreadsReply {
  const general = reply.threads.find((t) => t.threadId === 'general');
  const others = reply.threads.filter((t) => t.threadId !== 'general');
  let keep = Math.min(others.length, PHONE_ROOM_LIMITS.threads - (general ? 1 : 0));
  const build = (n: number): PhoneRoomThreadsReply => {
    const kept = others.slice(0, n);
    const threads = general ? [...kept, general].sort((a, b) => reply.threads.indexOf(a) - reply.threads.indexOf(b)) : kept;
    return { workspaceId: reply.workspaceId, threads, ...(reply.truncated || n < others.length ? { truncated: true as const } : {}) };
  };
  let out = build(keep);
  while (keep > 0 && bytes(out) > budget) out = build(--keep);
  return out;
}
