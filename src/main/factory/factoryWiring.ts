// ─── Factory wiring — the real instances behind every module's ports ───────
//
// Each factory module takes its collaborators as ports, so it builds and
// tests alone. This module points those ports at the running instances, in
// its register function (before any module starts; every resolver reads the
// singletons lazily, so a module that starts later still sees them):
//
//   trigger engine  ← fact log (through the trigger cursor below), wake queue,
//                     bot directory, trust (settings' trusted authors and the
//                     gh login of the owner), factory on/off, gh reads;
//   rooms/handoffs  ← fact log, wake queue, bot directory, the bot runtime's
//                     hooks, the running wake (its thread, id and attempt);
//   bot runtime     ← fact and handoff lookups for wake prompts, the room
//                     thread tail;
//   fact log        ← the bot runtime's hooks (budget refusals, parked bots);
//   phone           ← `moa.wake` with mode 'factory' → the HQ bot;
//   morning report  ← the morning schedule (morningSchedule.ts), on start;
//   worker counts   ← verify tasks whose bot verdict is recorded
//                     (verdictedTasks.ts), on start; the verdict also
//                     closes its verify task in the ledger.
//   task gate       ← the system gate on every other bot task's report
//                     (taskGate.ts), on start;
//   task views      ← each bot's tasks with their stage for the Bots page
//                     (botTasks.ts), and a BOT_EVENT push when a bot task
//                     or a pull request moves;
//   stop            ← the owner's stop of running bot work (factoryStop.ts);
//   worker life     ← the report nudge, the reclaim and resume of an ended
//                     task's worker, the agent budget (workerLifecycleHost.ts).
//
// Bot-owned fan-out tasks wake their bot through installBotFanoutWake (one
// wake per ledger transition, pinned to the task's thread, independent of
// the bot's triggers). Their task.* facts still land in the log and the
// rooms, but the trigger engine is not handed them, so no transition wakes
// a bot twice.
//
// The trigger cursor: the last fact seq the trigger engine was handed,
// persisted in `factory/trigger-cursor.json`. On start the facts appended
// after it — while the app was down, or before a crash — are routed first,
// then live ones. The wake queue drops a fact id a bot already holds, so a
// fact routed twice around a crash wakes nobody twice. A first start (no
// cursor) begins at the newest fact: history wakes nobody.

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import type { BotProfile } from '../../shared/bot';
import type { Fact, FactDraft } from '../../shared/facts';
import type { MoaWakePayload, MoaWakeResult } from '../../shared/moaWake';
import type { RoomCard, ThreadId } from '../../shared/room';
import type { WakeItem } from '../../shared/wake';
import type { FactorySettings } from '../../shared/factorySettings';
import { ROOM_LIMITS, dmThreadId } from '../../shared/room';
import { registerFactoryRpcModule, type FactoryHostDeps, type FactoryModuleHandle } from './factoryHost';
import { getFactLog, type FactLog } from './factLog';
import { currentWakeItem, currentWakeThread, getWakeQueue } from './wakeQueue';
import { getBotDirectory, getBotStore } from './botStore';
import { getFactorySettings } from './factorySettings';
import { onBotHook, type BotHookEvent } from './botHooks';
import { normalizeRepoKey } from './repoWatch';
import { setFactoryTriggerPorts, type BotDirectoryApi, type FactLogApi, type FactoryTrustApi } from './triggerEngine';
import { capBody, getRoomWriter, oneLine, setFactoryRoomPorts, type FactoryRoomPorts, type RoomBotHookEvent, type RoomWriter, type RunningWake } from './roomWriter';
import { getBotRuntime, setBotRuntimePorts } from './BotRuntime';
import { getHandoffRouter, summarizeHandoff } from './handoffRouter';
import { taskIdOfFactId } from './wakePrompt';
import { getApprovalService } from './approvals';
import { wakeContext, type WakeContextPorts } from './wakeContext';
import { readUiLocale } from '../quit/quitAndStopCopy';
import { setFactoryPhoneMessageHandler } from './phoneMessage';
import { humanCardIdOfRun, postHumanMessage } from './humanMessage';
import { phoneBot } from './phoneBot';
import { ghIssueService, splitRepoKey } from '../github/GhIssueService';
import { MORNING_SCHEDULE_FILENAME, MORNING_SCHEDULE_ID, MorningSchedule, localDay } from './morningSchedule';
import { fireMorningReport } from './morningReport';
import { VERDICTED_TASKS_FILENAME, VerdictedTasks, installVerifyTaskClose, setVerdictedTasks } from './verdictedTasks';
import { getTaskLedger } from '../deck/taskLedgerHost';
import { onPrVerdictRecorded } from '../github/prVerdictStore';
import { BOT_EVENT } from '../../shared/bot';
import type { LedgerEntry } from '../../shared/ledger';
import { git } from '../git/git';
import { getSharedTaskGateRunner } from '../worktask/TaskGateRunner';
import { isPidAlive, sessionsStartedIn, stopSessionsInDir } from '../worktask/stopSessionsInDir';
import { getWorkspaceMirror } from '../workspace/WorkspaceMirror';
import { originDefaultRef, taskFolderFromMissions, worktreeFromMissions } from './verifyPreset';
import { completeCheckedTask, completeResearchTask, gateCardNoted, installTaskGate } from './taskGate';
import { TaskBranchCache, setBotTaskSources } from './botTasks';
import { installLateStopSweep, setFactoryStopPorts, type FactoryStopPorts } from './factoryStop';
import { getRoutineStore } from './routines';
import { getGroupStore } from './groupStore';
import { getAgentSlots } from './agentSlots';
import { getWorkerResumePorts, reclaimedWorkerState, stopResumedWorkers, workerWorkspaceOf } from './workerReclaim';

