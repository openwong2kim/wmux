// bot.* — the bot runtime (shared/bot.ts BOT_RPC), registered as the
// `bot-runtime` factory module (main/factory/factoryHost.ts).
//
// Who may call what (§13 rules 1-2). Every method refuses a caller that is
// neither the operator (the renderer bridge) nor a bot:
//   - bot.list: the operator, or any bot (the directory a bot reads to know
//     whom to mention or hand work to, in every workspace);
//   - bot.status: the operator, or a bot reading its own status;
//   - bot.setJob: the operator for any bot; a bot for its own job only, and
//     only while it runs a wake on the owner's words (their message, or
//     their answer to its question, untainted). Main
//     posts a `job_changed` card (with the previous job, for Undo);
//   - bot.create / update / remove / wake / park / resume / interrupt: the
//     operator. No bot parks another.
// A refusal is a typed result `{ok:false, code, message}`, never a throw.
// A bot's picture never crosses the pipe: bot.create / bot.update refuse an
// `avatar`, and every profile these methods answer has it left out (it is
// the owner's, set from Settings, and is never part of a bot's context).
// Before the module started (or after a store failed to load) every method
// answers `not_started`.
//
// start() loads the factory settings, bots.json, the wake queue (R8: a turn
// that was running at quit is marked interrupted, never replayed) and
// sessions.json, builds the runtime, wires bot-origin fan-out tasks to the
// wake queue, and publishes the singletons the other factory modules use
// (getBotDirectory, getWakeQueue, getBotRuntime, getFactorySettings).

import type { RpcContext, RpcMethod } from '../../../shared/rpc';
import { BOT_EVENT, BOT_ID_RE, BOT_IDENTITY_SLOTS, BOT_JOB_MAX, BOT_RPC, type BotProfile, type BotStatus } from '../../../shared/bot';
import type { FactoryRefusal } from '../../../shared/botSurface';
import { parseThreadId, type ThreadId } from '../../../shared/room';
import { registerFactoryRpcModule, type FactoryHostDeps, type FactoryRouter } from '../../factory/factoryHost';
import { BotStore, botsFilePath, setBotStore } from '../../factory/botStore';
import { WakeQueue, wakeQueuePath, setWakeQueue } from '../../factory/wakeQueue';
import { FactorySettingsStore, factorySettingsPath, onFactorySettingsChanged, setFactorySettingsStore } from '../../factory/factorySettings';
import { BotRuntime, BotSessionStore, botSessionsPath, setBotRuntime } from '../../factory/BotRuntime';
import { createDefaultBotEngineFactory, runnableDefaultEngine, type BotEngineFactory } from '../../factory/botEngines';
import { recordWorkerEnd } from '../../factory/budget';
import { botAccountQuota, type ClaudeUsageCache } from '../../factory/botQuota';
import { openBotWorkers } from '../../factory/openBotWorkers';
import { getAgentSlots } from '../../factory/agentSlots';
import { BotFanoutReceipts, botFanoutReceiptsPath, setBotFanoutReceipts } from '../../factory/botFanoutReceipts';
import { installBotFanoutWake } from '../../deck/fanoutCallerNotify';
import { isVerifyReport } from '../../factory/verifyPreset';
import { getTaskLedger } from '../../deck/taskLedgerHost';
import type { WakeTaskSummary } from '../../factory/wakePrompt';
import { botRepoFromFolder, greetNewBot } from '../../factory/botCreate';
import { DISMISSED_ANSWER, getHandoffRouter } from '../../factory/handoffRouter';
import { getWakeTaint, type WakeTaint } from '../../factory/wakeTaint';
import type { Handoff } from '../../../shared/handoff';
import type { WakeItem } from '../../../shared/wake';
import { getRoomWriter, resolveRoomPorts, runningWake, runningWakeThread, wakeReplyTo } from '../../factory/roomWriter';
import { getFactoryStopPorts, stopFactoryWork, type FactoryStopPorts, type FactoryStopResult } from '../../factory/factoryStop';

type Refusal = FactoryRefusal<'not_authorized' | 'not_started' | 'invalid_argument' | 'not_found' | 'not_running' | 'too_many_bots' | 'dropped' | 'not_owner_words' | 'not_a_repo' | 'repo_untrusted' | 'no_remote' | 'repo_mismatch' | 'stop_failed'>;

