// ─── Owner messages — a human card, directed facts and one wake per bot ────
//
// What the owner says in a room, from the room composer (room.post) or the
// phone: a `human` card in the workspace's room and, for each bot it is
// addressed to, a `human.message` fact addressed to that bot (ref.botId, so
// no other bot wakes on it) and a priority-0 wake pinned to the thread it was
// posted in. Who it is for comes from fields, never from the text (an
// `@name` typed in a card wakes nobody):
//
//   mentions   the bot ids the composer resolved (chips): those bots only,
//              in any workspace — a 1:1 conversation is a message with one;
//   toBotId    one bot by id (the phone's bot), when it is enabled;
//   to         a legacy role (the phone's `moa`): that role's bot there;
//   neither    the room: its coordinator when one is enabled there (the
//              oldest; the team's lead hands the work on with handoff_send,
//              so the delegates' results come back to it), else every
//              enabled bot of the workspace (the oldest
//              ROOM_LIMITS.MENTIONS_MAX). This reverses the room-wide wake of
//              2026-10-15 ("a coordinator is a bot like any other") for a
//              room that has a coordinator: woken together, every bot
//              answered one message and none of the work came back to the
//              coordinator to report.
//
// A coordinator that is off or parked (by the owner, or for an error) takes
// no turn, so it is no lead: the message goes to every bot instead. A bot
// waiting on the owner in the message's thread (its open question or
// approval request there) gets the message too, as addressed: the owner may
// be answering it.
//
// A wake a bot got only because it is in a room without a coordinator
// (`roomWide`) does not post the bot's closing text: a bot that has
// something of its own to say posts it with room_post (BotRuntime.ts). The
// room's oldest bot (`roomAnswerer`) answers a greeting or a question to
// everyone that no other bot's job covers, so the room is never silent.
//
// A message posted in a bot's 1:1 thread (`dm:<botId>`) is for that bot
// alone, whatever else it names; the bot must live in that room. Its wake is
// pinned to the thread, so the bot answers in the 1:1, not in General.
//
// A message posted in a group chat's thread (shared/botGroup.ts: its own
// `group:<id>`, or `general` for a group made from the room) is for the
// group's members: those it `mentions` (every one a member, else the post
// is refused), else the bot `toBotId` or `to` names (as above), else every
// enabled member (the oldest MENTIONS_MAX) — or, when the group has an
// enabled coordinator, that coordinator alone. A thread work in a group
// started (a coordinator's request thread opened there) is that group's
// too. A group thread with no live group takes no post.
//
// The card keeps the addressees main settled on (`refs.botIds`, and
// `refs.botId` when there is exactly one, so a 1:1 stays a 1:1). Every wake
// of one message carries the same runId (`run-<cardId>`), so the handoffs its
// addressees send to each other count against one chain
// (handoffRouter.ts). The direct wake is each addressee's one turn: the
// trigger engine never wakes on a directed `human.message` fact.
//
// The owner's wake goes past the bot's queue cap (bounded, wakeQueue.ts
// OVER_CAP_RESERVE). Past that bound the post answers `queue_full` with the
// card written and each addressee's outcome: a repeat of its clientPostId
// returns the first card and queues, once, the wakes still missing, with the
// card's own text. A repeat after every wake was queued returns the card and
// those same wakes (the queue keys each by the clientPostId and keeps that
// record for HUMAN_RETRY_WINDOW_MS).

import type { BotProfile, BotRole } from '../../shared/bot';
import { BOT_ID_RE, botTakesTurns, isBotRole, isCoordinatorBot } from '../../shared/bot';
import type { FactDraft } from '../../shared/facts';
import { GENERAL_THREAD, ROOM_LIMITS, dmThreadBot, groupThreadGroup, groupThreadId, type RoomCard, type ThreadId } from '../../shared/room';
import { capBody, type FactoryRoomPorts, type RoomWriter } from './roomWriter';
import { redactStoredSecrets } from './secretRedaction';
import { HUMAN_RETRY_WINDOW_MS } from './wakeQueue';
import { crossesGuestBoundary } from './guestWorkspaces';
import { enabledBotsIncludingGuest } from './botStore';

