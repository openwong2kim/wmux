// routine.* and bot.stopMyWork — a bot's own routines and its own stop
// (shared/botRoutine.ts ROUTINE_RPC, shared/bot.ts BOT_RPC.stopMyWork),
// registered as the `routines` factory module (main/factory/factoryHost.ts).
//
// Who may call what (the handler is the gate):
//   routine.set     a bot, for itself only (the binding names it), and only in
//                   a turn on the owner's words (their message, or their
//                   answer to its question): a routine is a standing
//                   instruction the owner gave. Never from a conversation
//                   that took in outside text (conversationMarks.ts): the
//                   owner's words in it do not make what it read clean.
//                   There, a new routine the owner's own message asked for
//                   (their stored card, factory/ownerAsked.ts) becomes a
//                   `routine` approval card showing it whole instead, and
//                   their Approve on it saves it (approvals.ts
//                   proposeOwnerAsked); never from a turn started from
//                   outside text or a conversation holding a signed-in
//                   task's data, never a change to a routine, never in a
//                   thread other than the bot's 1:1 or the message's.
//                   Idempotent by clientRoutineId
//                   (default `wake:<wakeId>:r<n>` from the running wake).
//   routine.list    a bot: its own; the operator: one bot's (botId) or all.
//   routine.pause   a bot: pause or resume its own, at any time.
//   routine.ownerSet / ownerPause / ownerRemove / ownerRun
//                   the operator (the main window) only, never a bot or the
//                   phone, and only for a bot on My Hermes: the owner writes,
//                   pauses, deletes or runs now that bot's routines (a bot
//                   moved off My Hermes: pause and delete the owner's own
//                   routines only, so none is left that no one can stop). ownerSet
//                   marks a routine `author: 'owner'` and runs it in the bot's
//                   1:1; it changes only a routine the owner wrote. Only such
//                   a routine is sent to My Hermes (myHermesTurn.ts).
//   bot.stopMyWork  a bot, for itself only: its open tasks, their gates and
//                   workers are stopped and its routines paused, as the
//                   owner's Stop bot does (factory/factoryStop.ts), except
//                   that its own running turn goes on to its end (so it can
//                   say so); that turn launches no further worker.
// Anyone else is refused. Before the module started every method answers
// `not_started`.
//
// start() loads routines.json, starts the timer that fires them, lets the
// bot runtime show a routine in its wake and tell this module about parks,
// off switches and removals, and pauses / resumes routines with the "Run
// bots" switch.

import path from 'node:path';
import { BOT_EVENT, BOT_RPC, BOT_ID_RE, isOwnHermesEngine, type BotBinding, type BotEventPayload, type BotProfile } from '../../../shared/bot';
import { ROUTINE_RPC, ROUTINE_LIMITS, type RoutineOwnerSetParams, type RoutineSetParams } from '../../../shared/botRoutine';
import { dmThreadId, parseThreadId } from '../../../shared/room';
import type { RpcContext } from '../../../shared/rpc';
import { registerFactoryRpcModule, type FactoryHostDeps, type FactoryRouter } from '../../factory/factoryHost';
import { TAINTED_CONVERSATION_SAVES_NOTHING, conversationSignedIn, conversationTainted } from '../../factory/conversationMarks';
import { getApprovalService, type ApprovalRoutineHost, type ApprovalService } from '../../factory/approvals';
import { runningOwnerCardProof, type OwnerCardProof } from '../../factory/ownerAsked';
import { RoutineStore, getRoutineStore, routinesPath, scheduleLabel, setRoutineStore } from '../../factory/routines';
import { getBotDirectory } from '../../factory/botStore';
import { getWakeQueue, currentWakeItem } from '../../factory/wakeQueue';
import { getFactLog } from '../../factory/factLog';
import { getRoomWriter, resolveRoomPorts, runningWake, wakeOrdinals, wakeReplyTo } from '../../factory/roomWriter';
import { getFactorySettings, onFactorySettingsChanged } from '../../factory/factorySettings';
import { setBotRuntimePorts, type BotLifecycleEvent } from '../../factory/BotRuntime';
import { summarizeHandoff } from '../../factory/handoffRouter';
import { GUEST_TURN_STARTS_NO_WORKERS, guestOfRunningWake, runningWakeTainted, type GuestProvenance } from '../../factory/wakeTaint';
import { getFactoryStopPorts, stopFactoryWork } from '../../factory/factoryStop';

type Refusal = { ok: false; code: 'not_authorized' | 'not_started' | 'invalid_argument'; message: string };

function refuse(code: Refusal['code'], message: string): Refusal {
  return { ok: false, code, message };
}