// ── Trigger cursor ─────────────────────────────────────────────────────────

export const TRIGGER_CURSOR_FILENAME = 'trigger-cursor.json';
const CURSOR_FLUSH_MS = 1_000;

/** The last fact seq the trigger engine was handed, on disk. */
export class TriggerCursor {
  private seq: number | null = null;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string, private readonly flushMs: number = CURSOR_FLUSH_MS) {}

  /** The saved seq, or null when none was saved (or the file is unreadable). */
  load(): number | null {
    try {
      const raw = fs.existsSync(this.file) ? atomicReadJSONSync<{ version?: unknown; seq?: unknown }>(this.file) : null;
      const seq = raw?.version === 1 ? raw.seq : undefined;
      this.seq = typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
    } catch {
      this.seq = null;
    }
    return this.seq;
  }

  /** Set the cursor (even backwards: a cursor ahead of the log) and write it now. */
  reset(seq: number): void {
    this.seq = seq;
    this.dirty = true;
    this.flush();
  }

  mark(seq: number): void {
    if (this.seq !== null && seq <= this.seq) return;
    this.seq = seq;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty || this.seq === null) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      atomicWriteJSONSync(this.file, { version: 1, seq: this.seq });
    } catch (err) {
      this.dirty = true;
      console.warn(`[factory] trigger cursor not written: ${String(err)}`);
    }
  }
}

/** A task fact of a task a bot started: its wake comes from the fan-out path. */
export function isBotOwnedTaskFact(f: Fact): boolean {
  return f.kind.startsWith('task.') && typeof f.ref?.botId === 'string' && f.ref.botId.length > 0;
}

/**
 * The fact log as the trigger engine sees it: `subscribe` first replays the
 * facts after the cursor (or none on a first start), then delivers live
 * facts; every delivered seq moves the cursor; facts `accept` refuses are
 * skipped (and still move it).
 */
export function routedFactLog(
  log: FactLogApi & { latestSeq?: () => number },
  cursor: Pick<TriggerCursor, 'load' | 'mark'> & Partial<Pick<TriggerCursor, 'reset'>>,
  accept: (f: Fact) => boolean = (f) => !isBotOwnedTaskFact(f),
): FactLogApi {
  return {
    append: (draft) => log.append(draft),
    readSince: (c, filter, limit) => log.readSince(c, filter, limit),
    subscribe(fn) {
      const newest = typeof log.latestSeq === 'function' ? log.latestSeq() : null;
      let saved = cursor.load();
      // No cursor (first start) or one ahead of the log (another data dir):
      // begin at the newest fact.
      if (saved === null || (newest !== null && saved > newest)) {
        saved = newest;
        // Kept now, so facts appended before the next start are routed then
        // even if no fact arrives in this run.
        if (newest !== null) cursor.reset?.(newest);
      }
      let last = saved ?? 0;
      const deliver = (f: Fact): void => {
        if (f.seq <= last) return;
        last = f.seq;
        try {
          if (accept(f)) fn(f);
        } finally {
          cursor.mark(f.seq);
        }
      };
      if (saved !== null) {
        let at: string | null = String(saved);
        for (let i = 0; i < 10_000; i++) {
          const page: { facts: Fact[]; cursor: string | null } = log.readSince(at);
          for (const f of page.facts) deliver(f);
          if (page.cursor === null || page.cursor === at) break;
          at = page.cursor;
        }
      }
      return log.subscribe(deliver);
    },
  };
}

