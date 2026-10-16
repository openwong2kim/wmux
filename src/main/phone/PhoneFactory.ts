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
import { isIdentitySlot, type BotProfile, type BotStatus } from '../../shared/bot';
import type { BotGroup } from '../../shared/botGroup';
import type { Handoff } from '../../shared/handoff';
import { dmThreadBot, dmThreadId, groupThreadGroup, parseThreadId, type RoomCard, type ThreadId, type ThreadSummary } from '../../shared/room';
import {
  PHONE_BOTS_COMMAND,
  fitPhoneBots,
  parsePhoneBotsBot,
  parsePhoneBotsConversation,
  type PhoneBotsBot,
  type PhoneBotsConversation,
  type PhoneBotsReply,
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
import { phoneBot } from '../factory/phoneBot';
import { getGroupStore } from '../factory/groupStore';
import { getWorkspaceMirror } from '../workspace/WorkspaceMirror';

/** The room reads this file needs (RoomWriter). */
export interface PhoneRoomReader {
  read(workspaceId: string, opts: { threadId?: ThreadId; sinceSeq?: number; limit?: number }): { cards: RoomCard[]; nextSinceSeq: number; hasMore: boolean };
  summary(workspaceId: string, threadId: ThreadId): ThreadSummary;
  threads(workspaceId: string): ThreadSummary[];
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

/** `workspaces.roomThreads` / `workspaces.roomCards`; null for any other command. */
export function handlePhoneRoomCommand(command: string, payload: Record<string, unknown>, ports: PhoneFactoryPorts = defaultPhoneFactoryPorts()): RoomCommandReply | null {
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
  const cards: PhoneRoomCard[] = [];
  for (const card of page.cards) {
    const projected = phoneRoomCard(card, info);
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
}

export function defaultPhoneBotsPorts(): PhoneBotsPorts {
  return {
    ...defaultPhoneFactoryPorts(),
    groups: () => getGroupStore()?.list() ?? null,
    workspaceName: (workspaceId) => getWorkspaceMirror().getEntries()?.find((e) => e.id === workspaceId)?.name ?? null,
  };
}

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
    openQuestions: scope.all.reduce((n, t) => n + t.openQuestions, 0),
  };
}

/**
 * The Bots page's list for the phone (shared/phoneBots.ts): every bot, and
 * one conversation per bot (its 1:1) and per live group chat, newest first,
 * across workspaces — the desktop's order (Bots/botsModel.ts buildBots). A
 * conversation is its own thread and the threads it started; the desktop's
 * 1:1 also folds in a bot's older General cards, which this list leaves out
 * (the phone reads a 1:1 as its `dm:` thread). Null before the factory
 * started.
 */
export function phoneBotsReply(ports: PhoneBotsPorts): PhoneBotsReply | null {
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
  for (const group of groups) {
    const ws = workspaceName(group.workspaceId);
    rows.push({
      order: `group:${group.id}`,
      kind: 'group', threadId: group.threadId, workspaceId: group.workspaceId,
      ...(ws ? { workspaceName: ws } : {}),
      name: group.name || ws || '',
      groupId: group.id,
      memberBotIds: group.memberIds.filter((id) => all.some((b) => b.id === id && b.workspaceId === group.workspaceId)),
      ...activity(group.workspaceId, groupScope(threads(group.workspaceId), group), group.createdAt),
    });
  }
  for (const b of sorted) {
    const ws = workspaceName(b.workspaceId);
    rows.push({
      order: `bot:${b.id}`,
      kind: 'dm', threadId: dmThreadId(b.id), workspaceId: b.workspaceId,
      ...(ws ? { workspaceName: ws } : {}),
      name: b.name, botId: b.id, memberBotIds: [b.id],
      ...activity(b.workspaceId, dmScope(threads(b.workspaceId), b.id), b.createdAt),
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

/** `workspaces.bots`; null for any other command. */
export function handlePhoneBotsCommand(command: string, ports: () => PhoneBotsPorts = defaultPhoneBotsPorts): PhoneBotsReply | { unavailable: true } | null {
  if (command !== PHONE_BOTS_COMMAND) return null;
  return phoneBotsReply(ports()) ?? { unavailable: true };
}
