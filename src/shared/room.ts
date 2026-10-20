// ─── Rooms — a workspace's timeline of typed cards ─────────────────────────
//
// A room is one workspace's timeline (`getWmuxDir()/factory/rooms/<ws>.jsonl`,
// main-owned). A thread is the room's sub-timeline for one PR, issue, task,
// handoff, plan or report, a bot's 1:1 with the owner (`dm:<botId>`), or a
// group chat the owner made (`group:<groupId>`, shared/botGroup.ts);
// `general` is the room itself. Bots write cards
// with `room.post`; facts become compact `fact` cards; an `ask_person` lands
// as a `question` card backed by a WorkspaceDecision in the same thread.

import type { FactRef } from './facts';
import type { Party } from './handoff';
import type { RoomAttachment } from './roomAttachments';
import type { RoomFile } from './roomFiles';
import { normalizeRepoKey } from './repoKey';
import { BOT_ID_RE } from './bot';

export type ThreadId =
  | `pr:${string}#${number}`
  | `issue:${string}#${number}`
  | `task:${string}`
  | `handoff:${string}`
  | `plan:${string}`
  | `report:${string}`
  /** A bot's 1:1 with the owner (`dm:<botId>`), in the bot's own room. */
  | `dm:${string}`
  /** A group chat the owner made (`group:<groupId>`), in its bots' room. */
  | `group:${string}`
  | 'general';

export const GENERAL_THREAD: ThreadId = 'general';

const OPAQUE_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** A group chat's id (shared/botGroup.ts). */
export const GROUP_ID_RE = /^grp-[0-9a-f]{8}$/;

/** A thread id from disk or the wire, or null when it is not one. A PR or
 *  issue thread comes back in its canonical spelling (the repo key
 *  normalized: `pr:Acme/App#12` is `pr:github.com/acme/app#12`), so every
 *  spelling of one PR names one thread. */
export function parseThreadId(value: unknown): ThreadId | null {
  if (value === 'general') return 'general';
  if (typeof value !== 'string' || value.length > 240) return null;
  const numbered = /^(pr|issue):(.+)#([1-9][0-9]{0,9})$/.exec(value);
  if (numbered) {
    const key = normalizeRepoKey(numbered[2]);
    const id = key ? `${numbered[1]}:${key}#${numbered[3]}` : '';
    return id && id.length <= 240 ? (id as ThreadId) : null;
  }
  const opaque = /^(task|handoff|plan|report):(.+)$/.exec(value);
  if (opaque) return OPAQUE_RE.test(opaque[2]) ? (value as ThreadId) : null;
  const dm = /^dm:(.+)$/.exec(value);
  if (dm) return BOT_ID_RE.test(dm[1]) ? (value as ThreadId) : null;
  const group = /^group:(.+)$/.exec(value);
  if (group) return GROUP_ID_RE.test(group[1]) ? (value as ThreadId) : null;
  return null;
}

/** A bot's 1:1 thread: what the owner and that bot say to each other, apart
 *  from the room's General. */
export function dmThreadId(botId: string): ThreadId {
  return `dm:${botId}`;
}

/** The bot whose 1:1 a thread is, or null when it is no 1:1 thread. */
export function dmThreadBot(threadId: unknown): string | null {
  if (typeof threadId !== 'string' || !threadId.startsWith('dm:')) return null;
  const botId = threadId.slice(3);
  return BOT_ID_RE.test(botId) ? botId : null;
}

/** A group chat's own thread (an owner-made group; a group migrated from
 *  a workspace room keeps `general`, shared/botGroup.ts). */
export function groupThreadId(groupId: string): ThreadId {
  return `group:${groupId}`;
}

/** The group whose own thread this is, or null when it is no group thread. */
export function groupThreadGroup(threadId: unknown): string | null {
  if (typeof threadId !== 'string' || !threadId.startsWith('group:')) return null;
  const groupId = threadId.slice(6);
  return GROUP_ID_RE.test(groupId) ? groupId : null;
}