/** Longest human message a wake carries (the wake caps its reason at 16 KiB). */
const HUMAN_WAKE_TEXT_MAX = 16 * 1024;
/** Longest human message the fact carries (facts are ≤ 4 KiB). */
const HUMAN_FACT_TEXT_MAX = 3000;

function enabledBots(bots: FactoryRoomPorts['bots'] | undefined): BotProfile[] {
  try {
    // The owner's own message: any workspace's bots, guest ones included;
    // postHumanMessage holds the boundary.
    return enabledBotsIncludingGuest(bots).filter((b) => b.enabled);
  } catch {
    return [];
  }
}

const byAge = (a: BotProfile, b: BotProfile): number => a.createdAt - b.createdAt;

/** The bot a message addressed by role is for: the `to` role there (`moa`:
 *  the HQ bot wherever it lives), else the workspace lead, else the HQ bot
 *  when this is its room. The message text plays no part. Kept for the
 *  phone's `to:'moa'` route. */
export function humanAddressee(bots: FactoryRoomPorts['bots'] | undefined, workspaceId: string, to: unknown): { bot: BotProfile | null; role: BotRole | null } {
  const role = isBotRole(to) ? to : null;
  const enabled = enabledBots(bots);
  const oldest = (xs: BotProfile[]) => [...xs].sort(byAge)[0] ?? null;
  if (role === 'moa') return { bot: oldest(enabled.filter((b) => b.role === 'moa')), role };
  if (role) return { bot: oldest(enabled.filter((b) => b.role === role && b.workspaceId === workspaceId)), role };
  const lead = oldest(enabled.filter((b) => b.role === 'lead' && b.workspaceId === workspaceId));
  if (lead) return { bot: lead, role: 'lead' };
  const hq = oldest(enabled.filter((b) => b.role === 'moa' && b.workspaceId === workspaceId));
  return { bot: hq, role: hq ? 'moa' : null };
}

/** A `mentions` field as given: distinct bot ids, at most MENTIONS_MAX, or
 *  null when it is malformed. Pure. */
export function parseMentions(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > ROOM_LIMITS.MENTIONS_MAX) return null;
  if (!raw.every((id) => typeof id === 'string' && BOT_ID_RE.test(id))) return null;
  return [...new Set(raw as string[])];
}

/** Who one owner message in a workspace's room is for (see the header):
 *  the mentioned bots that exist and are enabled (in the order named), else
 *  the bot named by `toBotId` (the phone's bot) when it is enabled, else the
 *  `to` role's bot, else the room's — the group's, with `members` — oldest
 *  coordinator that takes turns (botTakesTurns), followed by the bots
 *  `waiting` on the owner there, else those waiting bots and then every
 *  enabled bot of the room (of the group), oldest first (at most
 *  ROOM_LIMITS.MENTIONS_MAX). A waiting bot is any enabled bot of the
 *  workspace, in the group or not: the owner may be answering it. `room` is
 *  true for the last only, `lead` for the coordinator's. Pure over the
 *  directory. */