function refuse(code: Refusal['code'], message: string): Refusal {
  return { ok: false, code, message };
}

const HUMAN_TEXT_MAX = 16 * 1024;
const USAGE_CHANGED_DEBOUNCE_MS = 5_000;

type Caller = { kind: 'operator' } | { kind: 'bot'; botId: string; role: string } | null;

function callerOf(ctx: RpcContext | undefined): Caller {
  if (ctx?.bot) return { kind: 'bot', botId: ctx.bot.botId, role: ctx.bot.role };
  if (ctx?.operator === true) return { kind: 'operator' };
  return null;
}

function botIdParam(params: Record<string, unknown>): string | null {
  const v = params['botId'];
  return typeof v === 'string' && BOT_ID_RE.test(v) ? v : null;
}

/** A status as a caller reads it: a bot does not read the owner's account
 *  and its usage limits. */
function statusFor(caller: Caller, status: BotStatus | null): BotStatus | null {
  if (!status || caller?.kind !== 'bot' || !status.quota) return status;
  const out = { ...status };
  delete out.quota;
  return out;
}

/** A profile as the pipe answers it: without the picture. */
export function pipeProfile(bot: BotProfile): BotProfile {
  const out = { ...bot };
  delete out.avatar;
  return out;
}

/** The runtime pieces a handler needs, or null before start. */
interface Live {
  store: BotStore;
  runtime: BotRuntime;
  /** The wake queue (bot.setJob reads the running wake's reason; bot.create
   *  queues a greeting). Absent in tests that do not need it. */
  queue?: WakeQueue;
}

/** The ports bot.setJob reads: the running wake of a bot and the room to
 *  post the `job_changed` card in. Overridable for tests. */
export interface SetJobPorts {
  /** The id of the wake the bot is running now, or null. */
  runningWakeId: (botId: string) => string | null;
  /** That wake's thread, or null (the card then lands in `general`). */
  runningThread: (botId: string) => string | null;
  /** The owner card that started that wake (RunningWake.ownerCardId), or
   *  null. Missing: none. */
  ownerCardId?: (botId: string) => string | null;
  /** `replyTo`: the owner card the card answers, kept only when it is a
   *  `human` card of the card's room and thread (wakeReplyTo). */
  post: (card: { workspaceId: string; threadId?: string; actor: { kind: 'bot'; workspaceId: string; botId: string } | { kind: 'human' }; title: string; body?: string; refs: { botId: string; botIds: string[] }; jobChange: { botId: string; previous: string | null; next: string | null }; replyTo?: string }) => void;
  /** The bot has a job now (set by itself or the owner): its greeting
   *  question closes (handoffRouter.ts closeIntroQuestions). */
  jobGiven?: (botId: string) => void;
  /** The running wake carries the owner's own answer to this bot's
   *  question (wakeOnOwnerAnswer). Missing: no wake does. */
  ownerAnswer?: (botId: string, wake: Pick<WakeItem, 'reason'>) => boolean;
}

/** The wake carries the owner's own answer to the bot's question: an
 *  `answer` handoff from the owner to this bot, replying to a question this
 *  bot asked that is still on record (a pruned question no longer says
 *  which hop it resumed), not a question closed without an answer, and not
 *  one resuming a hop that read outside text (wakeTaint.ts). No taint
 *  tracker reads as tainted. Pure over its deps. */
export function wakeOnOwnerAnswer(
  botId: string,
  wake: Pick<WakeItem, 'reason'>,
  deps: { handoff: (id: string) => Handoff | null; taint: Pick<WakeTaint, 'wakeTainted'> | null },
): boolean {
  try {
    if (wake.reason.kind !== 'handoff') return false;
    const h = deps.handoff(wake.reason.handoffId);
    if (!h || h.kind !== 'answer' || h.from.kind !== 'human' || h.payload.body === DISMISSED_ANSWER) return false;
    if (h.to.kind !== 'bot' || h.to.botId !== botId) return false;
    const ask = h.replyTo ? deps.handoff(h.replyTo) : null;
    if (!ask || ask.kind !== 'ask_person' || ask.from.kind !== 'bot' || ask.from.botId !== botId) return false;
    return !!deps.taint && !deps.taint.wakeTainted(wake);
  } catch {
    return false;
  }
}

