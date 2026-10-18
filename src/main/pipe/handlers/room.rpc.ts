// room.* — the rooms (shared/room.ts ROOM_RPC), registered with
// registerFactoryRpcModule (main/factory/factoryHost.ts).
//
// Who may call what (the handler is the gate; design §13 rules 1–2):
//   room.post     a bot: a card of a BOT_POSTABLE_CARD_KINDS kind into its own
//                 workspace's room, actor = its binding, in the thread of the
//                 wake it is running unless it names one; each bot it
//                 `mentions` (existing, enabled, not itself) is stored in
//                 refs.botIds and woken once through the handoff router (a
//                 `message` in the poster's chain). The operator: a `human`
//                 card into the named workspace's room, which is also a
//                 `human.message` fact and a priority-0 wake for each bot it is
//                 for (humanMessage.ts: the `mentions`, else the `to` role,
//                 else every bot of the room; in a group chat's thread, its
//                 members or those it names). Addressing is a field, never
//                 text: an `@name` in a card wakes nobody. Posts are
//                 idempotent by clientPostId.
//   room.read     a bot: its own room (a Coordinator-template bot, by its live
//                 profile: any room); the operator: any room, and may record
//                 its read position (markThroughSeq).
//   room.threads  the operator.
//   room.resolve  the operator: answers a question card (through its
//                 decision, which the handoff router turns into the answer)
//                 or closes a proposal / plan card.
// Any other caller — no bot binding and not the operator — is refused.

import path from 'node:path';
import type { BotBinding, BotProfile, BotRole } from '../../../shared/bot';
import { isBotRole, isCoordinatorBot } from '../../../shared/bot';
import { SHARED_SURFACE, type BotToolName, type FactoryRefusal } from '../../../shared/botSurface';
import {
  BOT_POSTABLE_CARD_KINDS,
  GENERAL_THREAD,
  ROOM_EVENT,
  ROOM_LIMITS,
  ROOM_RPC,
  parseThreadId,
  type CardKind,
  type RoomCard,
  type RoomPostParams,
  type RoomReadParams,
  type RoomReadResult,
  type RoomResolveParams,
  type RoomThreadsParams,
} from '../../../shared/room';
import type { RpcContext } from '../../../shared/rpc';
import type { WakeItem } from '../../../shared/wake';
import { resolveThreadDecision } from '../../deck/deckDecisionStore';
import { setBotRuntimePorts } from '../../factory/BotRuntime';
import { registerFactoryRpcModule, type FactoryHostDeps, type FactoryModuleHandle, type FactoryRouter } from '../../factory/factoryHost';
import { getHandoffRouter } from '../../factory/handoffRouter';
import { redactStoredSecrets } from '../../factory/secretRedaction';
import { HUMAN_RETRY_WINDOW_MS } from '../../factory/wakeQueue';
import {
  ROOMS_DIRNAME,
  RoomWriter,
  botThreadRefusal,
  capBody,
  getRoomWriter,
  isClientId,
  isRoomWorkspaceId,
  oneLine,
  resolveRoomPorts,
  runningWake,
  runningWakeThread,
  sanitizeRefs,
  setRoomWriter,
  wakeReplyTo,
  writeFactCards,
  writeBotHookCard,
  wakeOrdinals,
  emitHumanCorrection,
  type FactoryRoomPorts,
  type HumanCorrection,
  type RoomEventPayload,
} from '../../factory/roomWriter';
import { humanAddressee, parseMentions, postHumanMessage } from '../../factory/humanMessage';
import { parseResolution } from '../../factory/morningReport';
import { getRoomAttachmentStore, type RoomAttachmentStore } from '../../factory/roomAttachments';
import { parseRoomAttachments, type RoomAttachment } from '../../../shared/roomAttachments';

// The owner's messages (shared with the phone) live in factory/humanMessage.ts.
export { humanAddressee, postHumanMessage };


// ── Caller ─────────────────────────────────────────────────────────────────

export type FactoryCaller = { kind: 'bot'; bot: BotBinding } | { kind: 'operator' };

export function refusal<C extends string>(code: C, message: string): FactoryRefusal<C> {
  return { ok: false, code, message };
}

/** The caller of a factory handler: a validated bot binding or the operator,
 *  else a refusal. */
export function factoryCaller(ctx: RpcContext | undefined): FactoryCaller | FactoryRefusal<'not_bot'> {
  if (ctx?.bot) return { kind: 'bot', bot: ctx.bot };
  if (ctx?.operator === true) return { kind: 'operator' };
  return refusal('not_bot', 'this call needs a bot identity or the operator');
}