// ── Trust ──────────────────────────────────────────────────────────────────

const OWNER_LOGIN_REFRESH_MS = 10 * 60_000;

/** The host and a working directory for `gh` from the bots' repos
 *  (github.com and the home dir when no bot names one). */
export function ownerLoginTarget(bots: readonly Pick<BotProfile, 'repo'>[]): { host: string; cwd: string } {
  for (const b of bots) {
    const key = normalizeRepoKey(b.repo?.repoKey);
    const parts = key ? splitRepoKey(key) : null;
    if (parts && b.repo?.repoPath) return { host: parts.host, cwd: b.repo.repoPath };
  }
  return { host: 'github.com', cwd: os.homedir() };
}

/** Who counts as a trusted author: the settings' logins, plus the owner's gh
 *  login unless the Verifier is off for the owner's own PRs. */
export function factoryTrust(settings: () => FactorySettings, ownerLogin: () => string | null): FactoryTrustApi {
  return {
    trustedAuthors: () => settings().trustedAuthors,
    ownerLogin: () => (settings().verifierOnOwnerPrs === false ? null : ownerLogin()),
  };
}

// ── Bot hooks → facts ──────────────────────────────────────────────────────

/** A runtime hook as a fact, or null (an interrupted wake is a room card
 *  only). The bot is the actor, so its own refusal never wakes it. */
export function factFromBotHook(ev: BotHookEvent): FactDraft | null {
  const base = { at: ev.at, workspaceId: ev.workspaceId, ref: { botId: ev.botId }, actor: { kind: 'bot' as const, id: ev.botId } };
  if (ev.type === 'bot.budget_exhausted') {
    return { kind: 'bot.budget_exhausted', ...base, payload: { reason: ev.reason, ...(ev.wakeId ? { wakeId: ev.wakeId } : {}) } };
  }
  if (ev.type === 'bot.error') {
    return { kind: 'bot.error', ...base, payload: { message: ev.message.slice(0, 500), ...(ev.wakeId ? { wakeId: ev.wakeId } : {}) } };
  }
  return null;
}

/**
 * The bot runtime's hooks for the rooms module. Turns interrupted at the
 * last quit are reported while the runtime loads its queue, before the
 * rooms module subscribes: they are held (bounded) and replayed to the first
 * subscriber.
 */
export function bufferedBotHooks(subscribe: typeof onBotHook, max = 100): { subscribe(fn: (ev: RoomBotHookEvent) => void): () => void; dispose(): void } {
  let held: BotHookEvent[] | null = [];
  const off = subscribe((ev) => {
    if (!held || ev.type !== 'wake.interrupted') return;
    held.push(ev);
    if (held.length > max) held.shift();
  });
  return {
    subscribe(fn) {
      const replay = held ?? [];
      held = null;
      off();
      for (const ev of replay) {
        try {
          fn(ev);
        } catch {
          /* a listener never breaks the replay */
        }
      }
      return subscribe(fn);
    },
    dispose() {
      held = null;
      off();
    },
  };
}

// ── Bot runtime lookups ────────────────────────────────────────────────────

/** Facts by id from the log (the in-memory window). */
export function resolveFactsFrom(log: unknown, ids: readonly string[]): Fact[] {
  if (ids.length === 0) return [];
  const want = new Set(ids);
  return resolveFactsWhere(log, (f) => want.has(f.id), want.size);
}

/** Facts that match, from the log's in-memory window ([] when unreadable). */
export function resolveFactsWhere(log: unknown, match: (f: Fact) => boolean, limit = 1): Fact[] {
  if (!log || typeof (log as Partial<FactLog>).readWhere !== 'function') return [];
  try {
    return (log as FactLog).readWhere(0, match, limit).facts;
  } catch {
    return [];
  }
}

