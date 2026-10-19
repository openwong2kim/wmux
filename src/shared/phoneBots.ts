// ─── The Bots page for the phone — read-only, over the desktop bridge ──────
//
// `GET /api/bots` serves the desktop Bots page's list in one call: every bot
// and every conversation (a bot's 1:1, a group chat), across workspaces,
// newest first. Bots, groups and rooms live in Electron main; the daemon asks
// main with the command below and main answers from its stores
// (main/phone/PhoneFactory.ts phoneBotsReply).
//
// This module is the allowlist for that reply, used on both sides: main
// projects with it and the daemon parses what main forwarded with it. A field
// not listed here never reaches the phone; a row that does not parse is
// dropped alone. The bridge drops a reply over 128 KiB, so main fits the list
// to PHONE_BOTS_LIMITS.replyBytes, dropping the oldest conversations first.

import { BOT_ID_RE, isIdentitySlot } from './bot';
import { GROUP_ID_RE } from './botGroup';
import { dmThreadBot, groupThreadGroup, parseThreadId, ROOM_LIMITS, type RoomCard, type ThreadId } from './room';
import { PHONE_BOT_PRESENCES, PHONE_BOT_ROLES, clampSidebarString, type PhoneBotPresence, type PhoneBotRole } from './phoneFleetSidebar';
import { cardId, httpUrl, isPhoneRoomWorkspaceId, parsePhoneRoomActor, type PhoneRoomActor } from './phoneRooms';
import type { BotTaskView } from './botTask';
import {
  livePlanIds, placeWork, splitThreads, startedThreadsOf, waitsOnOwner, workDelegate, workView,
  type ThreadsByWorkspace, type WorkOwner, type WorkState,
} from './botsWork';

/** Bridge command; `workspaces.` routes it through main's PhoneWorkspaces. */
export const PHONE_BOTS_COMMAND = 'workspaces.bots';

export const PHONE_BOTS_LIMITS = {
  /** Bots one list carries (the desktop keeps at most 64). */
  bots: 64,
  /** Conversations one list carries, newest first. */
  conversations: 200,
  /** Serialized reply budget: under the bridge's 128 KiB, with room for the envelope. */
  replyBytes: 112 * 1024,
  name: 64,
  preview: ROOM_LIMITS.TITLE_MAX,
  /** Work cards one conversation carries, newest first. */
  work: 20,
} as const;

/** A bot's face as the desktop draws it (Room/BotAvatar.tsx). */
export interface PhoneBotAvatar {
  /** Its identity colour slot, 0–7: its Mochi character, in the desktop's
   *  order (0 Loaf, 1 Nova, 2 Plume, 3 Wink, 4 Momo, 5 Pip, 6 Koa, 7 Nub).
   *  Kept for the bot's life. Null only for a profile the desktop has not
   *  given one yet. */
  hue: number | null;
  /** The owner set a picture for it (not served here): the desktop draws
   *  that instead of the character. */
  picture: boolean;
}

export interface PhoneBotsBot {
  id: string;
  name: string;
  role: PhoneBotRole;
  workspaceId: string;
  enabled: boolean;
  /** The bot `POST /api/moa/messages` reaches (`/api/config` factory.hqBotId). */
  isHq: boolean;
  presence: PhoneBotPresence;
  queueDepth: number;
  avatar: PhoneBotAvatar;
}