export function humanAddressees(
  bots: FactoryRoomPorts['bots'] | undefined,
  workspaceId: string,
  addressing: { mentions?: readonly string[]; toBotId?: string; to?: unknown; members?: readonly string[]; waiting?: readonly string[] },
): { bots: BotProfile[]; room: boolean; lead?: true } {
  const enabled = enabledBots(bots);
  if (addressing.mentions && addressing.mentions.length > 0) {
    const byId = new Map(enabled.map((b) => [b.id, b]));
    return { bots: addressing.mentions.map((id) => byId.get(id)).filter((b): b is BotProfile => !!b), room: false };
  }
  if (addressing.toBotId !== undefined) {
    const bot = enabled.find((b) => b.id === addressing.toBotId) ?? null;
    return { bots: bot ? [bot] : [], room: false };
  }
  if (addressing.to !== undefined) {
    const { bot } = humanAddressee(bots, workspaceId, addressing.to);
    return { bots: bot ? [bot] : [], room: false };
  }
  const members = addressing.members ? new Set(addressing.members) : null;
  const inWorkspace = enabled.filter((b) => b.workspaceId === workspaceId).sort(byAge);
  const inRoom = inWorkspace.filter((b) => !members || members.has(b.id));
  // The bots waiting on the owner in the thread hear their answer, whether
  // or not they are in the group.
  const waitingIds = new Set(addressing.waiting ?? []);
  const waiting = inWorkspace.filter((b) => waitingIds.has(b.id));
  // A room with a coordinator talks to it: it decides who else works.
  const lead = inRoom.find((b) => isCoordinatorBot(b) && botTakesTurns(b));
  if (lead) return { bots: [lead, ...waiting.filter((b) => b !== lead)].slice(0, ROOM_LIMITS.MENTIONS_MAX), room: false, lead: true };
  // At most MENTIONS_MAX, the waiting bots first, then the oldest: the card
  // names every addressee (refs.botIds), and a retry wakes from that list.
  return { bots: [...waiting, ...inRoom.filter((b) => !waitingIds.has(b.id))].slice(0, ROOM_LIMITS.MENTIONS_MAX), room: true };
}

/** The run every wake of an owner message shares. */
export function humanRunId(cardId: string): string {
  return `run-${cardId}`;
}

/** The owner card a run names (humanRunId), or null when it names none. */
export function humanCardIdOfRun(runId: unknown): string | null {
  return typeof runId === 'string' && runId.startsWith('run-') && runId.length > 4 ? runId.slice(4) : null;
}

/** One owner message, already validated by its caller (the room composer
 *  through room.post, or the phone). */
export interface HumanMessageInput {
  workspaceId: string;
  threadId?: ThreadId;
  title: string;
  body?: string;
  refs?: RoomCard['refs'];
  /** The bots it is for (parseMentions); wins over `to`. */
  mentions?: string[];
  /** The addressed role (see humanAddressee). */
  to?: BotRole;
  /** The addressed bot by id (the phone's bot): wins over `to`, not over
   *  `mentions`; a bot that is not enabled is no addressee. */
  toBotId?: string;
  replyTo?: string;
  clientPostId?: string;
  /** The owner's whole message when `body` is the card's capped copy (the
   *  phone takes messages longer than a card holds): the wake carries it. */
  wakeText?: string;
  source: 'desktop' | 'phone';
  /** Photos already in the room's store (roomAttachments.ts). */
  attachments?: RoomCard['attachments'];
}

/** One addressee's outcome. `wakeId` absent: its queue took no wake. */
export interface HumanAddresseeResult { botId: string; role: BotRole; wakeId?: string }

export type HumanMessageResult =
  | {
      ok: true;
      card: RoomCard;
      duplicate?: true;
      /** The first addressee (null: no bot to wake). Kept for the single
       *  addressee callers (the phone, the delivery line). */
      addressee?: { botId: string; role: BotRole } | null;
      wakeId?: string;
      /** Every addressee and its wake. */
      addressees?: HumanAddresseeResult[];
    }
  | { ok: false; code: 'invalid' | 'reply_to'; message: string }
  /** The card is up but some addressee's queue took no wake: send the same
   *  clientPostId again to queue the missing ones. */
  | { ok: false; code: 'queue_full'; message: string; card: RoomCard; addressees: HumanAddresseeResult[] };

/**
 * Post the owner's message: a `human` card in the workspace's room and, per
 * addressee, a directed `human.message` fact and a priority-0 wake. A repeat
 * of a clientPostId returns the first card and that message's wakes, queuing
 * the ones the first post could not.
 */