function obj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

const NOT_STARTED = refuse('not_started', 'routines are not running yet');

/** What a bot hears when its routine waits on the owner's card. */
export const ROUTINE_PENDING = 'Waiting for the owner: this conversation has read outside text, so the routine is on an approval card that shows it whole, and only their Approve saves it. Tell them it is there.';

/** Why a routine is not changed from a conversation that took in outside text. */
export const ROUTINE_CHANGE_REFUSED = 'this conversation has taken in outside text, so it changes no routine, even on the owner\'s words (it may only propose a new one for the owner to approve); ask the owner to start a new conversation with you (New conversation, on your profile in the Bots page) and to ask for it again there';

/** Why a routine from such a conversation does not run in that thread. */
export const ROUTINE_THREAD_REFUSED = 'a routine proposed from a conversation that has read outside text runs in your 1:1 or in the thread the owner asked in; leave thread_id out (it runs where the owner asked) or name your 1:1';

/** The running turn of a bot is on the owner's words: their message, or an
 *  answer to the bot's question (not one closed without an answer). Never
 *  throws. */
export function turnOnOwnerWords(botId: string, deps: { wake?: typeof currentWakeItem; handoff?: typeof summarizeHandoff } = {}): boolean {
  try {
    const item = (deps.wake ?? currentWakeItem)(botId);
    if (!item) return false;
    if (item.reason.kind === 'human') return true;
    if (item.reason.kind !== 'handoff') return false;
    const h = (deps.handoff ?? summarizeHandoff)(item.reason.handoffId);
    // A question the owner closed without an answer gave no instruction.
    return h?.ownerWords === true && h.dismissed !== true;
  } catch {
    return false;
  }
}

export interface RoutineHandlerDeps {
  store: () => RoutineStore | null;
  ownerWords?: (botId: string) => boolean;
  /** The guest provenance of the bot's running wake. Default: wakeTaint.ts. */
  guestWake?: (botId: string) => GuestProvenance;
  /** Whether the bot's live conversation took in outside text (none: yes).
   *  Default: conversationMarks.ts. */
  conversationTainted?: (botId: string) => boolean;
  /** Whether the bot's live conversation holds a signed-in task's data
   *  (none: yes). Default: conversationMarks.ts. */
  conversationSignedIn?: (botId: string) => boolean;
  /** Whether the bot's running wake is tainted (unknown: yes). Default: wakeTaint.ts. */
  wakeTainted?: (botId: string) => boolean;
  /** The owner's card the running wake is on, or null. Default: ownerAsked.ts. */
  ownerCard?: (botId: string) => OwnerCardProof | null;
  /** The approval store. Default: getApprovalService. */
  approvals?: () => Pick<ApprovalService, 'proposeOwnerAsked'> | null;
  /** The default idempotency key of a routine set in the running turn. */
  defaultKey?: (botId: string) => string | undefined;
  stop?: (botId: string) => Promise<{ ok: boolean; workersStopped: number; gatesCancelled: number; routinesPaused?: number; code?: string; message?: string }>;
  /** A bot's profile. Default: the bot directory. */
  bot?: (botId: string) => BotProfile | null;
}

/** The My Hermes bot an owner routine call names, or why not. With
 *  `anyEngine` (pause, delete), a bot no longer on My Hermes passes too, so
 *  the owner's routines are never left with no one to stop them. */
function ownerRoutineBot(raw: Record<string, unknown>, ctx: RpcContext | undefined, deps: RoutineHandlerDeps, anyEngine = false): { ok: true; bot: BotProfile } | Refusal {
  if (ctx?.operator !== true) return refuse('not_authorized', 'only the owner, in the wmux window, manages these routines');
  const botId = raw.botId;
  if (typeof botId !== 'string' || !BOT_ID_RE.test(botId)) return refuse('invalid_argument', 'botId must be a bot id');
  let bot: BotProfile | null = null;
  try {
    bot = (deps.bot ?? ((id: string) => getBotDirectory()?.get(id) ?? null))(botId);
  } catch {
    bot = null;
  }
  if (!bot) return refuse('invalid_argument', `no bot ${botId}`);
  if (!anyEngine && !isOwnHermesEngine(bot.engine)) return refuse('not_authorized', 'the owner\'s routines are for a bot on My Hermes');
  return { ok: true, bot };
}

