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
import { dmThreadBot, groupThreadGroup, parseThreadId, ROOM_LIMITS, type ThreadId } from './room';
import { PHONE_BOT_PRESENCES, PHONE_BOT_ROLES, clampSidebarString, type PhoneBotPresence, type PhoneBotRole } from './phoneFleetSidebar';
import { isPhoneRoomWorkspaceId, parsePhoneRoomActor, type PhoneRoomActor } from './phoneRooms';

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
 *  first (`truncated` says so); every bot stays. */
export function fitPhoneBots(reply: PhoneBotsReply, budget: number = PHONE_BOTS_LIMITS.replyBytes): PhoneBotsReply {
  const listed = reply.conversations.slice(0, PHONE_BOTS_LIMITS.conversations);
  const base = { factoryEnabled: reply.factoryEnabled, bots: reply.bots.slice(0, PHONE_BOTS_LIMITS.bots), conversations: [], truncated: true };
  let total = bytes(base);
  let keep = 0;
  while (keep < listed.length && total + bytes(listed[keep]) + 1 <= budget) total += bytes(listed[keep++]) + 1;
  const truncated = reply.truncated === true || keep < reply.conversations.length;
  return { factoryEnabled: base.factoryEnabled, bots: base.bots, conversations: listed.slice(0, keep), ...(truncated ? { truncated: true as const } : {}) };
}