/** A repo key as a thread names it (shared/repoKey.ts normalizeRepoKey) —
 *  so one PR is one thread however the key was spelled. A value that is no
 *  repo key comes back lowercased, and its thread id does not parse. */
export function threadRepoKey(repoKey: string): string {
  return normalizeRepoKey(repoKey) ?? repoKey.trim().toLowerCase();
}

export function prThreadId(repoKey: string, prNumber: number): ThreadId {
  return `pr:${threadRepoKey(repoKey)}#${prNumber}`;
}

export function issueThreadId(repoKey: string, issueNumber: number): ThreadId {
  return `issue:${threadRepoKey(repoKey)}#${issueNumber}`;
}

/** The thread a bot's wake ran in, as a task it starts records it: none for
 *  `general` (the room itself is no conversation to follow), none when it
 *  does not parse. */
export function taskOriginThread(wakeThread: unknown): ThreadId | undefined {
  const t = parseThreadId(wakeThread);
  return t && t !== GENERAL_THREAD ? t : undefined;
}

/** A fan-out task's room thread: the thread of the bot wake that started it
 *  (its ledger row's `dispatch.threadId`, written by main), else the task's
 *  own `task:<id>`. One rule for its wakes and its cards. */
export function taskThreadOf(entry: { id: string; dispatch?: { threadId?: string } }): ThreadId {
  return taskOriginThread(entry.dispatch?.threadId) ?? (`task:${entry.id}` as ThreadId);
}

export type CardKind =
  | 'fact'            // system-written from a Fact (compact)
  | 'dispatch' | 'status' | 'triage' | 'verdict' | 'report' | 'plan' | 'proposal' | 'opinion'   // bot outputs (typed)
  | 'question'        // ask_person; carries decision options; resolved inline
  | 'human'           // owner message
  | 'refusal' | 'budget'
  // Main-written, shared bot surface:
  | 'approval'        // an approval request (refs.approvalId) with Approve / Deny / Always allow
  | 'routine'         // a bot created or changed a routine (refs.routineId)
  | 'secret_request'  // a bot asks for a named secret (refs.secretName); [Enter] opens the modal
  | 'login_request'   // a bot asks the owner to log in (refs.url for a website)
  | 'job_changed'     // a bot's job changed (RoomCard.jobChange) with Undo
  | 'guest';          // an outside agent's message (shared/guestBots.ts), always external

/** The card kinds a bot may post with `room.post` (the rest are written by
 *  main: facts, questions via ask.person, human messages, refusals, budget,
 *  and approval / routine / secret_request / login_request / job_changed,
 *  each from its own RPC). */
export const BOT_POSTABLE_CARD_KINDS: readonly CardKind[] = [
  'dispatch', 'status', 'triage', 'verdict', 'report', 'plan', 'proposal', 'opinion',
];

