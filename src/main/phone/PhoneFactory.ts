// The agent factory for the phone: main's side of the factory fields in the
// sidebar snapshot, of the two read-only room commands and of the Bots page
// list (`workspaces.bots`).
//
// Main owns every store involved (bots, their runtime status, the factory
// settings, rooms, handoffs), so the factory fields are folded into the
// snapshot here (PhoneWorkspaces.takeSidebar) rather than computed in the
// renderer and sent back. The rule itself is pure (shared/phoneFactory.ts);
// this file only reads the stores, through ports a test can replace.
//
// Every reader fails closed: a factory that has not started leaves the
// snapshot as the renderer made it, and the room commands answer
// `{unavailable:true}` (the daemon serves 503).

import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { delegatesFromConversation, isIdentitySlot, type BotProfile, type BotStatus } from '../../shared/bot';
import type { BotTaskView } from '../../shared/botTask';
import { taskPrUrls, type WorkOwner } from '../../shared/botsWork';
import type { BotGroup } from '../../shared/botGroup';
import type { Handoff } from '../../shared/handoff';
import { dmThreadBot, dmThreadId, groupThreadGroup, parseThreadId, ROOM_LIMITS, type RoomCard, type ThreadId, type ThreadSummary } from '../../shared/room';
import {
  PHONE_BOTS_COMMAND,
  PHONE_BOTS_LIMITS,
  fitPhoneBots,
  parsePhoneBotsBot,
  parsePhoneBotsConversation,
  phoneConversationWork,
  type PhoneBotsBot,
  type PhoneBotsConversation,
  type PhoneBotsReply,
  type PhoneBotsWork,
} from '../../shared/phoneBots';
import { applyFactoryToSidebar, delegationsFromHandoffs, type PhoneFactoryState } from '../../shared/phoneFactory';
import {
  PHONE_BOT_PRESENCES,
  PHONE_SIDEBAR_LIMITS,
  type PhoneBotPresence,
  type PhoneSidebarBot,
  type PhoneSidebarSnapshot,
} from '../../shared/phoneFleetSidebar';
import {
  PHONE_ROOM_ATTACHMENT_COMMAND,
  PHONE_ROOM_CARDS_COMMAND,
  PHONE_ROOM_LIMITS,
  PHONE_ROOM_THREADS_COMMAND,
  fitPhoneRoomPage,
  fitPhoneRoomThreads,
  isPhoneRoomWorkspaceId,
  parsePhoneRoomThread,
  phoneRoomCard,
  type PhoneRoomCard,
  type PhoneRoomCardsReply,
  type PhoneRoomThread,
  type PhoneRoomThreadsReply,
} from '../../shared/phoneRooms';
import { getBotStore } from '../factory/botStore';
import { getBotRuntime } from '../factory/BotRuntime';
import { getFactorySettings } from '../factory/factorySettings';
import { getHandoffRouter, HANDOFF_STORE_LIMITS } from '../factory/handoffRouter';
import { getRoomWriter, ROOMS_DIRNAME } from '../factory/roomWriter';
import { ROOM_ATTACHMENT_ID_RE } from '../../shared/roomAttachments';
import { phoneBot } from '../factory/phoneBot';
import { getGroupStore } from '../factory/groupStore';
import { getApprovalService } from '../factory/approvals';
import { botTaskViews, getBotTaskSources } from '../factory/botTasks';
import { getWorkspaceMirror } from '../workspace/WorkspaceMirror';

/** The room reads this file needs (RoomWriter). */
export interface PhoneRoomReader {
  read(workspaceId: string, opts: { threadId?: ThreadId; sinceSeq?: number; limit?: number }): { cards: RoomCard[]; nextSinceSeq: number; hasMore: boolean };
  summary(workspaceId: string, threadId: ThreadId): ThreadSummary;
  threads(workspaceId: string): ThreadSummary[];
  /** The newest card of a room that matches (RoomWriter.find). */
  find?(workspaceId: string, match: (c: RoomCard) => boolean): RoomCard | null;
}