export function postHumanMessage(writer: RoomWriter, ports: Partial<FactoryRoomPorts>, input: HumanMessageInput): HumanMessageResult {
  const { workspaceId, source } = input;
  const threadId = input.threadId ?? GENERAL_THREAD;
  const text = (typeof input.wakeText === 'string' && input.wakeText.trim()
    ? input.wakeText
    : typeof input.body === 'string' && input.body.trim() ? input.body : input.title).trim();
  // `several`: the message went to more than one bot, each of which sees
  // the others' answers to it in its wake (wakeContext.ts). `routed`: the
  // card's routing when the message named no bot (RoomCard.routed): this
  // bot is the room's coordinator (`lead`), one waiting on the owner there
  // (addressed), or one of every bot of a room without a coordinator
  // (`roomWide`, with the routing's answerer as `roomAnswerer`).
  const wake = (card: RoomCard, to: BotProfile, said: string, several: boolean, routed: RoomCard['routed']): string | undefined => {
    const first = routed?.answerer;
    const waiting = routed?.waiting?.includes(to.id) === true;
    const asLead = !!routed?.lead && routed.lead === to.id;
    const roomWide = !!routed && !routed.lead && !waiting && several;
    try {
      return ports.wakes?.enqueue({
        botId: to.id,
        workspaceId: to.workspaceId,
        reason: {
          kind: 'human',
          // Processed whole, shortened last.
          text: redactStoredSecrets(said).slice(0, HUMAN_WAKE_TEXT_MAX),
          source,
          // The card's own id: a clientPostId is unique within one room
          // only, and the queue dedupes per bot across rooms.
          clientMessageId: card.id,
          runId: humanRunId(card.id),
          ...(several ? { room: true as const } : {}),
          ...(asLead ? { lead: true as const } : {}),
          ...(roomWide ? { roomWide: true as const, ...(first ? { roomAnswerer: first } : {}) } : {}),
        },
        priority: 0,
        // Pinned to the card's thread, General included: the addressee sees
        // the thread's latest cards (the other bots' answers) in its wake.
        threadId: card.threadId,
        overCap: true,
      })?.id;
    } catch (err) {
      console.warn('[factory] rooms: human wake not enqueued', err);
      return undefined;
    }
  };
  const answer = (card: RoomCard, results: HumanAddresseeResult[], duplicate: boolean): HumanMessageResult => {
    const first = results[0];
    const missing = ports.wakes ? results.filter((r) => !r.wakeId) : [];
    if (missing.length > 0) {
      const names = missing.map((m) => safeName(ports, m.botId)).join(', ');
      return { ok: false, code: 'queue_full', card, addressees: results, message: `The message is posted, but ${names} ${missing.length === 1 ? 'has' : 'have'} too many queued wakes to take it. Send it again later.` };
    }
    return {
      ok: true,
      card,
      ...(duplicate ? { duplicate: true as const } : {}),
      addressee: first ? { botId: first.botId, role: first.role } : null,
      ...(first?.wakeId ? { wakeId: first.wakeId } : {}),
      addressees: results,
    };
  };

  // A 1:1 thread names its one addressee.
  const dmBot = dmThreadBot(threadId);
  if (dmBot && safeGet(ports, dmBot)?.workspaceId !== workspaceId) {
    return { ok: false, code: 'invalid', message: 'a 1:1 thread is in its bot\'s own room' };
  }
  // A group's thread: its members, or those of them it names.
  const ownGroup = dmBot ? null : safeGroup(ports, workspaceId, threadId);
  if (!ownGroup && groupThreadGroup(threadId)) {
    return { ok: false, code: 'invalid', message: 'that group chat no longer exists' };
  }
  if (ownGroup && input.mentions?.some((id) => !ownGroup.memberIds.includes(id))) {
    return { ok: false, code: 'invalid', message: 'a group chat\'s message names its own bots only' };
  }
  const unnamed = !dmBot && !input.mentions?.length && input.toBotId === undefined && input.to === undefined;
  // A message naming no bot in a thread work in a group started goes to
  // that group, as one in the group's own thread does.
  const group = ownGroup ?? (unnamed ? linkedGroup(writer, ports, workspaceId, threadId) : null);
  const waitingIds = unnamed ? waitingOnOwner(writer, workspaceId, threadId) : [];
  const addressing = dmBot ? { mentions: [dmBot] }
    : group ? { mentions: input.mentions, toBotId: input.toBotId, to: input.to, members: group.memberIds, waiting: waitingIds }
    : { mentions: input.mentions, toBotId: input.toBotId, to: input.to, waiting: waitingIds };
  const { bots: to, room, lead } = humanAddressees(ports.bots, workspaceId, addressing);
  const waitingTo = to.filter((b) => waitingIds.includes(b.id)).map((b) => b.id);
  // Who answers a greeting or a question to the whole room: the first bot
  // not waiting there that takes turns, else the first that does (a parked
  // bot answers nothing, and the others would leave it to it).
  const answerer = (to.find((b) => !waitingTo.includes(b.id) && botTakesTurns(b)) ?? to.find((b) => botTakesTurns(b)))?.id;
  const routed: RoomCard['routed'] = lead
    ? { lead: to[0].id, ...(waitingTo.length > 0 ? { waiting: waitingTo } : {}) }
    : room ? { ...(waitingTo.length > 0 ? { waiting: waitingTo } : {}), ...(answerer ? { answerer } : {}) } : undefined;
  // A guest workspace is an island: a message in one names only its own
  // bots, and one elsewhere names none of a guest workspace's (desktop,
  // phone and the operator's room.post all come through here).
  const named = [...(input.mentions ?? []), ...(input.toBotId ? [input.toBotId] : [])].map((id) => safeGet(ports, id)).filter((b): b is BotProfile => !!b);
  if ([...named, ...to].some((b) => crossesGuestBoundary(workspaceId, b.workspaceId))) {
    return { ok: false, code: 'invalid', message: 'a guest workspace\'s bots are reached only from that workspace, and its messages reach only its own bots' };
  }
  const botIds = to.map((b) => b.id);
  const refs: RoomCard['refs'] = { ...(input.refs ?? {}) };
  delete refs.botId;
  delete refs.botIds;
  if (botIds.length > 0) refs.botIds = botIds;
  if (botIds.length === 1) refs.botId = botIds[0];
  const r = writer.post({
    workspaceId,
    threadId,
    kind: 'human',
    actor: { kind: 'human' },
    title: input.title,
    ...(input.body ? { body: input.body } : {}),
    refs,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(input.clientPostId ? { clientPostId: input.clientPostId } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(routed ? { routed } : {}),
  });
  if (!r.ok) return r;
  const card = r.card;
  if (r.duplicate) {
    // The same message again: its wakes, queued now where the first post
    // could not. The card says what the message is and whom it is for,
    // whatever the retry carries. Past the queue's retry window the first
    // wakes may be forgotten, so an older card queues nothing.
    if (Date.now() - card.at >= HUMAN_RETRY_WINDOW_MS) return r;
    const ids = cardAddressees(card);
    if (ids.length === 0) return r;
    const fromCard = (card.body?.trim() ? card.body : card.title).trim();
    // The retry's whole message when the card holds its capped copy.
    const said = input.wakeText?.trim() && card.body !== undefined && capBody(redactStoredSecrets(input.wakeText)) === card.body ? input.wakeText.trim() : fromCard;
    // The routing the message was posted with, as its card recorded it
    // (the retry's own fields, the bots' templates and the thread's state
    // now play no part).
    const results: HumanAddresseeResult[] = [];
    for (const id of ids) {
      const bot = safeGet(ports, id);
      if (!bot || !bot.enabled || crossesGuestBoundary(workspaceId, bot.workspaceId)) continue;
      const wakeId = wake(card, bot, said, ids.length > 1, card.routed);
      results.push({ botId: bot.id, role: bot.role, ...(wakeId ? { wakeId } : {}) });
    }
    return results.length > 0 ? answer(card, results, true) : r;
  }
  if (to.length === 0) return { ok: true, card, addressee: null, addressees: [] };
  const results: HumanAddresseeResult[] = [];
  for (const bot of to) {
    // Directed: ref.botId is the addressee, so no other bot wakes on it; one
    // fact per addressee (the message id names both, so none is deduped).
    const draft: FactDraft = {
      kind: 'human.message',
      at: card.at,
      workspaceId,
      ref: { botId: bot.id, messageId: `${card.id}:${bot.id}` },
      actor: { kind: 'human' },
      // Processed whole, shortened last.
      // `lead`: the words were to the whole room, which its coordinator alone
      // got (typed approval still reads them as the room's).
      payload: { text: capBody(redactStoredSecrets(text), HUMAN_FACT_TEXT_MAX), cardId: card.id, threadId, source, ...(lead ? { lead: true } : {}) },
    };
    try {
      ports.factLog?.append(draft);
    } catch (err) {
      console.warn('[factory] rooms: human.message fact not written', err);
    }
    const wakeId = wake(card, bot, text, to.length > 1, routed);
    results.push({ botId: bot.id, role: bot.role, ...(wakeId ? { wakeId } : {}) });
  }
  return answer(card, results, false);
}

/** The bots a stored owner card was addressed to. */
function cardAddressees(card: RoomCard): string[] {
  const ids = Array.isArray(card.refs?.botIds) ? card.refs.botIds.filter((id) => typeof id === 'string' && BOT_ID_RE.test(id)) : [];
  if (ids.length > 0) return [...new Set(ids)];
  return card.refs?.botId ? [card.refs.botId] : [];
}

function safeGet(ports: Partial<FactoryRoomPorts>, botId: string): BotProfile | null {
  try {
    return ports.bots?.get(botId) ?? null;
  } catch {
    return null;
  }
}

/** The bots waiting on the owner in a thread: the authors of its open
 *  questions and approval requests asked since the owner last spoke there
 *  (words that answered nothing then do not keep a bot waiting forever),
 *  oldest first. */
function waitingOnOwner(writer: RoomWriter, workspaceId: string, threadId: ThreadId): string[] {
  const ids: string[] = [];
  try {
    // A scan, newest first, that stops at the owner's previous message there.
    writer.find(workspaceId, (c) => {
      if (c.threadId !== threadId) return false;
      if (c.kind === 'human' && c.actor.kind === 'human') return true;
      if ((c.kind === 'question' || c.kind === 'approval') && c.state === 'open' && c.actor.kind === 'bot') ids.unshift(c.actor.botId);
      return false;
    }, { guests: true });
  } catch {
    return [];
  }
  return [...new Set(ids)];
}

/** The live group whose work a thread is: the group a coordinator's
 *  request thread was opened in (RoomWriter.summary's groupId), else — for
 *  a thread no 1:1 started — the group living in General, whose view shows
 *  every other thread of the room. Null when there is none. */
function linkedGroup(writer: RoomWriter, ports: Partial<FactoryRoomPorts>, workspaceId: string, threadId: ThreadId) {
  if (threadId === GENERAL_THREAD || dmThreadBot(threadId) || groupThreadGroup(threadId)) return null;
  try {
    const summary = writer.summary(workspaceId, threadId);
    if (summary.groupId) return safeGroup(ports, workspaceId, groupThreadId(summary.groupId));
    return summary.dmBotId ? null : safeGroup(ports, workspaceId, GENERAL_THREAD);
  } catch {
    return null;
  }
}

function safeGroup(ports: Partial<FactoryRoomPorts>, workspaceId: string, threadId: ThreadId) {
  try {
    return ports.groups?.byThread(workspaceId, threadId) ?? null;
  } catch {
    return null;
  }
}

function safeName(ports: Partial<FactoryRoomPorts>, botId: string): string {
  const b = safeGet(ports, botId);
  return b ? b.name || b.role : botId;
}