export interface PhoneBotsConversation {
  kind: 'dm' | 'group';
  /** `dm:<botId>`, `group:<groupId>`, or `general` for a group made from its
   *  workspace's room. Post to it and read its cards with this id. */
  threadId: ThreadId;
  workspaceId: string;
  workspaceName?: string;
  /** A 1:1: the bot's name. A group: the owner's name for it; a group made
   *  from a room has none and is named after its workspace (`workspaceName`,
   *  or empty when that is unknown). */
  name: string;
  /** A 1:1's bot. */
  botId?: string;
  /** A group's id. */
  groupId?: string;
  /** A 1:1: its bot. A group: its bots, in the owner's order. */
  memberBotIds: string[];
  /** The newest card's time in the conversation (its creation when it has none). */
  lastAt: number;
  /** The newest card's seq in its room (0: none). */
  lastSeq: number;
  /** The newest message's title, one line (a bot's or the owner's; wmux's
   *  own lines never preview). Absent: nothing said yet. */
  lastPreview?: string;
  lastActor?: PhoneRoomActor;
  /** Cards after the owner's read position in its thread; null when none is known. */
  unread: number | null;
  /** Questions asked in it that are not answered yet. */
  openQuestions: number;
  /** The work this conversation handed off, one card per thread it started
   *  (the desktop's work card), newest first, at most PHONE_BOTS_LIMITS.work.
   *  Absent: none. */
  work?: PhoneBotsWork[];
}

/** A work card's state on the phone, from the desktop's (WorkState):
 *  `needsYou` → `waiting_on_you`, `cancelled` → `stopped`, the rest as named. */
export type PhoneBotsWorkState = 'working' | 'review' | 'waiting_on_you' | 'done' | 'failed' | 'stopped';

export const PHONE_BOTS_WORK_STATES: readonly PhoneBotsWorkState[] = ['working', 'review', 'waiting_on_you', 'done', 'failed', 'stopped'];

/** One thread a conversation started, folded into one card (shared/botsWork.ts). */
export interface PhoneBotsWork {
  /** The started thread (`handoff:<id>`, …): read its cards with this id. */
  threadId: ThreadId;
  /** The card in the conversation's own thread the work card sits under:
   *  the delegating bot's message announcing the hand-off, else the card
   *  before the work's first one; with none before it, the work's first card
   *  read (which may be in `threadId`). */
  rootCardId: string;
  /** The bot the work was handed to. */
  delegateBotId?: string;
  state: PhoneBotsWorkState;
  /** The request's words, else the thread's title; empty when neither is known. */
  title: string;
  /** The delegate's newest message in the thread, and its title (one line). */
  latestCardId?: string;
  latestPreview?: string;
  /** The cards folded into the work card, of those read. */
  steps: number;
  /** The newest card's time in the work. */
  lastAt: number;
  /** The GitHub pull request or issue the work is about. */
  refUrl?: string;
}

export interface PhoneBotsReply {
  /** The desktop's factory switch: off, the bots are paused and nothing can be sent. */
  factoryEnabled: boolean;
  bots: PhoneBotsBot[];
  conversations: PhoneBotsConversation[];
  /** Conversations (the oldest) were left out to fit the reply. */
  truncated?: true;
}

// ── Sanitizers (both sides) ────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function line(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? clampSidebarString(value, max) : undefined;
}

/** The phone's name for a work card's state. */
export function phoneWorkState(state: WorkState): PhoneBotsWorkState {
  return state === 'needsYou' ? 'waiting_on_you' : state === 'cancelled' ? 'stopped' : state;
}

/** A work card as the phone may see it, or null. Idempotent. */
export function parsePhoneBotsWork(value: unknown): PhoneBotsWork | null {
  if (!isRecord(value)) return null;
  const threadId = parseThreadId(value.threadId);
  const rootCardId = cardId(value.rootCardId);
  const state = (PHONE_BOTS_WORK_STATES as readonly unknown[]).includes(value.state) ? value.state as PhoneBotsWorkState : undefined;
  const steps = count(value.steps);
  const lastAt = count(value.lastAt);
  if (!threadId || !rootCardId || !state || steps === undefined || lastAt === undefined) return null;
  const delegateBotId = typeof value.delegateBotId === 'string' && BOT_ID_RE.test(value.delegateBotId) ? value.delegateBotId : undefined;
  const latestCardId = cardId(value.latestCardId);
  const latestPreview = latestCardId ? line(value.latestPreview, PHONE_BOTS_LIMITS.preview) : undefined;
  const refUrl = httpUrl(value.refUrl);
  return {
    threadId, rootCardId,
    ...(delegateBotId ? { delegateBotId } : {}),
    state,
    title: line(value.title, PHONE_BOTS_LIMITS.preview) ?? '',
    ...(latestCardId ? { latestCardId } : {}),
    ...(latestPreview ? { latestPreview } : {}),
    steps, lastAt,
    ...(refUrl ? { refUrl } : {}),
  };
}