export function registerRoutineHandlers(router: Pick<FactoryRouter, 'register'>, deps: RoutineHandlerDeps): void {
  router.register(ROUTINE_RPC.set, async (raw, ctx?: RpcContext) => {
    if (!ctx?.bot) return refuse('not_authorized', 'a bot sets its own routines');
    const store = deps.store();
    if (!store) return NOT_STARTED;
    const bot = ctx.bot;
    if (!(deps.ownerWords ?? turnOnOwnerWords)(bot.botId)) {
      return refuse('not_authorized', 'a routine is set in a turn on the owner\'s words: ask the owner, then set it when they answer');
    }
    // The owner's answer to a guest-sourced question is guest-sourced too:
    // a routine runs later as clean work, so none is saved from it.
    if ((deps.guestWake ?? guestOfRunningWake)(bot.botId) !== false) return refuse('not_authorized', GUEST_TURN_STARTS_NO_WORKERS);
    const p = obj(raw) as Partial<RoutineSetParams>;
    // A routine runs later as clean work: none is saved from a conversation
    // that took in outside text, whatever the owner answered in it, but the
    // owner's own message there may have it proposed on their card.
    if ((deps.conversationTainted ?? conversationTainted)(bot.botId) !== false) return proposeRoutine(bot, store, p, deps);
    const key = p.clientRoutineId ?? deps.defaultKey?.(bot.botId);
    return store.set({ botId: bot.botId, workspaceId: bot.workspaceId }, { ...(p as RoutineSetParams), ...(key ? { clientRoutineId: key } : {}) });
  });

  router.register(ROUTINE_RPC.list, async (raw, ctx?: RpcContext) => {
    const store = deps.store();
    if (ctx?.bot) {
      if (!store) return NOT_STARTED;
      return { ok: true, routines: store.list(ctx.bot.botId) };
    }
    if (ctx?.operator !== true) return refuse('not_authorized', 'this call needs a bot identity or the operator');
    if (!store) return NOT_STARTED;
    const botId = obj(raw).botId;
    if (botId !== undefined && typeof botId !== 'string') return refuse('invalid_argument', 'botId must be a bot id');
    return { ok: true, routines: store.list(botId) };
  });

  router.register(ROUTINE_RPC.ownerSet, async (raw, ctx?: RpcContext) => {
    const p = obj(raw);
    const who = ownerRoutineBot(p, ctx, deps);
    if (!who.ok) return who;
    const store = deps.store();
    if (!store) return NOT_STARTED;
    return store.ownerSet({ botId: who.bot.id, workspaceId: who.bot.workspaceId }, p as unknown as RoutineOwnerSetParams);
  });

  router.register(ROUTINE_RPC.ownerPause, async (raw, ctx?: RpcContext) => {
    const p = obj(raw);
    const who = ownerRoutineBot(p, ctx, deps, true);
    if (!who.ok) return who;
    const store = deps.store();
    if (!store) return NOT_STARTED;
    // The owner's pause reaches only the named bot's routine; off My Hermes,
    // only one the owner wrote or one wmux paused as refused (no one else can
    // bring that back).
    const r = typeof p.routineId === 'string' ? store.get(p.routineId) : null;
    if (typeof p.routineId === 'string' && (r?.botId !== who.bot.id || (!isOwnHermesEngine(who.bot.engine) && !ownerReaches(r)))) {
      return { ok: false, code: 'not_found', message: `no routine ${p.routineId} for this bot` };
    }
    return store.pause({ kind: 'owner' }, p.routineId, p.paused);
  });

  router.register(ROUTINE_RPC.ownerRemove, async (raw, ctx?: RpcContext) => {
    const p = obj(raw);
    const who = ownerRoutineBot(p, ctx, deps, true);
    if (!who.ok) return who;
    const store = deps.store();
    if (!store) return NOT_STARTED;
    if (!isOwnHermesEngine(who.bot.engine) && (typeof p.routineId !== 'string' || !ownerReaches(store.get(p.routineId)))) {
      return { ok: false, code: 'not_found', message: `no routine ${String(p.routineId)} of yours for this bot` };
    }
    return store.remove(who.bot.id, p.routineId);
  });

  router.register(ROUTINE_RPC.ownerRun, async (raw, ctx?: RpcContext) => {
    const p = obj(raw);
    const who = ownerRoutineBot(p, ctx, deps);
    if (!who.ok) return who;
    const store = deps.store();
    if (!store) return NOT_STARTED;
    return store.runNow(who.bot.id, p.routineId);
  });

  router.register(ROUTINE_RPC.pause, async (raw, ctx?: RpcContext) => {
    if (!ctx?.bot) return refuse('not_authorized', 'a bot pauses its own routines');
    const store = deps.store();
    if (!store) return NOT_STARTED;
    const p = obj(raw);
    // Pausing is always allowed; a resumed routine wakes the bot later as clean work.
    if (p.paused !== true && (deps.guestWake ?? guestOfRunningWake)(ctx.bot.botId) !== false) return refuse('not_authorized', GUEST_TURN_STARTS_NO_WORKERS);
    return store.pause({ kind: 'bot', botId: ctx.bot.botId, workspaceId: ctx.bot.workspaceId }, p.routineId, p.paused);
  });

  router.register(BOT_RPC.stopMyWork, async (_raw, ctx?: RpcContext) => {
    if (!ctx?.bot) return refuse('not_authorized', 'a bot stops only its own work');
    const botId = ctx.bot.botId;
    if (deps.stop) return deps.stop(botId);
    // No task ledger yet: nothing runs but the routines.
    const store = deps.store();
    if (!store) return NOT_STARTED;
    return { ok: true, workersStopped: 0, gatesCancelled: 0, routinesPaused: store.pauseFor(botId, 'stop') };
  });
}