export interface PhoneFactoryPorts {
  settings(): { enabled: boolean; hqWorkspaceId: string | null; phoneBotId?: string };
  /** Every bot profile; null before the factory started. */
  bots(): BotProfile[] | null;
  status(botId: string): BotStatus | null;
  rooms(): PhoneRoomReader | null;
  /** Recent handoffs (newest first); null when the router is not running. */
  handoffs(): Handoff[] | null;
  /** A room file exists on disk for this workspace. */
  roomFileExists(workspaceId: string): boolean;
  /** False when the room file exists but cannot be read: the store would
   *  serve it as empty, so the phone is told the room is unavailable. */
  roomReadable(workspaceId: string): boolean;
  now(): number;
  /** An approval request's action (`approval` cards' `approvalAction`), or
   *  null when it is not known. Absent: none is served. */
  approvalAction?(approvalId: string): string | null;
}

function roomFile(workspaceId: string): string {
  return path.join(getWmuxDir(), 'factory', ROOMS_DIRNAME, `${workspaceId}.jsonl`);
}

export function defaultPhoneFactoryPorts(): PhoneFactoryPorts {
  return {
    settings: () => getFactorySettings(),
    bots: () => getBotStore()?.list() ?? null,
    status: (botId) => getBotRuntime()?.status(botId) ?? null,
    rooms: () => getRoomWriter(),
    handoffs: () => getHandoffRouter()?.list({ limit: HANDOFF_STORE_LIMITS.LIST_MAX }) ?? null,
    roomFileExists: (workspaceId) => fs.existsSync(roomFile(workspaceId)),
    roomReadable: (workspaceId) => {
      try {
        fs.accessSync(roomFile(workspaceId), fs.constants.R_OK);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
      }
    },
    now: () => Date.now(),
    approvalAction: (approvalId) => getApprovalService()?.get(approvalId)?.action ?? null,
  };
}


function presenceOf(status: BotStatus | null): PhoneBotPresence {
  const p = status?.presence;
  return p && (PHONE_BOT_PRESENCES as readonly string[]).includes(p) ? p : 'unknown';
}

function openQuestionsIn(rooms: PhoneRoomReader, workspaceId: string): number {
  return rooms.threads(workspaceId).reduce((sum, t) => sum + t.openQuestions, 0);
}

/**
 * What the factory contributes to a snapshot listing `workspaceIds`, or null
 * when the factory has not started (the snapshot then stays as it was).
 */
export function phoneFactoryState(ports: PhoneFactoryPorts, workspaceIds: readonly string[]): PhoneFactoryState | null {
  const all = ports.bots();
  if (!all) return null;
  const settings = ports.settings();
  if (!settings.enabled) return { enabled: false, hq: null, bots: new Map(), openQuestions: new Map(), delegations: null };
  // The phone route's addressee (factory/phoneBot.ts), served as the HQ bot.
  const hq = phoneBot(all, settings);
  const hqSession = hq ? ports.status(hq.id)?.sessionId : undefined;
  const listed = new Set(workspaceIds);
  const bots = new Map<string, PhoneSidebarBot[]>();
  for (const bot of [...all].sort((a, b) => a.createdAt - b.createdAt)) {
    if (!listed.has(bot.workspaceId)) continue;
    const row = bots.get(bot.workspaceId) ?? [];
    if (row.length >= PHONE_SIDEBAR_LIMITS.botsPerWorkspace) continue;
    const status = ports.status(bot.id);
    row.push({ id: bot.id, role: bot.role, presence: presenceOf(status), queueDepth: status?.queueDepth ?? 0 });
    bots.set(bot.workspaceId, row);
  }
  const rooms = ports.rooms();
  const openQuestions = new Map<string, number>();
  if (rooms) {
    // Only rooms a bot works in: a room exists where a bot posts.
    for (const ws of bots.keys()) {
      try {
        openQuestions.set(ws, openQuestionsIn(rooms, ws));
      } catch {
        /* this workspace's count is left out */
      }
    }
  }
  let delegations: PhoneFactoryState['delegations'] = null;
  const handoffs = ports.handoffs();
  if (handoffs) {
    const byId = new Map(all.map((b) => [b.id, b]));
    delegations = delegationsFromHandoffs(
      handoffs,
      (botId) => {
        const b = byId.get(botId);
        return b ? { name: b.name } : null;
      },
      (ws, threadId) => {
        const t = parseThreadId(threadId);
        try {
          return !!rooms && !!t && rooms.summary(ws, t).openQuestions > 0;
        } catch {
          return false;
        }
      },
      ports.now(),
    );
  }
  return {
    enabled: true,
    hq: hq ? { botId: hq.id, workspaceId: hq.workspaceId, ...(hqSession ? { sessionId: hqSession } : {}) } : null,
    bots,
    openQuestions,
    delegations,
  };
}