/** A conversation's work list as the phone may see it: parsed rows, one per
 *  thread, at most PHONE_BOTS_LIMITS.work; undefined when none is left. */
function parseWorkList(value: unknown): PhoneBotsWork[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PhoneBotsWork[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, PHONE_BOTS_LIMITS.work)) {
    const w = parsePhoneBotsWork(raw);
    if (!w || seen.has(w.threadId)) continue;
    seen.add(w.threadId);
    out.push(w);
  }
  return out.length > 0 ? out : undefined;
}

/** What a conversation's work cards are derived from (main's side). */
export interface PhoneConversationWorkInput {
  owner: WorkOwner;
  /** The cards read of the conversation's own thread and the threads it
   *  started, in one room. */
  cards: readonly RoomCard[];
  /** The room's thread summaries, by workspace. */
  threads: ThreadsByWorkspace;
  /** The delegating bot: a 1:1's bot, or a group's only coordinator. */
  workAuthor?: string;
  /** A group's coordinators, when it has several (or none). */
  workCandidates?: ReadonlySet<string>;
  /** The bots' tasks (their stage, by id). */
  tasks?: readonly BotTaskView[];
  /** The pull request a task opened. */
  prUrl?: (taskId: string) => string | null;
  /** A thread's title from its summary (the work's name without one of its own). */
  threadTitle?: (threadId: ThreadId) => string | null;
}

/** The work cards of one conversation, newest first, at most
 *  PHONE_BOTS_LIMITS.work: the desktop's derivation (shared/botsWork.ts
 *  splitThreads, placeWork, workView) over the cards read. Pure. */
export function phoneConversationWork(input: PhoneConversationWorkInput): PhoneBotsWork[] {
  const cards = [...input.cards].sort((a, b) => a.at - b.at || a.seq - b.seq);
  const started = startedThreadsOf(input.owner, cards, input.threads);
  if (started.size === 0) return [];
  const livePlans = livePlanIds(cards);
  const waits = (card: RoomCard): boolean => waitsOnOwner(card, livePlans);
  const { main, work } = splitThreads(cards, waits, started);
  if (work.size === 0) return [];
  const placed = placeWork(main.map((card) => ({ kind: 'card' as const, card })), {
    work, ...(input.workAuthor ? { workAuthor: input.workAuthor } : input.workCandidates ? { workCandidates: input.workCandidates } : {}),
  });
  const order = placed.entries.map((e) => e.card);
  const own = (c: RoomCard): boolean => c.threadId === 'general' || !!dmThreadBot(c.threadId) || !!groupThreadGroup(c.threadId);
  const out: PhoneBotsWork[] = [];
  for (const [anchor, w] of work) {
    const at = order.findIndex((c) => c.id === anchor);
    // The conversation's own card the work card follows in the desktop's
    // timeline: the message that announced it (placeWork moved it there),
    // else the card before its first one. Another work card is no root.
    let root: RoomCard | null = null;
    for (let i = at - 1; i >= 0 && !root; i--) if (!work.has(order[i].id) && own(order[i])) root = order[i];
    // Who handed it off: the 1:1's bot, else the nearest bot above that is
    // not the delegate (among the group's coordinators), as the desktop's
    // timeline reads it.
    const delegate = workDelegate(w.all, null);
    let delegatorId: string | null = input.workAuthor ?? null;
    for (let i = at - 1; i >= 0 && !delegatorId; i--) {
      const c = order[i];
      if (c.actor.kind === 'bot' && c.actor.botId !== delegate && (!input.workCandidates || input.workCandidates.has(c.actor.botId))) delegatorId = c.actor.botId;
    }
    const view = workView(w, { delegatorId, waits, tasks: input.tasks, prUrl: input.prUrl });
    const row = parsePhoneBotsWork({
      threadId: w.threadId,
      rootCardId: root?.id ?? anchor,
      ...(view.delegateId ? { delegateBotId: view.delegateId } : {}),
      state: phoneWorkState(view.state),
      title: view.title ?? input.threadTitle?.(w.threadId) ?? '',
      ...(view.latest ? { latestCardId: view.latest.id, latestPreview: view.latest.title } : {}),
      steps: w.steps.length,
      lastAt: view.lastAt,
      ...(view.refUrl ? { refUrl: view.refUrl } : {}),
    });
    if (row) out.push(row);
  }
  return out.sort((a, b) => b.lastAt - a.lastAt || a.threadId.localeCompare(b.threadId)).slice(0, PHONE_BOTS_LIMITS.work);
}