/** The newest `n` cards of a thread, oldest first, and whether older ones exist. */
export function threadTail(writer: RoomWriter | null, workspaceId: string, threadId: ThreadId, n: number): { cards: RoomCard[]; truncated: boolean } | null {
  if (!writer) return null;
  const page = writer.read(workspaceId, { threadId, limit: n });
  return { cards: page.cards, truncated: writer.summary(workspaceId, threadId).cardCount > page.cards.length };
}

/** The handoff a task wake answers: the one every task of the wake was
 *  started for (LedgerDispatch.handoffId), or null when the wake names no
 *  task, a task's row is not readable, or its tasks were started for
 *  different handoffs (or none). Pure over `row`. */
export function taskWakeHandoff(reason: WakeItem['reason'], row: (taskId: string) => Pick<LedgerEntry, 'dispatch'> | null): string | null {
  if (reason.kind !== 'facts') return null;
  const taskIds = new Set(reason.factIds.map(taskIdOfFactId).filter((t): t is string => t !== null));
  let found: string | null = null;
  for (const taskId of taskIds) {
    let id: string | undefined;
    try {
      id = row(taskId)?.dispatch?.handoffId;
    } catch {
      return null;
    }
    if (!id || (found !== null && found !== id)) return null;
    found = id;
  }
  return found;
}

/** The running wake of a bot, as the rooms and handoffs read it: its id, its
 *  attempt (1-based, the same for the whole turn), the handoff it carries (a
 *  handoff or a mention, or the one its tasks were started for) and an owner
 *  message's run. */
export function runningWakeOf(botId: string): RunningWake | null {
  const item = currentWakeItem(botId);
  if (!item) return null;
  const r = item.reason;
  const taskIds = new Set(r.kind === 'facts' ? r.factIds.map(taskIdOfFactId).filter((t): t is string => t !== null) : []);
  const ownerCardId = r.kind === 'human' ? humanCardIdOfRun(r.runId) : null;
  const taskHandoff = taskWakeHandoff(r, (id) => getTaskLedger().get(id));
  return {
    wakeId: item.id,
    attempt: Math.max(1, item.attempts),
    ...(r.kind === 'handoff' || r.kind === 'mention' ? { handoffId: r.handoffId } : taskHandoff ? { handoffId: taskHandoff } : {}),
    ...(r.kind === 'human' && r.runId ? { runId: r.runId } : {}),
    reasonKind: r.kind,
    ...(taskIds.size === 1 ? { taskId: [...taskIds][0] } : {}),
    ...(ownerCardId ? { ownerCardId } : {}),
  };
}

// ── Phone ──────────────────────────────────────────────────────────────────

export interface FactoryPhoneDeps {
  settings: () => FactorySettings;
  writer: () => RoomWriter | null;
  ports: () => Partial<FactoryRoomPorts>;
}

/**
 * A phone message to Moa with the factory on: a `human` card in the HQ bot's
 * room and a priority-0 wake for it, idempotent per (caller, message id).
 * Null when the factory is off (the daemon then takes the Moa path).
 */
export function factoryPhoneMessage(payload: MoaWakePayload, deps: FactoryPhoneDeps): MoaWakeResult | null {
  const settings = deps.settings();
  if (!settings.enabled) return null;
  const writer = deps.writer();
  const ports = deps.ports();
  // Not started yet (the first seconds after launch): retryable.
  if (!writer || !ports.wakes) return { ok: false, code: 'busy' };
  // The bot the phone talks to (phoneBot.ts): pinned, else a Coordinator,
  // else the HQ room's oldest.
  let enabledBots: BotProfile[] = [];
  try {
    enabledBots = ports.bots?.listEnabled() ?? [];
  } catch {
    enabledBots = [];
  }
  const bot = phoneBot(enabledBots, settings);
  if (!bot) return { ok: false, code: 'hq_missing' };
  const actor = crypto.createHash('sha256').update(payload.actor).digest('hex').slice(0, 16);
  const clientPostId = `phone:${actor}:${payload.clientMessageId}`.slice(0, ROOM_LIMITS.CLIENT_ID_MAX);
  const r = postHumanMessage(writer, ports, {
    workspaceId: bot.workspaceId,
    // The phone's chat with its bot is that bot's 1:1, as on the desktop.
    threadId: dmThreadId(bot.id),
    title: oneLine(payload.text, ROOM_LIMITS.TITLE_MAX) || 'Message',
    body: capBody(payload.text),
    // The card holds a capped copy; the bot's wake carries the whole message.
    wakeText: payload.text,
    toBotId: bot.id,
    clientPostId,
    source: 'phone',
  });
  // The card is up but the HQ bot's queue took no wake, even past its cap:
  // a retryable refusal, so the phone sends the same id again and that retry
  // queues the wake once (postHumanMessage).
  if (!r.ok) return r.code === 'queue_full' ? { ok: false, code: 'busy' } : { ok: false, code: 'hq_unknown' };
  // A first send or a retry: the message's one wake is queued (or already ran).
  if (r.wakeId) return { ok: true, accepted: true, queued: true };
  // A retry whose card names a bot that is no longer the HQ bot.
  return { ok: false, code: 'duplicate' };
}