/** The snapshot with the factory folded in; unchanged when it cannot be read. */
export function withPhoneFactory(sidebar: PhoneSidebarSnapshot, ports: PhoneFactoryPorts = defaultPhoneFactoryPorts()): PhoneSidebarSnapshot {
  let state: PhoneFactoryState | null;
  try {
    state = phoneFactoryState(ports, sidebar.workspaces.map((w) => w.id));
  } catch (err) {
    console.warn(`[phone] factory fields left out: ${String(err)}`);
    return sidebar;
  }
  return state ? applyFactoryToSidebar(sidebar, state) : sidebar;
}

// ── Room commands ──────────────────────────────────────────────────────────

type RoomCommandReply =
  | PhoneRoomThreadsReply
  | PhoneRoomCardsReply
  | { attachment: { mediaType: string; bytes: number } }
  | { unavailable: true }
  | { notFound: true }
  | { invalid: true };

/** A workspace whose room the phone may read: one with a bot or a room
 *  already on disk. Anything else is not found, so a phone cannot make main
 *  load a room for an id that names nothing. */
function roomKnown(ports: PhoneFactoryPorts, workspaceId: string, bots: readonly BotProfile[]): boolean {
  return bots.some((b) => b.workspaceId === workspaceId) || ports.roomFileExists(workspaceId);
}

function botInfo(bots: readonly BotProfile[]): (botId: string) => { role: BotProfile['role']; name: string } | null {
  const byId = new Map(bots.map((b) => [b.id, b]));
  return (botId) => {
    const b = byId.get(botId);
    return b ? { role: b.role, name: b.name } : null;
  };
}

/** `workspaces.roomAttachment`: the photo's size and type when a kept
 *  owner card of the room carries it. The daemon reads the bytes itself. */
function phoneRoomAttachment(payload: Record<string, unknown>, ports: PhoneFactoryPorts): RoomCommandReply {
  const { workspaceId, attachmentId } = payload;
  if (!isPhoneRoomWorkspaceId(workspaceId) || typeof attachmentId !== 'string' || !ROOM_ATTACHMENT_ID_RE.test(attachmentId)) return { invalid: true };
  const rooms = ports.rooms();
  if (!rooms?.find) return { unavailable: true };
  const card = rooms.find(workspaceId, (c) => c.kind === 'human' && c.actor.kind === 'human' && !!c.attachments?.some((x) => x.id === attachmentId));
  const a = card?.attachments?.find((x) => x.id === attachmentId);
  return a ? { attachment: { mediaType: a.mediaType, bytes: a.bytes } } : { notFound: true };
}