/** A bot row as the phone may see it, or null. Idempotent. */
export function parsePhoneBotsBot(value: unknown): PhoneBotsBot | null {
  if (!isRecord(value) || !isRecord(value.avatar)) return null;
  const { id, workspaceId, avatar } = value;
  const role = (PHONE_BOT_ROLES as readonly unknown[]).includes(value.role) ? value.role as PhoneBotRole : undefined;
  const presence = (PHONE_BOT_PRESENCES as readonly unknown[]).includes(value.presence) ? value.presence as PhoneBotPresence : 'unknown';
  const queueDepth = count(value.queueDepth);
  if (typeof id !== 'string' || !BOT_ID_RE.test(id) || !isPhoneRoomWorkspaceId(workspaceId) || !role || queueDepth === undefined ||
      typeof value.enabled !== 'boolean' || typeof value.isHq !== 'boolean' || typeof avatar.picture !== 'boolean') return null;
  return {
    id, name: line(value.name, PHONE_BOTS_LIMITS.name) ?? '', role, workspaceId,
    enabled: value.enabled, isHq: value.isHq, presence, queueDepth,
    avatar: { hue: isIdentitySlot(avatar.hue) ? avatar.hue : null, picture: avatar.picture },
  };
}

/** A conversation row as the phone may see it, or null. Idempotent. */
export function parsePhoneBotsConversation(value: unknown): PhoneBotsConversation | null {
  if (!isRecord(value)) return null;
  const threadId = parseThreadId(value.threadId);
  const { workspaceId } = value;
  const lastAt = count(value.lastAt);
  const lastSeq = count(value.lastSeq);
  const openQuestions = count(value.openQuestions);
  const unread = value.unread === null ? null : count(value.unread);
  if (!threadId || !isPhoneRoomWorkspaceId(workspaceId) || lastAt === undefined || lastSeq === undefined ||
      openQuestions === undefined || unread === undefined || !Array.isArray(value.memberBotIds)) return null;
  const members = [...new Set(value.memberBotIds.filter((m): m is string => typeof m === 'string' && BOT_ID_RE.test(m)))].slice(0, ROOM_LIMITS.MENTIONS_MAX);
  let ids: { botId: string } | { groupId: string };
  if (value.kind === 'dm') {
    const botId = dmThreadBot(threadId);
    if (!botId || value.botId !== botId) return null;
    ids = { botId };
  } else if (value.kind === 'group') {
    const groupId = value.groupId;
    if (typeof groupId !== 'string' || !GROUP_ID_RE.test(groupId)) return null;
    // Its own thread, or General (a group made from the room).
    if (threadId !== 'general' && groupThreadGroup(threadId) !== groupId) return null;
    ids = { groupId };
  } else {
    return null;
  }
  const workspaceName = line(value.workspaceName, PHONE_BOTS_LIMITS.name);
  const lastPreview = line(value.lastPreview, PHONE_BOTS_LIMITS.preview);
  const lastActor = parsePhoneRoomActor(value.lastActor);
  const work = parseWorkList(value.work);
  return {
    kind: value.kind, threadId, workspaceId,
    ...(workspaceName ? { workspaceName } : {}),
    name: line(value.name, PHONE_BOTS_LIMITS.name) ?? '',
    ...ids,
    memberBotIds: members,
    lastAt, lastSeq,
    ...(lastPreview ? { lastPreview } : {}),
    ...(lastPreview && lastActor ? { lastActor } : {}),
    unread, openQuestions,
    ...(work ? { work } : {}),
  };
}