/**
 * The phone's answer once the message's wake is on disk (a restart then still
 * runs it), as the desktop's owner message waits. A failed write answers a
 * retryable `busy`: the same message id posts the same card and its one wake
 * again, and that retry writes it.
 */
export async function factoryPhoneMessageSaved(payload: MoaWakePayload, deps: FactoryPhoneDeps): Promise<MoaWakeResult | null> {
  const r = factoryPhoneMessage(payload, deps);
  if (!r?.ok) return r;
  const wakes = deps.ports().wakes;
  if (!wakes?.flush) return r;
  try {
    await wakes.flush();
  } catch (err) {
    console.warn(`[factory] phone message wake not on disk: ${String(err)}`);
    return { ok: false, code: 'busy' };
  }
  return r;
}

// ── Tasks: views, stop ─────────────────────────────────────────────────────

type Daemon = Pick<NonNullable<ReturnType<FactoryHostDeps['getDaemonClient']>>, 'rpc'>;

/** A daemon RPC as a plain function, or null without a daemon. */
export function daemonRpc(client: () => Daemon | null): ((method: string, params?: unknown) => Promise<unknown>) | null {
  const c = client();
  return c ? (method, params) => c.rpc(method as never, params as Record<string, unknown> | undefined) : null;
}

/** Stop the processes of a bot task's worker: the daemon sessions of its
 *  workspace started in its worktree (a research task's scratch folder), the
 *  folder kept. Each pane's agent and everything below it first (the daemon's
 *  session.stopAgent: asked to exit, killed after a grace, checked gone),
 *  then the pane itself, checked gone (stopSessionsInDir). `workspacePtys`:
 *  the panes a workspace owns, null when the workspace tree is not known (a
 *  session started in the folder then counts). A pane in another workspace,
 *  such as a terminal the owner opened in the folder, is never touched.
 *  How many sessions were confirmed stopped; throws when one was not. */
export async function stopTaskWorker(
  entry: LedgerEntry,
  client: () => Daemon | null,
  workspacePtys?: (workspaceId: string) => readonly string[] | null,
): Promise<number> {
  const rpc = daemonRpc(client);
  if (!rpc) throw new Error('the daemon is not connected');
  const worktree = await taskFolderFromMissions(rpc, entry);
  if (!worktree) throw new Error('the task worktree is not known');
  const own = workspacePtys?.(entry.taskWorkspaceId) ?? null;
  const listSessions = async (): Promise<Array<{ id: string; pid?: number; spawnCwd?: string }>> => {
    const sessions = await rpc('daemon.listSessions', {});
    const all = Array.isArray(sessions) ? (sessions as Array<{ id: string; pid?: number; spawnCwd?: string }>) : [];
    return own ? all.filter((x) => own.includes(x.id)) : all;
  };
  for (const id of await sessionsStartedIn([worktree], { listSessions })) {
    const r = (await rpc('session.stopAgent', { sessionId: id })) as { ok?: boolean; code?: string } | null;
    // Gone already, or a pane whose agent the daemon cannot stop this way
    // (WSL, an exec unit): the pane's own stop below ends it.
    if (r?.ok !== true && r?.code !== 'no_session' && r?.code !== 'unsupported') {
      throw new Error(`the agent in ${id} was not stopped (${r?.code ?? 'no answer'})`);
    }
  }
  const stopped = await stopSessionsInDir(worktree, {
    listSessions,
    destroySession: async (id) => {
      await rpc('daemon.destroySession', { id });
    },
    isAlive: isPidAlive,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => console.warn(message),
  });
  if (stopped.length > 0) console.log(`[factory] stopped ${stopped.length} session(s) of task ${entry.id}`);
  return stopped.length;
}