/** `workspaces.roomThreads` / `workspaces.roomCards` / `workspaces.roomAttachment`; null for any other command. */
export function handlePhoneRoomCommand(command: string, payload: Record<string, unknown>, ports: PhoneFactoryPorts = defaultPhoneFactoryPorts()): RoomCommandReply | null {
  if (command === PHONE_ROOM_ATTACHMENT_COMMAND) return phoneRoomAttachment(payload, ports);
  if (command !== PHONE_ROOM_THREADS_COMMAND && command !== PHONE_ROOM_CARDS_COMMAND) return null;
  const workspaceId = payload.workspaceId;
  if (!isPhoneRoomWorkspaceId(workspaceId)) return { invalid: true };
  const rooms = ports.rooms();
  const bots = ports.bots();
  if (!rooms || !bots) return { unavailable: true };
  if (!roomKnown(ports, workspaceId, bots)) return { notFound: true };

  if (!ports.roomReadable(workspaceId)) return { unavailable: true };

  if (command === PHONE_ROOM_THREADS_COMMAND) {
    const threads: PhoneRoomThread[] = [];
    for (const t of rooms.threads(workspaceId)) {
      const parsed = parsePhoneRoomThread(t);
      if (parsed) threads.push(parsed);
    }
    return fitPhoneRoomThreads({ workspaceId, threads });
  }

  let threadId: ThreadId | null = null;
  if (payload.threadId !== undefined) {
    threadId = parseThreadId(payload.threadId);
    if (!threadId) return { invalid: true };
  }
  const sinceSeq = payload.sinceSeq;
  if (sinceSeq !== undefined && !(typeof sinceSeq === 'number' && Number.isSafeInteger(sinceSeq) && sinceSeq >= 0)) return { invalid: true };
  const limit = payload.limit;
  if (!(typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 && limit <= PHONE_ROOM_LIMITS.pageMax)) return { invalid: true };
  const page = rooms.read(workspaceId, {
    ...(threadId ? { threadId } : {}),
    ...(sinceSeq !== undefined ? { sinceSeq } : {}),
    limit,
  });
  const info = botInfo(bots);
  const action = (approvalId: string): string | null => {
    try {
      return ports.approvalAction?.(approvalId) ?? null;
    } catch {
      return null;
    }
  };
  const cards: PhoneRoomCard[] = [];
  for (const card of page.cards) {
    const projected = phoneRoomCard(card, info, action);
    if (projected) cards.push(projected);
  }
  return fitPhoneRoomPage({ workspaceId, threadId, cards, nextSinceSeq: page.nextSinceSeq, hasMore: page.hasMore }, sinceSeq !== undefined);
}

// ── The Bots page list ─────────────────────────────────────────────────────

export interface PhoneBotsPorts extends PhoneFactoryPorts {
  /** The owner's live group chats; null before the group store started. */
  groups(): BotGroup[] | null;
  /** A workspace's name on the desktop, or null when it is not open. */
  workspaceName(workspaceId: string): string | null;
  /** Each bot's tasks, as the desktop's Bots page lists them (a work card's
   *  state and pull request). Absent: work is read from the cards alone. */
  taskViews?(bots: BotProfile[]): Promise<ReadonlyMap<string, readonly BotTaskView[]>>;
}

export function defaultPhoneBotsPorts(): PhoneBotsPorts {
  return {
    ...defaultPhoneFactoryPorts(),
    groups: () => getGroupStore()?.list() ?? null,
    workspaceName: (workspaceId) => getWorkspaceMirror().getEntries()?.find((e) => e.id === workspaceId)?.name ?? null,
    taskViews: async (bots) => {
      const sources = getBotTaskSources();
      return sources ? botTaskViews(bots, sources) : new Map();
    },
  };
}

/** How long the list waits for the bots' tasks before it reads work from
 *  the cards alone. */
const TASK_VIEWS_WAIT_MS = 2000;

/** Cards read from the end of a thread to find its newest message. */
const PREVIEW_SCAN = 20;