const defaultSetJobPorts: SetJobPorts = {
  runningWakeId: (botId) => runningWake(resolveRoomPorts(), botId)?.wakeId ?? null,
  runningThread: (botId) => runningWakeThread(resolveRoomPorts(), botId),
  ownerCardId: (botId) => runningWake(resolveRoomPorts(), botId)?.ownerCardId ?? null,
  post: ({ replyTo: candidate, ...card }) => {
    const writer = getRoomWriter();
    if (!writer) return;
    const threadId = (card.threadId ?? 'general') as ThreadId;
    const replyTo = wakeReplyTo(writer, candidate ? { ownerCardId: candidate } : null, card.workspaceId, threadId);
    writer.append({ ...card, kind: 'job_changed', threadId }, replyTo ? { replyTo } : undefined);
  },
  jobGiven: (botId) => {
    void getHandoffRouter()?.closeIntroQuestions(botId).catch(() => undefined);
  },
  ownerAnswer: (botId, wake) => wakeOnOwnerAnswer(botId, wake, { handoff: (id) => getHandoffRouter()?.get(id) ?? null, taint: getWakeTaint() }),
};

/** What bot.remove stops the bot's work through. Overridable for tests. */
export interface RemovePorts {
  stopPorts: () => FactoryStopPorts | null;
  /** The bot is gone: its waiting approval requests end and its skills go
   *  (approvals.ts botRemoved, botSkills.ts removeBot). Best effort. */
  afterRemove?: (botId: string) => Promise<void>;
}

/** What else a removed bot leaves behind: its approval requests still
 *  waiting expire (their cards close), and its skills are dropped. */
export async function forgetRemovedBot(botId: string): Promise<void> {
  const [{ getApprovalService }, { getBotSkillStore }] = await Promise.all([
    import('../../factory/approvals'),
    import('../../factory/botSkills'),
  ]);
  try {
    getApprovalService()?.botRemoved(botId);
  } catch (err) {
    console.warn(`[factory] bot.remove: ${botId}'s approval requests not closed: ${String(err)}`);
  }
  try {
    getBotSkillStore()?.removeBot(botId);
  } catch (err) {
    console.warn(`[factory] bot.remove: ${botId}'s skills not removed: ${String(err)}`);
  }
}