/** Main's reply as the daemon serves it, or null when it is not one. */
export function parsePhoneBotsReply(value: unknown): PhoneBotsReply | null {
  if (!isRecord(value) || typeof value.factoryEnabled !== 'boolean' || !Array.isArray(value.bots) || !Array.isArray(value.conversations)) return null;
  const bots: PhoneBotsBot[] = [];
  const seenBots = new Set<string>();
  for (const raw of value.bots.slice(0, PHONE_BOTS_LIMITS.bots)) {
    const b = parsePhoneBotsBot(raw);
    if (!b || seenBots.has(b.id)) continue;
    seenBots.add(b.id);
    bots.push(b);
  }
  const conversations: PhoneBotsConversation[] = [];
  const seen = new Set<string>();
  for (const raw of value.conversations.slice(0, PHONE_BOTS_LIMITS.conversations)) {
    const c = parsePhoneBotsConversation(raw);
    const key = c ? `${c.workspaceId}\u0000${c.threadId}` : '';
    if (!c || seen.has(key)) continue;
    seen.add(key);
    conversations.push(c);
  }
  const truncated = value.truncated === true || value.conversations.length > PHONE_BOTS_LIMITS.conversations;
  return { factoryEnabled: value.factoryEnabled, bots, conversations, ...(truncated ? { truncated: true as const } : {}) };
}

const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

/** The list under the count and byte budgets: the oldest conversations go
 *  first (`truncated` says so); every bot stays. Work cards never cost a
 *  conversation its place: the conversations are fitted without them, then
 *  each gets back as many of its newest work cards as still fit, newest
 *  conversation first. */
export function fitPhoneBots(reply: PhoneBotsReply, budget: number = PHONE_BOTS_LIMITS.replyBytes): PhoneBotsReply {
  const listed = reply.conversations.slice(0, PHONE_BOTS_LIMITS.conversations);
  const bare = listed.map((c): PhoneBotsConversation => {
    const copy = { ...c };
    delete copy.work;
    return copy;
  });
  const base = { factoryEnabled: reply.factoryEnabled, bots: reply.bots.slice(0, PHONE_BOTS_LIMITS.bots), conversations: [], truncated: true };
  let total = bytes(base);
  let keep = 0;
  while (keep < bare.length && total + bytes(bare[keep]) + 1 <= budget) total += bytes(bare[keep++]) + 1;
  const conversations = bare.slice(0, keep).map((c, i): PhoneBotsConversation => {
    const work = listed[i].work ?? [];
    // `,"work":[` … `]`, then each card and its comma.
    let cost = bytes({ ...c, work: [] }) - bytes(c);
    let n = 0;
    while (n < work.length) {
      const next = bytes(work[n]) + (n > 0 ? 1 : 0);
      if (total + cost + next > budget) break;
      cost += next;
      n += 1;
    }
    if (n === 0) return c;
    total += cost;
    return { ...c, work: work.slice(0, n) };
  });
  const truncated = reply.truncated === true || keep < reply.conversations.length;
  return { factoryEnabled: base.factoryEnabled, bots: base.bots, conversations, ...(truncated ? { truncated: true as const } : {}) };
}