/** One conversation's threads, as the desktop list derives them (Bots/botsModel.ts). */
interface ConversationScope {
  /** Its own thread: the row's unread and its send target. */
  own: ThreadSummary | undefined;
  /** Its own thread and the threads it started. */
  all: ThreadSummary[];
}

function dmScope(threads: readonly ThreadSummary[], botId: string): ConversationScope {
  const ownId = dmThreadId(botId);
  return {
    own: threads.find((t) => t.threadId === ownId),
    all: threads.filter((t) => t.threadId === ownId || (t.dmBotId === botId && !dmThreadBot(t.threadId))),
  };
}

function groupScope(threads: readonly ThreadSummary[], group: BotGroup): ConversationScope {
  const own = threads.find((t) => t.threadId === group.threadId);
  if (groupThreadGroup(group.threadId)) {
    return { own, all: threads.filter((t) => t.threadId === group.threadId || (t.groupId === group.id && !groupThreadGroup(t.threadId))) };
  }
  // A group made from the room lives in General: the room without the 1:1
  // and group threads and the threads they started.
  return { own, all: threads.filter((t) => !dmThreadBot(t.threadId) && !groupThreadGroup(t.threadId) && !t.dmBotId && !t.groupId) };
}

/** The newest message (a bot's or the owner's) across a conversation's
 *  threads: wmux's own lines never preview a row. */
function newestMessage(rooms: PhoneRoomReader, workspaceId: string, scope: ConversationScope): RoomCard | null {
  let best: RoomCard | null = null;
  for (const t of scope.all) {
    if (best && t.lastAt < best.at) continue;
    const cards = rooms.read(workspaceId, { threadId: t.threadId, limit: PREVIEW_SCAN }).cards;
    for (let i = cards.length - 1; i >= 0; i--) {
      const c = cards[i];
      if (c.actor.kind === 'system') continue;
      if (!best || c.at > best.at || (c.at === best.at && c.seq > best.seq)) best = c;
      break;
    }
  }
  return best;
}

/** The row's time, seq, preview and counts over its threads. */
function conversationActivity(
  rooms: PhoneRoomReader,
  workspaceId: string,
  scope: ConversationScope,
  createdAt: number,
  bot: (botId: string) => { role: BotProfile['role']; name: string } | null,
): Pick<PhoneBotsConversation, 'lastAt' | 'lastSeq' | 'lastPreview' | 'lastActor' | 'unread' | 'openQuestions'> {
  const newest = scope.all.reduce<ThreadSummary | null>((m, t) => (t.cardCount > 0 && (!m || t.lastAt > m.lastAt || (t.lastAt === m.lastAt && t.lastSeq > m.lastSeq)) ? t : m), null);
  const last = newestMessage(rooms, workspaceId, scope);
  const card = last ? phoneRoomCard(last, bot) : null;
  return {
    lastAt: Math.max(createdAt, newest?.lastAt ?? 0),
    lastSeq: newest?.lastSeq ?? 0,
    ...(card ? { lastPreview: card.title, lastActor: card.actor } : {}),
    unread: scope.own?.unread ?? null,
    // Only the conversation's own thread: the phone cannot answer in the
    // task threads it started, so their questions would never clear.
    openQuestions: scope.own?.openQuestions ?? 0,
  };
}

/** What a conversation's work cards read besides its cards. */
interface WorkContext {
  threads: readonly ThreadSummary[];
  workAuthor?: string;
  workCandidates?: ReadonlySet<string>;
  tasks: readonly BotTaskView[];
  prUrl: (taskId: string) => string | null;
}

/** A conversation's work cards (shared/phoneBots.ts phoneConversationWork):
 *  its own thread's newest page and the newest page of each of the newest
 *  threads it started. */