/** The tool is on the bot surface, for a binding whose role tag is one (a
 *  malformed binding holds nothing). */
export function botHasTool(bot: BotBinding, tool: BotToolName): boolean {
  return isBotRole(bot.role) && SHARED_SURFACE.tools.has(tool);
}

/** The bot reads other workspaces' rooms: its live profile is a
 *  Coordinator's (never the role tag). Unknown bot or no directory: no. */
export function botReadsEveryRoom(ports: Partial<FactoryRoomPorts>, botId: string): boolean {
  try {
    return isCoordinatorBot(ports.bots?.get(botId));
  } catch {
    return false;
  }
}

function params(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

// ── Handlers ───────────────────────────────────────────────────────────────

export interface RoomHandlerDeps {
  writer: () => RoomWriter | null;
  ports: () => Partial<FactoryRoomPorts>;
  wmuxDir: () => string;
  /** The room's photo store. Default: the factory's. */
  attachments?: () => RoomAttachmentStore | null;
}

/** The operator's stored photos, undefined for none, null when one is not a
 *  file of this room's store of the size the record says. */
function operatorPhotos(value: unknown, workspaceId: string, deps: RoomHandlerDeps): RoomAttachment[] | undefined | null {
  if (value === undefined) return undefined;
  const parsed = parseRoomAttachments(value);
  if (!parsed || !Array.isArray(value) || parsed.length !== value.length) return null;
  const store = deps.attachments ? deps.attachments() : getRoomAttachmentStore();
  if (!store) return null;
  return parsed.every((a) => store.size(workspaceId, a.id) === a.bytes) ? parsed : null;
}

function notStarted(): FactoryRefusal<'not_started'> {
  return refusal('not_started', 'rooms are not running yet');
}

export async function handleRoomPost(raw: unknown, ctx: RpcContext | undefined, deps: RoomHandlerDeps): Promise<unknown> {
  const caller = factoryCaller(ctx);
  if ('ok' in caller) return caller;
  const writer = deps.writer();
  if (!writer) return notStarted();
  const p = params(raw) as Partial<RoomPostParams> & { workspaceId?: unknown; to?: unknown };
  // The canonical spelling of the thread named (one PR is one thread).
  const namedThread = p.threadId === undefined ? undefined : parseThreadId(p.threadId);
  if (namedThread === null) return refusal('invalid', 'threadId is not a thread id');
  if (typeof p.title !== 'string' || !oneLine(p.title, ROOM_LIMITS.TITLE_MAX)) return refusal('invalid', 'title is required');
  if (p.body !== undefined && (typeof p.body !== 'string' || p.body.length > ROOM_LIMITS.CARD_BODY_MAX)) {
    return refusal('invalid', `body must be text of at most ${ROOM_LIMITS.CARD_BODY_MAX} characters`);
  }
  if (p.clientPostId !== undefined && !isClientId(p.clientPostId)) return refusal('invalid', 'clientPostId is not a valid key');
  if (p.replyTo !== undefined && (typeof p.replyTo !== 'string' || !p.replyTo)) return refusal('invalid', 'replyTo is not a card id');
  const ports = deps.ports();
  const refs = sanitizeRefs(p.refs);
  // Whom a card is for is main's to settle (mentions below), never a ref;
  // nor is the request a thread answers (main links it on the opening hop).
  if (refs) { delete refs.botIds; delete refs.requestCardId; }
  const mentions = p.mentions === undefined ? undefined : parseMentions(p.mentions);
  if (mentions === null) return refusal('invalid', `mentions must be at most ${ROOM_LIMITS.MENTIONS_MAX} bot ids`);

  if (caller.kind === 'bot') {
    const bot = caller.bot;
    if (!botHasTool(bot, 'room_post')) return refusal('surface', 'room_post is not on the bot surface');
    if (!(BOT_POSTABLE_CARD_KINDS as readonly unknown[]).includes(p.kind)) {
      return refusal('card_kind', `a bot posts one of: ${BOT_POSTABLE_CARD_KINDS.join(', ')}`);
    }
    if (p.workspaceId !== undefined && p.workspaceId !== bot.workspaceId) {
      return refusal('cross_workspace', 'a bot posts into its own workspace\'s room');
    }
    // Main pins the thread: the one named, else the running wake's. Another
    // bot's 1:1 is named only from the wake running in it; a group chat's
    // thread by its members, or from the wake running in it. A bot woken in
    // a thread opened for a dispatch that names the conversation the
    // dispatch was said in posts in the opened thread (postThread).
    const wakeThread = runningWakeThread(ports, bot.botId);
    const pinned = getHandoffRouter()?.postThread(bot.botId, namedThread) ?? namedThread;
    const threadRefused = botThreadRefusal(ports, bot, pinned);
    if (threadRefused) return refusal('invalid', threadRefused);
    const threadId = pinned ?? wakeThread ?? GENERAL_THREAD;
    const wake = runningWake(ports, bot.botId);
    const clientPostId = p.clientPostId ?? wakeOrdinals.next(wake, 'post');
    // A card the bot names no parent for answers the owner message its wake
    // is about, when it lands in that message's thread. A post moved to the
    // opened thread drops the parent it named in the conversation.
    const replyTo = (pinned === namedThread ? p.replyTo : undefined) ?? wakeReplyTo(writer, wake, bot.workspaceId, threadId);
    const { valid, dropped } = settleMentions(ports, bot, mentions ?? []);
    const r = writer.post({
      workspaceId: bot.workspaceId,
      threadId,
      kind: p.kind as CardKind,
      actor: { kind: 'bot', workspaceId: bot.workspaceId, botId: bot.botId },
      title: p.title,
      ...(p.body ? { body: p.body } : {}),
      ...(refs || valid.length > 0 ? { refs: { ...(refs ?? {}), ...(valid.length > 0 ? { botIds: valid } : {}) } } : {}),
      ...(p.kind === 'proposal' || p.kind === 'plan' ? { state: 'open' as const } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(clientPostId ? { clientPostId } : {}),
    });
    if (!r.ok) return r;
    // The card's own addressees wake (a repeat of the post routes the same
    // ones again, which the router answers from its records: no bot wakes
    // twice for one card).
    const named = r.card.actor.kind === 'bot' && r.card.actor.botId === bot.botId ? r.card.refs?.botIds ?? [] : [];
    // A repeat routes again only within the retry window, while the router
    // still holds the card's handoffs; an older repeat wakes nobody.
    const stale = r.duplicate === true && Date.now() - r.card.at > HUMAN_RETRY_WINDOW_MS;
    if (named.length === 0 || stale) return dropped.length > 0 ? { ...r, droppedMentions: dropped } : r;
    const router = getHandoffRouter();
    const routed = router
      ? router.mention(bot, r.card, named).map(({ botId, result }) => (result.ok
        ? { botId, ok: true as const, handoffId: result.handoffId, ...(result.duplicate ? { duplicate: true as const } : {}) }
        : { botId, ok: false as const, code: result.code, message: result.message }))
      : named.map((botId) => ({ botId, ok: false as const, code: 'not_started', message: 'handoffs are not running yet' }));
    return { ...r, mentions: routed, ...(dropped.length > 0 ? { droppedMentions: dropped } : {}) };
  }

  // The operator: a human message.
  if (p.kind !== undefined && p.kind !== 'human') return refusal('card_kind', 'the owner posts human cards');
  if (!isRoomWorkspaceId(p.workspaceId)) return refusal('invalid', 'workspaceId is required');
  if (p.to !== undefined && !isBotRole(p.to)) return refusal('invalid', 'to is not a bot role');
  // Photos the renderer's room bridge already copied into the room's store
  // (room.handler.ts postWithPhotos): read for the operator only, and each
  // must be a stored file of this room of that size.
  const photos = ctx?.operator === true ? operatorPhotos((p as { attachments?: unknown }).attachments, p.workspaceId, deps) : undefined;
  if (photos === null) return refusal('invalid', 'attachments are not photos of this room');
  const posted = postHumanMessage(writer, ports, {
    workspaceId: p.workspaceId,
    ...(namedThread !== undefined ? { threadId: namedThread } : {}),
    title: p.title,
    ...(p.body ? { body: p.body } : {}),
    ...(refs ? { refs } : {}),
    ...(mentions && mentions.length > 0 ? { mentions } : {}),
    ...(p.to !== undefined ? { to: p.to as BotRole } : {}),
    ...(p.replyTo ? { replyTo: p.replyTo } : {}),
    ...(p.clientPostId ? { clientPostId: p.clientPostId } : {}),
    source: 'desktop',
    ...(photos ? { attachments: photos } : {}),
  });
  // The owner hears "sent" once the wakes are on disk: a restart then still
  // runs them. A failed write is retryable with the same clientPostId (the
  // same card, its wakes queued once).
  if (posted.ok && posted.addressees?.some((a) => a.wakeId) && ports.wakes?.flush) {
    try {
      await ports.wakes.flush();
    } catch (err) {
      console.warn(`[factory] rooms: owner message wakes not on disk: ${String(err)}`);
      return { ok: false, code: 'write_failed', message: 'The message is posted, but its wakes could not be saved. Send it again.', card: posted.card, addressees: posted.addressees };
    }
  }
  return posted;
}

/** A bot's turn that ended with words but wrote no card of its own in its
 *  wake's thread since `since`: those words become its card there, through
 *  handleRoomPost as the bot (the same surface, thread, reply link and
 *  checks as a room_post). The first line is the title, the rest the body,
 *  capped as a card's. Call it while the wake still runs. */
export async function postTurnText(
  profile: Pick<BotProfile, 'id' | 'workspaceId' | 'role'>,
  item: Pick<WakeItem, 'id'>,
  text: string,
  since: number,
  deps: RoomHandlerDeps,
): Promise<unknown> {
  const writer = deps.writer();
  // Processed whole, then shortened into a title and a body.
  const trimmed = capBody(redactStoredSecrets(text)).trim();
  if (!writer || !trimmed) return null;
  const threadId = runningWakeThread(deps.ports(), profile.id) ?? GENERAL_THREAD;
  // A card the bot wrote in this thread during the turn (a room_post, a
  // question, a handoff), or in an earlier attempt of the same wake (a
  // retried room_post returns that card), already answered: nothing more.
  const attemptKey = `wake:${item.id}:`;
  const own = writer.find(profile.workspaceId, (c) => c.threadId === threadId
    && c.actor.kind === 'bot' && c.actor.botId === profile.id
    && (c.at > since || c.clientPostId?.startsWith(attemptKey) === true));
  if (own) return null;
  const nl = trimmed.indexOf('\n');
  const first = nl < 0 ? trimmed : trimmed.slice(0, nl);
  const line = oneLine(first, ROOM_LIMITS.CARD_BODY_MAX);
  const title = line.slice(0, ROOM_LIMITS.TITLE_MAX).trim();
  if (!title) return null;
  // A first line longer than a title keeps the whole text in the body.
  const body = line.length > title.length ? trimmed : (nl < 0 ? '' : trimmed.slice(nl + 1).trim());
  return handleRoomPost(
    { kind: 'status', title, ...(body ? { body } : {}), clientPostId: `wake:${item.id}:text` },
    { origin: 'local', bot: { workspaceId: profile.workspaceId, botId: profile.id, role: profile.role } },
    deps,
  );
}

/** A bot card's mentions split into the bots that wake (existing, enabled,
 *  not the poster) and the rest, each with why. Pure over the directory. */
export function settleMentions(
  ports: Partial<FactoryRoomPorts>,
  poster: BotBinding,
  mentions: readonly string[],
): { valid: string[]; dropped: Array<{ botId: string; reason: 'self' | 'not_enabled' }> } {
  const valid: string[] = [];
  const dropped: Array<{ botId: string; reason: 'self' | 'not_enabled' }> = [];
  for (const botId of mentions) {
    if (botId === poster.botId) {
      dropped.push({ botId, reason: 'self' });
      continue;
    }
    let bot: ReturnType<FactoryRoomPorts['bots']['get']> = null;
    try {
      bot = ports.bots?.get(botId) ?? null;
    } catch {
      bot = null;
    }
    if (bot && bot.enabled) valid.push(botId);
    else dropped.push({ botId, reason: 'not_enabled' });
  }
  return { valid, dropped };
}

/** The room a read / threads call may see, or a refusal. */
function readableWorkspace(
  caller: FactoryCaller,
  requested: unknown,
  tool: BotToolName | null,
  ports: Partial<FactoryRoomPorts>,
): string | FactoryRefusal {
  if (caller.kind === 'operator') {
    return isRoomWorkspaceId(requested) ? requested : refusal('invalid', 'workspaceId is required');
  }
  const bot = caller.bot;
  if (tool && !botHasTool(bot, tool)) return refusal('surface', `${tool} is not on the bot surface`);
  if (requested === undefined || requested === bot.workspaceId) return bot.workspaceId;
  if (!botReadsEveryRoom(ports, bot.botId)) return refusal('cross_workspace', 'a bot reads its own workspace\'s room; another room is a Coordinator\'s read');
  return isRoomWorkspaceId(requested) ? requested : refusal('invalid', 'workspaceId is not a workspace id');
}

export function handleRoomRead(raw: unknown, ctx: RpcContext | undefined, deps: RoomHandlerDeps): unknown {
  const caller = factoryCaller(ctx);
  if ('ok' in caller) return caller;
  const writer = deps.writer();
  if (!writer) return notStarted();
  const p = params(raw) as Partial<RoomReadParams>;
  const ws = readableWorkspace(caller, p.workspaceId, 'room_read', deps.ports());
  if (typeof ws !== 'string') return ws;
  const threadId = p.threadId === undefined ? null : parseThreadId(p.threadId);
  if (p.threadId !== undefined && !threadId) return refusal('invalid', 'threadId is not a thread id');
  if (p.markThroughSeq !== undefined) {
    if (caller.kind !== 'operator') return refusal('operator_only', 'only the owner records a read position');
    if (!threadId || typeof p.markThroughSeq !== 'number') return refusal('invalid', 'markThroughSeq needs a threadId and a seq');
    writer.markRead(ws, threadId, p.markThroughSeq);
  }
  const page = writer.read(ws, {
    ...(threadId ? { threadId } : {}),
    ...(typeof p.sinceSeq === 'number' ? { sinceSeq: p.sinceSeq } : {}),
    ...(typeof p.limit === 'number' ? { limit: p.limit } : {}),
  });
  const result: RoomReadResult = { ok: true, workspaceId: ws, threadId, ...page };
  return result;
}

export function handleRoomThreads(raw: unknown, ctx: RpcContext | undefined, deps: RoomHandlerDeps): unknown {
  const caller = factoryCaller(ctx);
  if ('ok' in caller) return caller;
  if (caller.kind !== 'operator') return refusal('operator_only', 'room.threads is the operator\'s');
  const writer = deps.writer();
  if (!writer) return notStarted();
  const p = params(raw) as Partial<RoomThreadsParams>;
  if (!isRoomWorkspaceId(p.workspaceId)) return refusal('invalid', 'workspaceId is required');
  return { ok: true, workspaceId: p.workspaceId, threads: writer.threads(p.workspaceId) };
}

/** The correction an owner's answer to a bot's plan / proposal card makes:
 *  a decline or an edit (anything but an approval, as the plan's reader
 *  parses it). null for an approval or a card no bot wrote. Pure. */
export function resolutionCorrection(card: RoomCard, resolution: string): HumanCorrection | null {
  if (card.actor.kind !== 'bot' || (card.kind !== 'plan' && card.kind !== 'proposal')) return null;
  const answer = parseResolution(resolution);
  if (answer === 'approve') return null;
  const note = answer === 'edit' ? resolution.replace(/^\s*edit:/i, '') : '';
  return {
    workspaceId: card.workspaceId,
    botId: card.actor.botId,
    messageId: card.id,
    category: answer === 'decline'
      ? (card.kind === 'plan' ? 'plan-declined' : 'proposal-declined')
      : (card.kind === 'plan' ? 'plan-edited' : 'proposal-edited'),
    cardKind: card.kind,
    threadId: card.threadId,
    ...(note.trim() ? { note } : {}),
  };
}

/** Told when the operator closes a proposal / plan card (the roles that act
 *  on an approval subscribe). */
export type RoomCardResolvedListener = (ev: { workspaceId: string; card: RoomCard; resolution: string }) => void;
const resolvedListeners = new Set<RoomCardResolvedListener>();

export function onRoomCardResolved(fn: RoomCardResolvedListener): () => void {
  resolvedListeners.add(fn);
  return () => resolvedListeners.delete(fn);
}

export async function handleRoomResolve(raw: unknown, ctx: RpcContext | undefined, deps: RoomHandlerDeps): Promise<unknown> {
  const caller = factoryCaller(ctx);
  if ('ok' in caller) return caller;
  if (caller.kind !== 'operator') return refusal('operator_only', 'room.resolve is the operator\'s');
  const writer = deps.writer();
  if (!writer) return notStarted();
  const p = params(raw) as Partial<RoomResolveParams>;
  if (!isRoomWorkspaceId(p.workspaceId) || typeof p.cardId !== 'string') return refusal('invalid', 'workspaceId and cardId are required');
  const resolution = typeof p.resolution === 'string' ? p.resolution.trim() : '';
  if (!resolution) return refusal('invalid', 'resolution is required');
  const card = writer.get(p.workspaceId, p.cardId);
  if (!card) return refusal('not_found', `no card ${p.cardId}`);
  if (card.state !== 'open') return refusal('not_pending', 'the card is not open');
  if (card.kind === 'question') {
    const decisionId = card.refs?.decisionId;
    if (!decisionId) return refusal('not_pending', 'the question has no decision');
    const resolved = await resolveThreadDecision(p.workspaceId, decisionId, resolution, { resolvedBy: 'human' }, deps.wmuxDir());
    if (!resolved) return refusal('not_pending', 'the question was answered already');
    // The router settles on the store's change notice too; waiting here
    // lets the caller read the closed card back.
    await getHandoffRouter()?.reconcile();
    return { ok: true, card: writer.get(p.workspaceId, p.cardId) ?? card };
  }
  const closed = writer.setState(p.workspaceId, card.id, 'resolved');
  if (!closed) return refusal('not_pending', 'the card is not open');
  writer.append({
    workspaceId: p.workspaceId,
    threadId: card.threadId,
    kind: 'fact',
    actor: { kind: 'human' },
    title: `Resolved: ${card.title}`,
    body: resolution,
    refs: { ...(card.refs?.handoffId ? { handoffId: card.refs.handoffId } : {}) },
  });
  const correction = resolutionCorrection(closed, resolution);
  if (correction) emitHumanCorrection(deps.ports(), correction);
  for (const fn of resolvedListeners) {
    try {
      fn({ workspaceId: p.workspaceId, card: closed, resolution });
    } catch (err) {
      console.warn('[factory] rooms: card-resolved listener failed', err);
    }
  }
  return { ok: true, card: closed };
}

export function registerRoomHandlers(router: Pick<FactoryRouter, 'register'>, deps: RoomHandlerDeps): void {
  router.register(ROOM_RPC.post, (raw, ctx) => handleRoomPost(raw, ctx, deps));
  router.register(ROOM_RPC.read, async (raw, ctx) => handleRoomRead(raw, ctx, deps));
  router.register(ROOM_RPC.threads, async (raw, ctx) => handleRoomThreads(raw, ctx, deps));
  router.register(ROOM_RPC.resolve, (raw, ctx) => handleRoomResolve(raw, ctx, deps));
}

// ── Module ─────────────────────────────────────────────────────────────────

export function createRoomModule(
  deps: Pick<FactoryHostDeps, 'wmuxDir' | 'getMainWindow'>,
  resolve: () => Partial<FactoryRoomPorts> = resolveRoomPorts,
): FactoryModuleHandle {
  const offs: Array<() => void> = [];
  return {
    start() {
      if (getRoomWriter()) return;
      const writer = new RoomWriter({
        dir: path.join(deps.wmuxDir(), 'factory', ROOMS_DIRNAME),
        emit: (payload: RoomEventPayload) => {
          const win = deps.getMainWindow();
          if (win && !win.isDestroyed()) win.webContents.send(ROOM_EVENT, payload);
        },
      });
      setRoomWriter(writer);
      setBotRuntimePorts({
        postTurnText: (profile, item, text, since) => postTurnText(profile, item, text, since, { writer: getRoomWriter, ports: resolve, wmuxDir: deps.wmuxDir }),
      });
      const ports = resolve();
      if (ports.factLog) {
        offs.push(ports.factLog.subscribe((fact) => {
          const cards = writeFactCards(writer, fact, resolve().bots);
          // A card that ends its thread's subject (a PR merged or closed, an
          // issue closed, a task done) closes that thread's open questions.
          for (const c of cards) if (c.closes) void getHandoffRouter()?.closeThreadQuestions(c.workspaceId, c.threadId).catch(() => undefined);
        }));
      }
      if (ports.botHooks) offs.push(ports.botHooks.subscribe((ev) => void writeBotHookCard(writer, ev, resolve().bots)));
      if (!ports.factLog) console.info('[factory] rooms: fact log not wired; rooms get no system cards');
    },
    dispose() {
      for (const off of offs.splice(0)) off();
      setRoomWriter(null);
    },
  };
}

registerFactoryRpcModule('rooms', (router, deps) => {
  registerRoomHandlers(router, { writer: getRoomWriter, ports: resolveRoomPorts, wmuxDir: deps.wmuxDir });
  return createRoomModule(deps);
});