/** The bot.* handlers over a live-runtime getter. Exported for tests. */
export function registerBotRpcHandlers(
  router: FactoryRouter,
  live: () => Live | null,
  setJobPorts: SetJobPorts = defaultSetJobPorts,
  removePorts: RemovePorts = { stopPorts: getFactoryStopPorts, afterRemove: forgetRemovedBot },
): void {
  const NOT_STARTED = refuse('not_started', 'the bot runtime is not running');

  router.register(BOT_RPC.list, async (params, ctx?: RpcContext) => {
    const caller = callerOf(ctx);
    if (!caller) return refuse('not_authorized', 'bot.list is for the operator and the bots');
    const l = live();
    if (!l) return NOT_STARTED;
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;
    const bots = l.store.list(workspaceId ? { workspaceId } : {});
    return {
      ok: true,
      bots: bots.map((bot) => ({ bot: pipeProfile(bot), status: statusFor(caller, l.runtime.status(bot.id)) })),
    };
  });

  router.register(BOT_RPC.status, async (params, ctx?: RpcContext) => {
    const caller = callerOf(ctx);
    if (!caller) return refuse('not_authorized', 'bot.status is for the operator and the bot itself');
    const requested = params['botId'] === undefined && caller.kind === 'bot' ? caller.botId : botIdParam(params);
    if (!requested) return refuse('invalid_argument', 'botId must be a bot id');
    if (caller.kind === 'bot' && requested !== caller.botId) {
      return refuse('not_authorized', 'a bot may read only its own status');
    }
    const l = live();
    if (!l) return NOT_STARTED;
    const status = statusFor(caller, l.runtime.status(requested));
    return status ? { ok: true, status } : refuse('not_found', `no bot ${requested}`);
  });

  router.register(BOT_RPC.setJob, async (params, ctx?: RpcContext) => {
    const caller = callerOf(ctx);
    if (!caller) return refuse('not_authorized', 'bot.setJob is for the operator and the bot itself');
    const p = params ?? {};
    let botId: string | null;
    if (caller.kind === 'bot') {
      if (p['botId'] !== undefined && p['botId'] !== caller.botId) return refuse('not_authorized', 'a bot sets only its own job');
      botId = caller.botId;
    } else {
      botId = botIdParam(p);
      if (!botId) return refuse('invalid_argument', 'botId must be a bot id');
    }
    const job = p['job'];
    if (job !== null && typeof job !== 'string') return refuse('invalid_argument', 'job must be text or null');
    const l = live();
    if (!l) return NOT_STARTED;
    if (caller.kind === 'bot') {
      // Only the owner assigns a job: the bot writes it during a wake on the
      // owner's own words (their message, or their answer to its question —
      // the greeting asks for the job), never on a fact, another bot's
      // handoff or a schedule.
      const wakeId = setJobPorts.runningWakeId(botId);
      const wake = wakeId ? l.queue?.get(wakeId) ?? null : null;
      const ownerWords = !!wake && wake.botId === botId && wake.state === 'running'
        && (wake.reason.kind === 'human' || setJobPorts.ownerAnswer?.(botId, wake) === true);
      if (!ownerWords) {
        return refuse('not_owner_words', 'a bot sets its job only while it answers the owner\'s own message, or their answer to its question');
      }
    }
    const r = l.store.setJob(botId, job);
    if (!r.ok) return refuse(r.code, r.code === 'invalid_argument' ? `job must be 1-${BOT_JOB_MAX} characters, no control characters but newlines` : r.message);
    const next = r.bot.job ?? null;
    if (next !== null) setJobPorts.jobGiven?.(botId);
    if (next !== r.previous) {
      l.runtime.profileChanged(botId);
      const thread = caller.kind === 'bot' ? setJobPorts.runningThread(botId) : null;
      const ownerCardId = caller.kind === 'bot' ? setJobPorts.ownerCardId?.(botId) ?? null : null;
      setJobPorts.post({
        workspaceId: r.bot.workspaceId,
        ...(thread ? { threadId: thread } : {}),
        actor: caller.kind === 'bot' ? { kind: 'bot', workspaceId: r.bot.workspaceId, botId } : { kind: 'human' },
        title: `${r.bot.name}'s job ${next === null ? 'was cleared' : 'changed'}`,
        ...(next !== null ? { body: next } : {}),
        refs: { botId, botIds: [botId] },
        jobChange: { botId, previous: r.previous, next },
        ...(ownerCardId ? { replyTo: ownerCardId } : {}),
      });
    }
    return { ok: true, bot: pipeProfile(r.bot), previous: r.previous, ...(next === r.previous ? { unchanged: true } : {}) };
  });

  const operatorOnly = (
    method: RpcMethod,
    run: (l: Live, params: Record<string, unknown>) => unknown | Promise<unknown>,
  ): void => {
    router.register(method, async (params, ctx?: RpcContext) => {
      if (callerOf(ctx)?.kind !== 'operator') return refuse('not_authorized', `${method} is for the operator only`);
      const l = live();
      if (!l) return NOT_STARTED;
      return run(l, params ?? {});
    });
  };

  operatorOnly(BOT_RPC.park, (l, params) => {
    const botId = botIdParam(params);
    if (!botId) return refuse('invalid_argument', 'botId must be a bot id');
    return l.runtime.park(botId);
  });

  operatorOnly(BOT_RPC.create, (l, params) => {
    if (params['avatar'] !== undefined) return refuse('invalid_argument', 'a bot\'s picture is set in Settings, not through bot.create');
    if (params['greet'] !== undefined && typeof params['greet'] !== 'boolean') return refuse('invalid_argument', 'greet must be a boolean');
    const r = l.store.create({
      workspaceId: params['workspaceId'],
      template: params['template'],
      role: params['role'],
      name: params['name'],
      job: params['job'],
      engine: params['engine'],
      workerAgent: params['workerAgent'],
      triggers: params['triggers'],
      budget: params['budget'],
      repo: params['repo'],
      enabled: params['enabled'],
    });
    if (!r.ok) return refuse(r.code, r.message);
    // `greet: true`: the bot's first wake greets the owner (Add bot does this
    // always; a scripted create opts in).
    const queue = l.queue;
    if (params['greet'] === true && greetNewBot(r.bot, queue ? (input) => queue.enqueue(input) : null)) l.runtime.kick();
    return { ok: true, bot: pipeProfile(r.bot), status: l.runtime.status(r.bot.id) };
  });

  operatorOnly(BOT_RPC.update, async (l, params) => {
    const botId = botIdParam(params);
    if (!botId) return refuse('invalid_argument', 'botId must be a bot id');
    const raw = params['patch'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse('invalid_argument', 'patch must be an object');
    let patch = raw as Record<string, unknown>;
    // A picked folder becomes the repo as "Add bot" resolves it (botCreate.ts).
    if ('repoFolder' in patch) {
      const { repoFolder, ...rest } = patch;
      if ('repo' in rest) return refuse('invalid_argument', 'send repo or repoFolder, not both');
      const resolved = await botRepoFromFolder(l.store, botId, repoFolder);
      if (!resolved.ok) return refuse(resolved.code, resolved.message);
      patch = { ...rest, repo: resolved.repo };
    }
    const r = l.store.update(botId, patch);
    if (!r.ok) return refuse(r.code, r.message);
    l.runtime.profileChanged(botId);
    if ('job' in patch && r.bot.job) setJobPorts.jobGiven?.(botId);
    return { ok: true, bot: pipeProfile(r.bot), status: l.runtime.status(botId) };
  });

  // Removing a bot stops its work first, as Stop does for one bot
  // (factoryStop.ts): its turn is interrupted, its open tasks end "stopped
  // by owner", its workers and gates are stopped and its routines paused —
  // then the profile goes (its routines with it, routine.rpc.ts) and a
  // tombstone keeps its name for the cards it wrote. `hue`: its colour slot.
  // The bot is switched off before the stop takes its snapshot, so no turn
  // (and no worker) starts while the stop waits. A stop that could
  // not stop everything keeps the bot, off, and says so: deleting again
  // retries.
  operatorOnly(BOT_RPC.remove, async (l, params) => {
    const botId = botIdParam(params);
    if (!botId) return refuse('invalid_argument', 'botId must be a bot id');
    const rawHue = params['hue'];
    if (rawHue !== undefined && !(Number.isInteger(rawHue) && (rawHue as number) >= 0 && (rawHue as number) < BOT_IDENTITY_SLOTS)) {
      return refuse('invalid_argument', `hue must be an integer 0-${BOT_IDENTITY_SLOTS - 1}`);
    }
    if (!l.store.get(botId)) return refuse('not_found', `no bot ${botId}`);
    // Off first (its queue goes, no new turn starts; a running turn is
    // still there for the stop to mark and interrupt), then the stop.
    if (l.store.get(botId)?.enabled) {
      l.store.update(botId, { enabled: false });
      l.runtime.profileChanged(botId);
    }
    const ports = removePorts.stopPorts();
    let stopping: Promise<FactoryStopResult> | null = null;
    if (ports) stopping = stopFactoryWork(ports, { botId });
    else console.warn(`[factory] bot.remove: the factory stop is not running; ${botId}'s workers were not stopped`);
    let stopped: FactoryStopResult | null = null;
    if (stopping) {
      try {
        stopped = await stopping;
      } catch (err) {
        return refuse('stop_failed', `Some of the bot's work could not be stopped (${String(err)}); it is off now. Delete it again to retry.`);
      }
      if (!stopped.ok) return refuse('stop_failed', 'Some of the bot\'s work could not be stopped; it is off now. Delete it again to retry.');
    }
    if (!l.runtime.remove(botId, rawHue !== undefined ? { hue: rawHue as number } : {})) return refuse('not_found', `no bot ${botId}`);
    await removePorts.afterRemove?.(botId).catch((err) => console.warn(`[factory] bot.remove: ${botId} not fully forgotten: ${String(err)}`));
    return {
      ok: true,
      botId,
      ...(stopped ? { stopped: { ok: stopped.ok, workersStopped: stopped.workersStopped, tasksCancelled: stopped.tasksCancelled } } : {}),
    };
  });

  operatorOnly(BOT_RPC.wake, (l, params) => {
    const botId = botIdParam(params);
    if (!botId) return refuse('invalid_argument', 'botId must be a bot id');
    if (!l.store.get(botId)) return refuse('not_found', `no bot ${botId}`);
    const text = params['text'];
    if (text !== undefined && (typeof text !== 'string' || text.trim().length === 0 || text.length > HUMAN_TEXT_MAX)) {
      return refuse('invalid_argument', `text must be 1-${HUMAN_TEXT_MAX} characters`);
    }
    const source = params['source'] === 'phone' ? 'phone' : 'desktop';
    const clientMessageId = typeof params['clientMessageId'] === 'string' ? params['clientMessageId'] : undefined;
    const threadId = params['threadId'] === undefined ? undefined : parseThreadId(params['threadId']);
    if (threadId === null) return refuse('invalid_argument', 'threadId must be a room thread id');
    const item = l.runtime.wake(botId, {
      ...(typeof text === 'string' ? { text } : {}),
      source,
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(threadId ? { threadId } : {}),
    });
    if (!item) return refuse('dropped', 'the wake was not queued (bot disabled, or its queue is full)');
    l.runtime.kick();
    return { ok: true, wake: item };
  });

  operatorOnly(BOT_RPC.resume, (l, params) => {
    const botId = botIdParam(params);
    if (!botId) return refuse('invalid_argument', 'botId must be a bot id');
    return l.runtime.resume(botId);
  });

  operatorOnly(BOT_RPC.interrupt, (l, params) => {
    const botId = botIdParam(params);
    if (!botId) return refuse('invalid_argument', 'botId must be a bot id');
    return l.runtime.interrupt(botId);
  });
}

/** A task's ledger row as a wake reports it. */
function taskSummaries(taskIds: readonly string[]): WakeTaskSummary[] {
  const ledger = getTaskLedger();
  const out: WakeTaskSummary[] = [];
  for (const id of taskIds) {
    const e = ledger.get(id);
    if (!e) continue;
    out.push({
      taskId: e.id,
      title: e.title,
      status: e.status,
      ...(e.summary ? { summary: e.summary } : {}),
      ...(e.gate
        ? {
            gate: {
              exitCode: e.gate.exitCode,
              ...(e.gate.headSha ? { headSha: e.gate.headSha } : {}),
              ...(e.gate.skipped ? { skipped: e.gate.skipped } : {}),
            },
          }
        : {}),
    });
  }
  return out;
}

export interface BotRuntimeModuleOptions {
  engines?: BotEngineFactory;
}

/** The module body (exported for tests). */
export function botRuntimeModule(router: FactoryRouter, deps: FactoryHostDeps, opts: BotRuntimeModuleOptions = {}) {
  let live: Live | null = null;
  let offWake: (() => void) | null = null;
  let offStore: (() => void) | null = null;
  let offSettings: (() => void) | null = null;
  let offUsage: (() => void) | null = null;
  let usageTimer: ReturnType<typeof setTimeout> | null = null;
  registerBotRpcHandlers(router, () => live);

  const send = (payload: unknown): void => {
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(BOT_EVENT, payload);
  };

  return {
    start: () => {
      const wmuxDir = deps.wmuxDir();
      const settings = new FactorySettingsStore(factorySettingsPath(wmuxDir));
      settings.load();
      const store = new BotStore(botsFilePath(wmuxDir), { defaultEngine: () => runnableDefaultEngine(settings.get().defaultEngine) });
      store.load();
      const sessions = new BotSessionStore(botSessionsPath(wmuxDir));
      sessions.load();
      const receipts = new BotFanoutReceipts(botFanoutReceiptsPath(wmuxDir));
      receipts.load();
      let runtime: BotRuntime | null = null;
      let usage: ClaudeUsageCache | null = null;
      try {
        usage = deps.claudeUsage?.() ?? null;
      } catch (err) {
        console.warn(`[factory] bot quota readings are not wired: ${String(err)}`);
      }
      const queue = new WakeQueue(wakeQueuePath(wmuxDir), {
        isBotEnabled: (botId) => store.get(botId)?.enabled === true,
        onChange: () => runtime?.kick(),
      });
      queue.load();
      // Issue wakes queued for a triage bot under its old default triggers
      // never run: those triggers did not check the author.
      for (const botId of store.migratedTriageBots()) queue.dropUnfilteredIssueWakes(botId);
      // PR-event wakes queued under triggers a bot no longer has never run
      // (a reviewer moved to on-request verification). Checked on every
      // start, so a start that failed after the move still gets it done.
      for (const bot of store.list()) queue.dropPrEventWakes(bot.id, new Set(bot.triggers.map((t) => t.kind)));
      runtime = new BotRuntime({
        store,
        queue,
        sessions,
        settings: () => settings.get(),
        engines: opts.engines ?? createDefaultBotEngineFactory(),
        wmuxDir,
        resolveTasks: taskSummaries,
        onStatus: (status: BotStatus) => send({ type: 'bot.status', status }),
        workerLoad: (botId) => {
          const open = openBotWorkers(botId);
          const slots = getAgentSlots();
          return {
            running: open.bot,
            factoryRunning: open.factory,
            waiting: slots ? slots.waiting().filter((w) => w.botId === botId).length : 0,
            slots: slots ? { inUse: slots.inUse(), cap: slots.limit() } : null,
          };
        },
        ...(usage ? { claudeQuota: (workspaceId: string, accountId: string | null | undefined) => botAccountQuota(usage, workspaceId, accountId) } : {}),
      });
      setFactorySettingsStore(settings);
      setBotStore(store);
      setWakeQueue(queue);
      setBotRuntime(runtime);
      setBotFanoutReceipts(receipts);
      offStore = store.onChange(() => send({ type: 'bots-changed' }));
      // Every settings write reschedules: switching the factory off, from any
      // caller, cancels the running turns at once.
      offSettings = onFactorySettingsChanged(() => {
        runtime?.kick();
      });
      // A new usage reading moves the bots' quota lines: tell the window, at
      // most once per few seconds (live statusline samples come in bursts).
      offUsage = usage?.onChange(() => {
        if (usageTimer) return;
        usageTimer = setTimeout(() => {
          usageTimer = null;
          send({ type: 'bots-changed' });
        }, USAGE_CHANGED_DEBOUNCE_MS);
      }) ?? null;
      try {
        offWake = installBotFanoutWake({
          enqueue: (input) => queue.enqueue(input),
          // A usage change alone sends no event: tell the window, so the
          // profile's running workers and worker time move on.
          onWorkerEnded: (botId, taskId) => {
            store.mutateUsage(botId, (u) => {
              recordWorkerEnd(u, taskId, Date.now());
            });
            send({ type: 'bots-changed' });
          },
          // A verify task's report wakes its verifier once, from the verify
          // gate (verifyPreset.ts) after the gate at the head is recorded.
          wokenElsewhere: (t) => isVerifyReport(t.entry, t.to),
        });
      } catch (err) {
        console.warn(`[factory] bot fan-out wakes are not wired: ${String(err)}`);
      }
      live = { store, runtime, queue };
      // A window that listed the bots before start read an empty list, and a
      // store whose bots are all off sends no status: tell it to read again.
      send({ type: 'bots-changed' });
      runtime.kick();
    },
    // Quit: the bots stop first, whatever the other modules still wait on.
    stop: () => {
      live?.runtime.dispose();
    },
    dispose: async () => {
      offWake?.();
      offStore?.();
      offSettings?.();
      offUsage?.();
      if (usageTimer) clearTimeout(usageTimer);
      usageTimer = null;
      const l = live;
      live = null;
      l?.runtime.dispose();
      setBotRuntime(null);
      setBotFanoutReceipts(null);
      setWakeQueue(null);
      setBotStore(null);
      setFactorySettingsStore(null);
      await l?.store.flush().catch(() => undefined);
    },
  };
}

registerFactoryRpcModule('bot-runtime', (router, deps) => botRuntimeModule(router, deps));