/** The panes (daemon sessions) a workspace owns, stashed ones included; []
 *  for a workspace that is not open; null while the tree is not known. */
function taskWorkspacePtys(workspaceId: string): readonly string[] | null {
  const entries = getWorkspaceMirror().getEntries();
  if (!entries) return null;
  const e = entries.find((x) => x.id === workspaceId);
  return e && Array.isArray(e.ptyIds) ? e.ptyIds : [];
}

/** The PR facts in the fact log's window, oldest first. */
export function prFactsOf(log: unknown): Fact[] {
  return resolveFactsWhere(log, (f) => f.kind === 'pr.opened' || f.kind === 'pr.merged' || f.kind === 'pr.closed', 50_000);
}

/** A bot's task left `input_required` (its worker went on, reported or
 *  ended). Pure. */
export function botTaskStoppedWaiting(t: { from: string | null; to: string; entry: { dispatch?: { origin?: { kind?: string } } } }): boolean {
  return t.from === 'input_required' && t.to !== 'input_required' && t.entry.dispatch?.origin?.kind === 'bot';
}

/** The app's UI locale (what the renderer last saved), else the OS one. */
function uiLocaleNow(): string {
  try {
    // Lazy so importing this module never drags electron into a test process.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    return readUiLocale(app.getPath('userData'), app.getLocale());
  } catch {
    return 'en';
  }
}

// ── Module ─────────────────────────────────────────────────────────────────