export interface RoomCard {
  version: 1;
  id: string;
  seq: number;
  workspaceId: string;
  threadId: ThreadId;
  kind: CardKind;
  at: number;
  actor: Party;
  title: string;
  /** markdown ≤ ROOM_LIMITS.CARD_BODY_MAX */
  body?: string;
  refs?: FactRef & {
    factId?: string;
    handoffId?: string;
    decisionId?: string;
    url?: string;
    /** The bots this card is addressed to (an owner message's addressees,
     *  a bot card's mentions), as main validated them. */
    botIds?: string[];
    /** `approval` card: its request (shared/botApproval.ts). */
    approvalId?: string;
    /** The thread of the card's subject when the card sits in another one:
     *  an `approval` card is posted where the bot talks with the owner
     *  (usually `general`) and links its PR's thread here. */
    threadId?: ThreadId;
    /** `routine` card: the routine (shared/botRoutine.ts). */
    routineId?: string;
    /** Main-written, on the hop that opens a coordinator's thread for the
     *  owner's request: that request's own card (in General), whose words
     *  name the thread. */
    requestCardId?: string;
    /** `secret_request` card: the env name asked for (never a value). */
    secretName?: string;
  };
  /** question / proposal / plan */
  state?: 'open' | 'resolved';
  /** Another card of the same thread this one answers (main checks it). */
  replyTo?: string;
  /** The poster's idempotency key: a second post with the same key in the
   *  same room returns this card instead of writing another. */
  clientPostId?: string;
  /** Main-written: this card records the end of its thread's subject (PR
   *  merged or closed, issue closed, task done). */
  closes?: true;
  /** Main-written, `question` only: the bot's greeting question (asked in
   *  its first, `intro` wake). It closes once the bot has a job. */
  greeting?: true;
  /** `job_changed` only: whose job changed and from what, so Undo restores
   *  `previous` (null: there was none). */
  jobChange?: { botId: string; previous: string | null; next: string | null };
  /** Main-written, system cards only: what the card says as a stable code
   *  and its values, so the reader's language words it (CardNotice). The
   *  title and body stay the English text, shown for a code the reader does
   *  not know. */
  notice?: CardNotice;
  /** Main-written, `human` cards only: the photos the owner sent with the
   *  message (shared/roomAttachments.ts). Never set by a room.post param. */
  attachments?: RoomAttachment[];
  /** Main-written, bot cards only: the files the bot attached with
   *  room_post `files`, as stored copies (shared/roomFiles.ts). */
  files?: RoomFile[];
  /** Main-written, `guest` cards only (actor system): the outside agent that
   *  posted it (shared/guestBots.ts). The card is external whatever it says. */
  guest?: { guestId: string; name: string };
  /** Main-written: a bot card written in a guest-sourced wake (wakeTaint.ts),
   *  or a card derived from a guest-sourced item (a question, its closing
   *  card, a thread's Finished card, a fact's card, the owner's resolution
   *  of such a card). Read like a `guest` card (isGuestSourcedCard). */
  origin?: 'guest';
}

/** Whether a card is an external guest's words or a bot's card from a turn
 *  that started from or read them: what a reader sees only when it asks
 *  for guest cards (RoomWriter.read `guests`). Pure. */
export function isGuestSourcedCard(c: Pick<RoomCard, 'kind' | 'origin'>): boolean {
  return c.kind === 'guest' || c.origin === 'guest';
}

/** A factory system card's stable code: the task gate's and the worker
 *  lifecycle's cards. `args` are the values the words need (a status, an
 *  exit code, a task title); evidence a card carries (a command, an error)
 *  stays in its body. */
export interface CardNotice {
  code: string;
  args?: Record<string, string | number>;
}

/** Derived, never stored: `closed` once a closing card is the latest word
 *  and nothing is left open, `quiet` after ROOM_LIMITS.QUIET_DAYS without a
 *  card, else `open`. */
export type ThreadStatus = 'open' | 'quiet' | 'closed';

export interface ThreadSummary {
  threadId: ThreadId;
  title: string;
  lastAt: number;
  /** The newest card's seq (arrival order). */
  lastSeq: number;
  cardCount: number;
  openQuestions: number;
  lastKind: CardKind;
  status: ThreadStatus;
  /** Cards after the reader's read position; null when no position is
   *  known for this thread (unknown, not zero). */
  unread: number | null;
  /** The first card's time (absent: no card). */
  firstAt?: number;
  /** The bot whose 1:1 this thread is (`dm:<botId>`), or whose 1:1 started
   *  it (a coordinator's request thread: main's card links the 1:1 or sits
   *  in it pointing here). Absent: the room's own thread. */
  dmBotId?: string;
  /** The group whose own thread this is (`group:<groupId>`), or whose
   *  thread started it (a coordinator's request thread opened there). */
  groupId?: string;
}

export const ROOM_RPC = { post: 'room.post', read: 'room.read', search: 'room.search', threads: 'room.threads', resolve: 'room.resolve' } as const;

/** main → renderer push: {card} | {threadSummary}. */
export const ROOM_EVENT = 'room.event';