/** Off My Hermes, the owner's pause and remove reach a routine they wrote,
 *  and one wmux paused as refused, which the bot itself cannot resume. */
function ownerReaches(r: { author?: string; state?: string; paused?: { reason?: string } } | null | undefined): boolean {
  return r?.author === 'owner' || (r?.state === 'paused' && r.paused?.reason === 'refused');
}

/** routine.set from a conversation that took in outside text: a new
 *  routine the owner's own card asked for goes to their approval card;
 *  anything else is refused as before. Fails closed. */
function proposeRoutine(bot: BotBinding, store: RoutineStore, p: Partial<RoutineSetParams>, deps: RoutineHandlerDeps): unknown {
  const refused = refuse('not_authorized', TAINTED_CONVERSATION_SAVES_NOTHING);
  try {
    // Before any card: a turn started from outside text, and a conversation
    // holding what a signed-in task read (a prompt could carry it out), or
    // none at all, save nothing.
    if ((deps.wakeTainted ?? runningWakeTainted)(bot.botId) !== false) return refused;
    if ((deps.conversationSignedIn ?? conversationSignedIn)(bot.botId) !== false) return refused;
    const proof = (deps.ownerCard ?? runningOwnerCardProof)(bot.botId);
    if (!proof) return refused;
    // Rewriting a routine the owner already trusts is not proposed.
    if (p.routineId !== undefined) return refuse('not_authorized', ROUTINE_CHANGE_REFUSED);
    // Left out, it runs where the owner asked, written into the routine so
    // the card and what is saved name the same thread.
    const thread = p.threadId === undefined ? proof.threadId : parseThreadId(p.threadId);
    if (thread !== null && thread !== dmThreadId(bot.botId) && thread !== proof.threadId) return refuse('not_authorized', ROUTINE_THREAD_REFUSED);
    const checked = store.check(bot, { ...p, threadId: thread ?? p.threadId } as RoutineSetParams);
    if (!checked.ok) return checked;
    const service = (deps.approvals ?? getApprovalService)();
    if (!service) return refuse('not_started', 'approvals are not running yet, so this routine cannot be put to the owner; ask again later');
    const asked = service.proposeOwnerAsked(bot, { action: 'routine', routine: checked.fields }, proof);
    if (!asked.ok) return { ok: false, code: asked.code === 'invalid' ? 'invalid_argument' : asked.code === 'too_many' || asked.code === 'not_started' ? asked.code : 'not_authorized', message: asked.message };
    return { ok: true, pending: true, approvalId: asked.request.requestId, message: ROUTINE_PENDING };
  } catch {
    return refused;
  }
}

/** What a `routine` request's Approve does: the routine on the card, saved
 *  through routine.set's checks as of now, keyed by the request so it is
 *  saved once. */
export function routineApprovalHost(store: () => RoutineStore | null): ApprovalRoutineHost {
  return {
    approve(r) {
      const s = store();
      if (!s) return 'routines are not running';
      if (!r.routine) return 'the request names no routine';
      const res = s.set({ botId: r.botId, workspaceId: r.workspaceId }, { ...r.routine, clientRoutineId: `approval:${r.requestId}` });
      return res.ok ? null : res.message;
    },
  };
}

/** The approval store's `routine` host, once the module started. */
export function getRoutineApprovalHost(): ApprovalRoutineHost | null {
  return getRoutineStore() ? routineApprovalHost(getRoutineStore) : null;
}

/** The interval floor: ROUTINE_LIMITS.MIN_INTERVAL_MS, or, on an isolated
 *  instance (WMUX_DATA_SUFFIX set) started with WMUX_TEST_ROUTINE_MIN_MS, that
 *  shorter floor, so a live check can watch a routine fire. */