function conversationWork(rooms: PhoneRoomReader, workspaceId: string, scope: ConversationScope, owner: WorkOwner, ctx: WorkContext): PhoneBotsWork[] {
  const started = scope.all
    .filter((t) => t !== scope.own)
    .sort((a, b) => b.lastAt - a.lastAt || b.lastSeq - a.lastSeq)
    .slice(0, PHONE_BOTS_LIMITS.work);
  if (started.length === 0) return [];
  const cards: RoomCard[] = [];
  for (const t of scope.own ? [scope.own, ...started] : started) cards.push(...rooms.read(workspaceId, { threadId: t.threadId, limit: ROOM_LIMITS.PAGE }).cards);
  return phoneConversationWork({
    owner, cards,
    threads: { [workspaceId]: ctx.threads },
    ...(ctx.workAuthor ? { workAuthor: ctx.workAuthor } : ctx.workCandidates ? { workCandidates: ctx.workCandidates } : {}),
    tasks: ctx.tasks,
    prUrl: ctx.prUrl,
    threadTitle: (threadId) => ctx.threads.find((t) => t.threadId === threadId)?.title || null,
  });
}

/**
 * The Bots page's list for the phone (shared/phoneBots.ts): every bot, and
 * one conversation per bot (its 1:1) and per live group chat, newest first,
 * across workspaces — the desktop's order (Bots/botsModel.ts buildBots). A
 * conversation is its own thread and the threads it started; the desktop's
 * 1:1 also folds in a bot's older General cards, which this list leaves out
 * (the phone reads a 1:1 as its `dm:` thread). `tasks` are each bot's tasks
 * (PhoneBotsPorts.taskViews), for the work cards. Null before the factory
 * started.
 */