export function createFactoryWiring(deps: Pick<FactoryHostDeps, 'wmuxDir'> & Partial<Pick<FactoryHostDeps, 'getDaemonClient' | 'getMainWindow' | 'fanOutService'>>): FactoryModuleHandle {
  const settings = (): FactorySettings => getFactorySettings();
  let ownerLogin: string | null = null;
  let loginTimer: NodeJS.Timeout | null = null;
  let disposed = false;
  const refreshLogin = async (): Promise<void> => {
    let bots: BotProfile[] = [];
    try {
      bots = getBotDirectory()?.listEnabled() ?? [];
    } catch {
      bots = [];
    }
    const { host, cwd } = ownerLoginTarget(bots);
    const login = await ghIssueService.signedInLogin(host, cwd).catch(() => null);
    if (login) ownerLogin = login;
  };

  const cursor = new TriggerCursor(path.join(deps.wmuxDir(), 'factory', TRIGGER_CURSOR_FILENAME));
  let routed: { log: FactLogApi; view: FactLogApi } | null = null;
  const triggerLog = (): FactLogApi | undefined => {
    const log = getFactLog();
    if (!log) return undefined;
    if (routed?.log !== log) routed = { log, view: routedFactLog(log as FactLogApi & { latestSeq?: () => number }, cursor) };
    return routed.view;
  };
  const bots = (): BotDirectoryApi | undefined => getBotDirectory() ?? undefined;
  const trust = factoryTrust(settings, () => ownerLogin);

  setFactoryTriggerPorts(() => ({
    factLog: triggerLog(),
    wakes: getWakeQueue() ?? undefined,
    bots: bots(),
    trust,
    factoryEnabled: () => settings().enabled,
  }));

  const hooks = bufferedBotHooks(onBotHook);
  const roomPorts = (): Partial<FactoryRoomPorts> => ({
    factLog: getFactLog() ?? undefined,
    wakes: getWakeQueue() ?? undefined,
    bots: bots(),
    botHooks: hooks,
    currentWakeThread,
    currentWake: runningWakeOf,
    groups: getGroupStore() ?? undefined,
  });
  setFactoryRoomPorts(roomPorts);

  const contextPorts = (): WakeContextPorts => ({
    cards: (workspaceId, threadId, limit, sinceSeq) => getRoomWriter()?.read(workspaceId, {
      ...(threadId ? { threadId } : {}), limit, ...(sinceSeq !== undefined ? { sinceSeq } : {}),
    }).cards ?? [],
    findCard: (workspaceId, match) => getRoomWriter()?.find(workspaceId, match) ?? null,
    approvals: (workspaceId) => getApprovalService()?.listForOperator(workspaceId) ?? [],
    botName: (botId) => getBotDirectory()?.get(botId)?.name || null,
    uiLocale: uiLocaleNow,
    group: (workspaceId, threadId) => getGroupStore()?.byThread(workspaceId, threadId) ?? null,
  });
  setBotRuntimePorts({
    resolveFacts: (ids) => resolveFactsFrom(getFactLog(), ids),
    resolveHandoff: summarizeHandoff,
    taskHandoff: (item) => taskWakeHandoff(item.reason, (id) => getTaskLedger().get(id)),
    readThreadTail: (workspaceId, threadId, n) => threadTail(getRoomWriter(), workspaceId, threadId, n),
    wakeContext: (profile, item) => wakeContext(contextPorts(), profile, item),
    onTurnDone: (profile, item) => getHandoffRouter()?.closeAnsweredInChat(profile.id, item),
    // The runtime starts before these modules (modules.ts): a wake restored
    // at launch waits for its handoff, thread and routine to be readable.
    contextReady: () => getRoomWriter() !== null && getHandoffRouter() !== null && getRoutineStore() !== null,
  });

  const offHookFacts = onBotHook((ev) => {
    const draft = factFromBotHook(ev);
    if (!draft) return;
    try {
      getFactLog()?.append(draft);
    } catch (err) {
      console.warn(`[factory] ${ev.type} fact not written: ${String(err)}`);
    }
  });

  setFactoryPhoneMessageHandler((payload) => factoryPhoneMessageSaved(payload, { settings, writer: getRoomWriter, ports: roomPorts }));

  const morning = new MorningSchedule({
    file: path.join(deps.wmuxDir(), 'factory', MORNING_SCHEDULE_FILENAME),
    settings,
    // The roles module (loaded with every factory module) holds the live
    // ports; read when the schedule fires, after every module started.
    fire: async (scheduleId) => fireMorningReport(scheduleId, (await import('./roles')).morningReportPorts(deps.wmuxDir())),
    reportedOn: (day) => resolveFactsWhere(getFactLog(), (f) => f.kind === 'schedule.fired' && f.ref?.scheduleId === MORNING_SCHEDULE_ID && localDay(f.at) === day).length > 0,
  });

  let offVerdicts: (() => void) | null = null;
  const offTasks: Array<() => void> = [];
  const daemon = (): Daemon | null => deps.getDaemonClient?.() ?? null;

  /** The Bots page re-reads its bots (and their tasks) on any BOT_EVENT. */
  const pushBotsChanged = (): void => {
    try {
      const win = deps.getMainWindow?.();
      if (win && !win.isDestroyed()) win.webContents.send(BOT_EVENT, { type: 'bots-changed' });
    } catch {
      /* best effort */
    }
  };

  return {
    start() {
      if (disposed) return;
      // Verify tasks whose bot verdict is recorded stop counting as workers
      // and are closed in the ledger.
      const verdicted = new VerdictedTasks(path.join(deps.wmuxDir(), 'factory', VERDICTED_TASKS_FILENAME));
      verdicted.load();
      setVerdictedTasks(verdicted);
      const ledger = getTaskLedger();
      offVerdicts = installVerifyTaskClose({ ledger, verdicted, onRecorded: onPrVerdictRecorded, onTransition: (fn) => ledger.onTransition(fn) });
      // A bot task that stops waiting for input: its bot's questions about
      // it close (handoffRouter.ts closeTaskQuestions).
      offTasks.push(ledger.onTransition((t) => {
        if (botTaskStoppedWaiting(t)) void getHandoffRouter()?.closeTaskQuestions(t.entry.id).catch(() => undefined);
      }));
      // The task gate, once every module started (its restart catch-up
      // writes cards, and the rooms module starts after this one).
      const gateTimer = setImmediate(() => {
        if (disposed) return;
        offTasks.push(installTaskGate({
          onTransition: (fn) => ledger.onTransition(fn),
          ledgerRow: (id) => ledger.get(id),
          openRows: () => ledger.list({ openOnly: true }),
          allRows: () => ledger.list({}),
          bot: (id) => getBotDirectory()?.get(id) ?? null,
          worktreeOf: (entry) => worktreeFromMissions(daemonRpc(daemon), entry),
          baseRef: (repoPath) => originDefaultRef(git, repoPath),
          runGate: async (input) => {
            const runner = getSharedTaskGateRunner();
            if (!runner) return { ok: false, status: 'refused', taskId: input.taskId, error: 'the task gate runner is not up yet' };
            return runner.run(input);
          },
          complete: (taskId) => completeCheckedTask(ledger, taskId),
          completeResearch: (taskId) => completeResearchTask(ledger, taskId),
          wake: (input) => {
            const q = getWakeQueue();
            if (!q) console.info(`[factory] wake queue not running; ${input.botId} was not woken`);
            return q?.enqueue(input) ?? null;
          },
          note: (workspaceId, threadId, title, body, key) => {
            const writer = getRoomWriter();
            if (!writer || gateCardNoted((ws, m) => writer.find(ws, m), workspaceId, threadId, key)) return;
            writer.append({ workspaceId, threadId, kind: 'fact', actor: { kind: 'system' }, title, body }, { clientPostId: key });
          },
          noted: (workspaceId, threadId, key) => {
            const writer = getRoomWriter();
            return gateCardNoted(writer ? (ws, m) => writer.find(ws, m) : null, workspaceId, threadId, key);
          },
        }));
      });
      offTasks.push(() => clearImmediate(gateTimer));
      // A worker's life after its answer: the report nudge, the reclaim of an
      // ended task's worker and its resume, the agent budget.
      if (deps.getDaemonClient) void import('./workerLifecycleHost')
        .then((m) => {
          if (disposed) return;
          offTasks.push(m.startWorkerLifecycle({ wmuxDir: deps.wmuxDir, getDaemonClient: deps.getDaemonClient, getMainWindow: deps.getMainWindow, fanOutService: deps.fanOutService }));
        })
        .catch((err) => console.warn(`[factory] worker lifecycle not started: ${String(err)}`));
      const branches = new TaskBranchCache(async (owner) => {
        const rpc = daemonRpc(daemon);
        if (!rpc) throw new Error('the daemon is not connected');
        return rpc('task.mission.list', { verifiedWorkspaceId: owner });
      });
      setBotTaskSources({
        rows: () => ledger.list({}),
        workerState: (taskId) => reclaimedWorkerState(getWorkerResumePorts()?.store.get(taskId) ?? null),
        workerWorkspace: (taskId) => {
          const rec = getWorkerResumePorts()?.store.get(taskId);
          return rec ? workerWorkspaceOf(rec) : null;
        },
        waiting: () => getAgentSlots()?.waiting() ?? [],
        branches: (rows) => branches.branches(rows),
        prFacts: () => prFactsOf(getFactLog()),
      });
      const stopPorts: FactoryStopPorts = {
        runtime: getBotRuntime,
        botIds: () => getBotStore()?.list({}).map((b) => b.id) ?? [],
        ledger,
        gates: getSharedTaskGateRunner,
        stopWorker: (entry) => stopTaskWorker(entry, daemon, taskWorkspacePtys),
        isOff: () => !settings().enabled,
        pauseRoutines: (botId) => getRoutineStore()?.pauseFor(botId, 'stop') ?? 0,
        stopResumed: async (botId) => {
          const p = getWorkerResumePorts();
          return p ? stopResumedWorkers(p, botId) : 0;
        },
      };
      setFactoryStopPorts(stopPorts);
      offTasks.push(installLateStopSweep({ ...stopPorts, onTransition: (fn) => ledger.onTransition(fn) }));
      offTasks.push(ledger.onTransition((t) => {
        if (t.entry.dispatch?.origin.kind === 'bot') pushBotsChanged();
      }));
      const offPrFacts = getFactLog()?.subscribe((f) => {
        if (f.kind === 'pr.opened' || f.kind === 'pr.merged' || f.kind === 'pr.closed') pushBotsChanged();
      });
      if (offPrFacts) offTasks.push(offPrFacts);
      morning.start();
      void refreshLogin();
      loginTimer = setInterval(() => void refreshLogin(), OWNER_LOGIN_REFRESH_MS);
      loginTimer.unref?.();
    },
    dispose() {
      disposed = true;
      for (const off of offTasks.splice(0)) {
        try {
          off();
        } catch {
          /* best effort */
        }
      }
      setBotTaskSources(null);
      setFactoryStopPorts(null);
      offVerdicts?.();
      setVerdictedTasks(null);
      morning.dispose();
      if (loginTimer) clearInterval(loginTimer);
      loginTimer = null;
      offHookFacts();
      hooks.dispose();
      setFactoryPhoneMessageHandler(null);
      cursor.flush();
    },
  };
}

registerFactoryRpcModule('wiring', (_router, deps) => createFactoryWiring(deps));