export const ROOM_LIMITS = { CARD_BODY_MAX: 8192, TITLE_MAX: 200, PAGE: 100, RETAIN_DAYS: 90, QUIET_DAYS: 3, CLIENT_ID_MAX: 200, MENTIONS_MAX: 16, SEARCH_DEFAULT: 10, SEARCH_MAX: 50, SEARCH_QUERY_MAX: 200, SEARCH_TERMS_MAX: 8 } as const;

/** `room.post` — a bot posts into its own workspace's room (the workspace and
 *  actor come from the caller's binding, never from params). Without a
 *  threadId the card lands in the thread of the wake the bot is running
 *  (main pins it), else `general`. Text never addresses anyone: `@name` in a
 *  body wakes nobody. Only `mentions`, a handoff, a directed fact or a
 *  trigger wakes a bot. */
export interface RoomPostParams {
  threadId?: ThreadId;
  kind: CardKind;
  title: string;
  body?: string;
  refs?: RoomCard['refs'];
  /** A card id of the same thread this card answers. */
  replyTo?: string;
  /** Idempotency key; default `wake:<wakeId>:<n>` from the running wake. */
  clientPostId?: string;
  /** Bot ids this card speaks to, in any workspace. Main validates each
   *  (an existing, enabled bot; never the poster itself), stores them as
   *  `refs.botIds`, and wakes each once as a handoff `to:{kind:'bot', botId}`
   *  in the poster's run (wake reason `mention`), so the hop / per-run caps
   *  and dedupe apply. At most ROOM_LIMITS.MENTIONS_MAX. */
  mentions?: string[];
}

/** `room.read` — cards in arrival (seq) order. threadId omitted: every card
 *  of the room; `general`: the general thread only; else that thread. */
export interface RoomReadParams {
  threadId?: ThreadId;
  /** Cards with seq > sinceSeq. Omitted: the newest page. */
  sinceSeq?: number;
  limit?: number;
  /** A Coordinator-template bot only (botSurface.ts
   *  COORDINATOR_READ_EXTENSION): another workspace's room. */
  workspaceId?: string;
  /** Operator only: record that the owner has read this thread (threadId
   *  required) through this seq. Opening a view is not reading. */
  markThroughSeq?: number;
  /** A bot only: also return external guests' cards (and cards written in
   *  a guest-sourced wake). Left out by default; refused outside a wake an
   *  external guest's message started (wakeTaint.ts). The operator always
   *  sees them. */
  includeGuest?: boolean;
}

export interface RoomReadResult {
  ok: true;
  workspaceId: string;
  threadId: ThreadId | null;
  cards: RoomCard[];
  /** Pass back as sinceSeq. */
  nextSinceSeq: number;
  /** More cards follow this page. */
  hasMore: boolean;
}

/** `room.search` — a bot finds earlier cards of its own room by words:
 *  every term must appear (case-insensitive) in a card's title or body.
 *  Hits come newest first (by seq); pass `nextBefore` back as `before` for
 *  older ones. A hit's seq and threadId read its context with room.read. */
export interface RoomSearchParams {
  /** Space-separated terms, at most ROOM_LIMITS.SEARCH_QUERY_MAX chars. */
  query: string;
  /** Only cards with seq < before. */
  before?: number;
  /** Default ROOM_LIMITS.SEARCH_DEFAULT, at most ROOM_LIMITS.SEARCH_MAX. */
  limit?: number;
  /** The operator only: the room to search (a bot searches its own). */
  workspaceId?: string;
}

export interface RoomSearchHit {
  seq: number;
  cardId: string;
  threadId: ThreadId;
  kind: CardKind;
  at: number;
  actor: Party;
  title: string;
  /** A short one-line excerpt around the first match. */
  snippet: string;
}

export interface RoomSearchResult {
  ok: true;
  workspaceId: string;
  hits: RoomSearchHit[];
  /** Pass back as `before` for older hits. */
  nextBefore: number;
  /** More hits are older than this page. */
  hasMore: boolean;
}

export interface RoomThreadsParams { workspaceId?: string; }

/** `room.resolve` — operator only: close a question / proposal / plan card. */
export interface RoomResolveParams { workspaceId: string; cardId: string; resolution: string; }