export function phoneBotsReply(ports: PhoneBotsPorts, tasks: ReadonlyMap<string, readonly BotTaskView[]> = new Map()): PhoneBotsReply | null {
  const all = ports.bots();
  const rooms = ports.rooms();
  const groups = ports.groups();
  if (!all || !rooms || !groups) return null;
  const settings = ports.settings();
  const hq = settings.enabled ? phoneBot(all, settings) : null;
  const sorted = [...all].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const bots: PhoneBotsBot[] = sorted.map((b) => {
    const status = ports.status(b.id);
    return {
      id: b.id, name: b.name, role: b.role, workspaceId: b.workspaceId, enabled: b.enabled,
      isHq: hq?.id === b.id, presence: presenceOf(status), queueDepth: status?.queueDepth ?? 0,
      avatar: { hue: isIdentitySlot(b.hue) ? b.hue : null, picture: typeof b.avatar === 'string' && b.avatar.length > 0 },
    };
  });
  const threadsOf = new Map<string, ThreadSummary[]>();
  const threads = (workspaceId: string): ThreadSummary[] => {
    let list = threadsOf.get(workspaceId);
    if (!list) {
      try {
        list = ports.roomReadable(workspaceId) ? rooms.threads(workspaceId) : [];
      } catch {
        list = [];
      }
      threadsOf.set(workspaceId, list);
    }
    return list;
  };
  const info = botInfo(all);
  const names = new Map<string, string | null>();
  const workspaceName = (workspaceId: string): string | null => {
    if (!names.has(workspaceId)) names.set(workspaceId, ports.workspaceName(workspaceId));
    return names.get(workspaceId) ?? null;
  };
  const rows: Array<PhoneBotsConversation & { order: string }> = [];
  const activity = (workspaceId: string, scope: ConversationScope, createdAt: number) => {
    try {
      return conversationActivity(rooms, workspaceId, scope, createdAt, info);
    } catch {
      return { lastAt: createdAt, lastSeq: 0, unread: null, openQuestions: 0 };
    }
  };
  const allTasks = [...tasks.values()].flat();
  const prUrls = taskPrUrls(all.map((b) => ({ repoKey: b.repo?.repoKey, tasks: tasks.get(b.id) })));
  const workOf = (workspaceId: string, scope: ConversationScope, owner: WorkOwner, author: Pick<WorkContext, 'workAuthor' | 'workCandidates'>): { work?: PhoneBotsWork[] } => {
    try {
      const work = conversationWork(rooms, workspaceId, scope, owner, {
        threads: threads(workspaceId), ...author, tasks: allTasks, prUrl: (taskId) => prUrls.get(taskId) ?? null,
      });
      return work.length > 0 ? { work } : {};
    } catch {
      return {};
    }
  };
  for (const group of groups) {
    const ws = workspaceName(group.workspaceId);
    const members = group.memberIds.filter((id) => all.some((b) => b.id === id && b.workspaceId === group.workspaceId));
    const scope = groupScope(threads(group.workspaceId), group);
    // Only a coordinator's or a lead bot's dispatch opens a thread from a
    // group: its only one handed it off, or the nearest of several (BotsChat.tsx).
    const coordinators = new Set(members.filter((id) => delegatesFromConversation(all.find((b) => b.id === id))));
    const author = coordinators.size === 1 ? { workAuthor: [...coordinators][0] } : { workCandidates: coordinators };
    rows.push({
      order: `group:${group.id}`,
      kind: 'group', threadId: group.threadId, workspaceId: group.workspaceId,
      ...(ws ? { workspaceName: ws } : {}),
      name: group.name || ws || '',
      groupId: group.id,
      memberBotIds: members,
      ...activity(group.workspaceId, scope, group.createdAt),
      // A group made from the room (General) starts no thread of its own.
      ...(groupThreadGroup(group.threadId) ? workOf(group.workspaceId, scope, { threadId: group.threadId }, author) : {}),
    });
  }
  for (const b of sorted) {
    const ws = workspaceName(b.workspaceId);
    const scope = dmScope(threads(b.workspaceId), b.id);
    rows.push({
      order: `bot:${b.id}`,
      kind: 'dm', threadId: dmThreadId(b.id), workspaceId: b.workspaceId,
      ...(ws ? { workspaceName: ws } : {}),
      name: b.name, botId: b.id, memberBotIds: [b.id],
      ...activity(b.workspaceId, scope, b.createdAt),
      ...workOf(b.workspaceId, scope, { botId: b.id }, { workAuthor: b.id }),
    });
  }
  rows.sort((a, b) => b.lastAt - a.lastAt || a.order.localeCompare(b.order));
  const conversations: PhoneBotsConversation[] = [];
  for (const { order: _order, ...row } of rows) {
    const parsed = parsePhoneBotsConversation(row);
    if (parsed) conversations.push(parsed);
  }
  const parsedBots = bots.map(parsePhoneBotsBot).filter((b): b is PhoneBotsBot => b !== null);
  return fitPhoneBots({ factoryEnabled: settings.enabled, bots: parsedBots, conversations });
}

/** Each bot's tasks within TASK_VIEWS_WAIT_MS, else none (work is then
 *  read from the cards alone). Never throws. */
async function phoneTaskViews(ports: PhoneBotsPorts): Promise<ReadonlyMap<string, readonly BotTaskView[]>> {
  const none = new Map<string, readonly BotTaskView[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bots = ports.bots();
    if (!bots || bots.length === 0 || !ports.taskViews) return none;
    const late = new Promise<typeof none>((resolve) => { timer = setTimeout(() => resolve(none), TASK_VIEWS_WAIT_MS); });
    return await Promise.race([ports.taskViews(bots), late]);
  } catch {
    return none;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** `workspaces.bots`; null for any other command. */
export function handlePhoneBotsCommand(command: string, ports: () => PhoneBotsPorts = defaultPhoneBotsPorts): Promise<PhoneBotsReply | { unavailable: true }> | null {
  if (command !== PHONE_BOTS_COMMAND) return null;
  const p = ports();
  return phoneTaskViews(p).then((tasks) => phoneBotsReply(p, tasks) ?? { unavailable: true });
}