export function routineMinIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const test = env.WMUX_DATA_SUFFIX ? Number(env.WMUX_TEST_ROUTINE_MIN_MS) : NaN;
  return Number.isSafeInteger(test) && test >= 1_000 && test < ROUTINE_LIMITS.MIN_INTERVAL_MS ? test : ROUTINE_LIMITS.MIN_INTERVAL_MS;
}

/** What the bot runtime's lifecycle means for a bot's routines. */
export function onBotLifecycle(
  store: RoutineStore | null,
  botId: string,
  event: BotLifecycleEvent,
  factoryEnabled: () => boolean = () => getFactorySettings().enabled,
): void {
  if (!store) return;
  switch (event) {
    case 'parked': store.pauseFor(botId, 'park'); break;
    case 'resumed': store.resumeFor(botId, 'park'); break;
    case 'disabled': store.pauseFor(botId, 'off'); break;
    // A bot switched back on resumes what its own off switch paused, unless
    // "Run bots" is off too (that one resumes them when it is switched on).
    case 'enabled': if (factoryEnabled()) store.resumeFor(botId, 'off'); break;
    case 'removed': store.removeBot(botId); break;
  }
}

export function createRoutineModule(deps: Pick<FactoryHostDeps, 'wmuxDir' | 'getMainWindow'>): { start(): void; dispose(): void } {
  let off: (() => void) | null = null;
  return {
    start() {
      if (getRoutineStore()) return;
      const store = new RoutineStore({
        file: routinesPath(deps.wmuxDir()),
        minIntervalMs: routineMinIntervalMs(),
        bots: getBotDirectory,
        wakes: getWakeQueue,
        factLog: getFactLog,
        rooms: getRoomWriter,
        replyTo: (botId, workspaceId, threadId) => {
          const writer = getRoomWriter();
          return writer ? wakeReplyTo(writer, runningWake(resolveRoomPorts(), botId), workspaceId, threadId) : undefined;
        },
        factoryEnabled: () => getFactorySettings().enabled,
        emit: (payload: BotEventPayload) => {
          const win = deps.getMainWindow();
          if (win && !win.isDestroyed()) win.webContents.send(BOT_EVENT, payload);
        },
      });
      try {
        store.load();
      } catch (err) {
        console.warn(`[factory] routines: ${path.basename(routinesPath(deps.wmuxDir()))} not loaded; routines stay off: ${String(err)}`);
        return;
      }
      setRoutineStore(store);
      setBotRuntimePorts({
        resolveRoutine: (routineId) => {
          const r = getRoutineStore()?.get(routineId);
          return r
            ? {
                routineId: r.id,
                title: r.title,
                prompt: r.prompt,
                schedule: scheduleLabel(r.schedule),
                botId: r.botId,
                workspaceId: r.workspaceId,
                ...(r.author ? { author: r.author } : {}),
                ...(r.threadId ? { threadId: r.threadId } : {}),
              }
            : null;
        },
        onBotLifecycle: (botId, event) => onBotLifecycle(getRoutineStore(), botId, event),
        pauseRefusedRoutine: (botId, routineId) => getRoutineStore()?.pauseRefused(botId, routineId) ?? false,
      });
      const syncSwitch = () => {
        if (getFactorySettings().enabled) store.resumeFor(undefined, 'off');
        else store.pauseFor(undefined, 'off');
      };
      syncSwitch();
      off = onFactorySettingsChanged(syncSwitch);
      store.start();
    },
    dispose() {
      off?.();
      off = null;
      getRoutineStore()?.dispose();
      setRoutineStore(null);
    },
  };
}

registerFactoryRpcModule('routines', (router, deps) => {
  registerRoutineHandlers(router, {
    store: getRoutineStore,
    defaultKey: (botId) => wakeOrdinals.next(runningWake(resolveRoomPorts() ?? {}, botId), 'routine'),
    stop: async (botId) => {
      const ports = getFactoryStopPorts();
      if (!ports) {
        const store = getRoutineStore();
        return { ok: true, workersStopped: 0, gatesCancelled: 0, routinesPaused: store ? store.pauseFor(botId, 'stop') : 0 };
      }
      const r = await stopFactoryWork(ports, { botId, keepTurn: true });
      return { ok: r.ok, workersStopped: r.workersStopped, gatesCancelled: r.gatesCancelled, ...(r.routinesPaused !== undefined ? { routinesPaused: r.routinesPaused } : {}), ...(r.code ? { code: r.code, message: r.message } : {}) };
    },
  });
  return createRoutineModule(deps);
});
