// Agent factory bots — the renderer's read side and the Factory settings tab.
// The bot runtime itself lives in the `bot-runtime` factory module
// (pipe/handlers/bot.rpc.ts); this reads its singletons, which are null
// before the factory started (an empty list, null status, default settings).
// Changes to bots reach the renderer as BOT_EVENT pushes from that module.
// The writes (FACTORY_BOT_CREATE, FACTORY_BOT_CREATE_TEAM, FACTORY_SETTINGS_SET, and a bot's picture:
// FACTORY_BOT_PICK_AVATAR, FACTORY_BOT_SET_AVATAR) act as the operator, so
// they answer only the main window's top frame, as rpc:invoke does for the
// other bot writes. So does FACTORY_BOT_SUGGEST_REPO, which reads a
// workspace's folder, and so do the owner's stops (FACTORY_STOP_ALL,
// FACTORY_STOP_BOT: factory/factoryStop.ts), and the owner's resume of a
// stopped worker (FACTORY_WORKER_RESUME: factory/workerReclaim.ts), and the
// owner's Apply of a bot task's changes to the bot's repository folder
// (FACTORY_TASK_APPLY: factory/taskApply.ts), and the owner's New
// conversation for a bot (FACTORY_BOT_NEW_CONVERSATION).
// A bot row carries the bot's tasks with their stage (factory/botTasks.ts).
import fs from 'node:fs';
import { dialog, ipcMain, nativeImage, type BrowserWindow, type OpenDialogOptions } from 'electron';
import { IPC } from '../../../shared/constants';
import { BOT_ID_RE, HERMES_BOT_ENGINE, MY_HERMES_DEFAULT_PROFILE, isCoordinatorBot, myHermesEngine, ownHermesProfile, type BotProfile, type BotStatus } from '../../../shared/bot';
import { wrapHandler } from '../wrapHandler';
import { getBotStore } from '../../factory/botStore';
import { getBotRuntime, type BotRuntime } from '../../factory/BotRuntime';
import { getFactorySettings, getFactorySettingsStore, type FactorySettings } from '../../factory/factorySettings';
import { createBotFromFolder, createTeamFromFolder, greetNewBot, suggestBotRepo, type BotRepoDeps, type BotRepoSuggestDeps } from '../../factory/botCreate';
import { getWakeQueue } from '../../factory/wakeQueue';
import type {
  FactoryBotAvatarPickResult,
  FactoryBotAvatarSetResult,
  FactoryBotClearRemovedResult,
  FactoryBotCreateResult,
  FactoryBotCreateTeamResult,
  FactoryBotRepoSuggestion,
} from '../../../shared/botCreate';
import { getWorkspaceMirror } from '../../workspace/WorkspaceMirror';
import { BOT_AVATAR_EXTENSIONS, pickBotAvatar, type BotAvatarPickerDeps } from '../../factory/botAvatar';
import { isMainWindowSender } from '../mainWindowSender';
import type { BotTaskView, FactoryTaskApplyResult, FactoryTaskFolderCleanResult, FactoryTaskFolderUsage } from '../../../shared/botTask';
import { applyTaskToCheckout, getTaskApplyPorts, type TaskApplyPorts } from '../../factory/taskApply';
import { cleanTaskFolders, getTaskFolderPorts, taskFolderUsage } from '../../factory/taskFolderCleanup';
import { botTaskViews, getBotTaskSources, type BotTaskSources } from '../../factory/botTasks';
import { getFactoryStopPorts, stopFactoryTask, stopFactoryWork, type FactoryStopPorts, type FactoryStopResult } from '../../factory/factoryStop';
import { getWorkerResumePorts, ownerResumeWorker, type WorkerResumePorts, type WorkerResumeResult } from '../../factory/workerReclaim';
import { getAgentSlots, type AgentSlots } from '../../factory/agentSlots';
import { botClaudeConfigDir, engineReadiness, startEngineLogin, type EngineLoginDeps, type EngineReadinessDeps } from '../../factory/engineReadiness';
import { resolveConversationAccount } from '../../account/backgroundLaunchAccount';
import { VENDOR_ENV_KEYS } from '../../account/accountStore';
import type { FactoryEngineReadiness } from '../../../shared/factoryEngine';
import { BOT_WORKER_AGENTS, botWorkerAgentLabel, botWorkerAgentSupported, type BotWorkerAgentOption } from '../../../shared/botWorkerAgent';
import { agentExecEnv } from '../../../shared/execEnv';
import { resolveOnPath } from '../../factory/botEngines';
import { resolveClaudeExecutable } from '../../claude/resolveClaudeExecutable';
import { loadClaudeCredential } from '../../claude/claudeCredential';
import { sendToRenderer } from '../../pipe/handlers/_bridge';
import { ShellDetector } from '../../../shared/ShellDetector';
import { getHermesHost, type HermesHost } from '../../factory/hermesHost';
import type { HermesReadiness, MyHermesStatus } from '../../../shared/hermesEngine';
import { confirmMyHermesNatively, myHermesBindRefusal, myHermesStatus, type MyHermesBindDeps, type MyHermesConfirm } from '../../factory/myHermesBind';
import { getGroupStore } from '../../factory/groupStore';
import { checkClaudeApiKey, getClaudeApiKeyStore, type ClaudeApiKeyCheck, type ClaudeApiKeySetResult, type ClaudeApiKeyStatus, type ClaudeApiKeyStore } from '../../factory/claudeApiKey';

export interface FactoryBotRow {
  bot: BotProfile;
  status: BotStatus | null;
  /** The bot's tasks, newest first, with their stage (absent: none, or the
   *  factory has not started). */
  tasks?: BotTaskView[];
}

function workspaceOf(req: unknown): string | undefined {
  const ws = req && typeof req === 'object' ? (req as { workspaceId?: unknown }).workspaceId : undefined;
  return typeof ws === 'string' && ws.length > 0 ? ws : undefined;
}

export function factoryBotRows(workspaceId?: string): FactoryBotRow[] {
  const store = getBotStore();
  if (!store) return [];
  const runtime = getBotRuntime();
  return store.list(workspaceId ? { workspaceId } : {}).map((bot) => ({ bot, status: runtime?.status(bot.id) ?? null }));
}

/** The bot rows with each bot's tasks (rows without tasks when the task
 *  sources are not up, or reading them fails). */
export async function factoryBotRowsWithTasks(
  workspaceId?: string,
  rows: (ws?: string) => FactoryBotRow[] = factoryBotRows,
  sources: () => BotTaskSources | null = getBotTaskSources,
): Promise<FactoryBotRow[]> {
  const list = rows(workspaceId);
  const src = sources();
  if (!src || list.length === 0) return list;
  try {
    const views = await botTaskViews(list.map((r) => r.bot), src);
    return list.map((r) => (views.has(r.bot.id) ? { ...r, tasks: views.get(r.bot.id) } : r));
  } catch {
    return list;
  }
}

const STOP_NONE = { botsInterrupted: 0, workersStopped: 0, tasksCancelled: 0, gatesCancelled: 0 } as const;

/** A bot task's ledger id. */
const TASK_ID_RE = /^wtask-[A-Za-z0-9_-]{1,80}$/;

/** FACTORY_STOP_ALL / FACTORY_STOP_BOT / FACTORY_STOP_TASK's body: the
 *  sender check, the bot id (stop-bot) or task id (stop-task), then
 *  factoryStop. A stop of a bot the store no longer holds still stops the
 *  tasks it started. */
export function factoryStopHandler(
  getWindow: () => BrowserWindow | null,
  scope: 'all' | 'bot' | 'task',
  ports: () => FactoryStopPorts | null = getFactoryStopPorts,
): (e: { sender?: unknown; senderFrame?: unknown }, req?: unknown) => Promise<FactoryStopResult> {
  return async (e, req) => {
    if (!isMainWindowSender(e, getWindow())) return { ok: false, ...STOP_NONE, code: 'operator_only', message: 'only the main window may stop the bots' };
    // One task's worker (the Bots page's Stop worker): that task only.
    if (scope === 'task') {
      const raw = req && typeof req === 'object' && !Array.isArray(req) ? (req as { taskId?: unknown }).taskId : undefined;
      if (typeof raw !== 'string' || !TASK_ID_RE.test(raw)) return { ok: false, ...STOP_NONE, code: 'invalid_argument', message: 'taskId must be a task id' };
      const p = ports();
      if (!p) return { ok: false, ...STOP_NONE, code: 'not_started', message: 'The factory is not running.' };
      return stopFactoryTask(p, raw);
    }
    let botId: string | undefined;
    if (scope === 'bot') {
      const raw = req && typeof req === 'object' && !Array.isArray(req) ? (req as { botId?: unknown }).botId : undefined;
      if (typeof raw !== 'string' || !BOT_ID_RE.test(raw)) return { ok: false, ...STOP_NONE, code: 'invalid_argument', message: 'botId must be a bot id' };
      botId = raw;
    }
    const p = ports();
    if (!p) return { ok: false, ...STOP_NONE, code: 'not_started', message: 'The factory is not running.' };
    return stopFactoryWork(p, botId !== undefined ? { botId } : {});
  };
}

/** FACTORY_BOT_NEW_CONVERSATION's body: the sender check, the bot id, then
 *  BotRuntime.newConversation. */
export function factoryBotNewConversationHandler(
  getWindow: () => BrowserWindow | null,
  runtime: () => Pick<BotRuntime, 'newConversation'> | null = getBotRuntime,
): (e: { sender?: unknown; senderFrame?: unknown }, req?: unknown) => { ok: true } | { ok: false; code: string; message: string } {
  return (e, req) => {
    if (!isMainWindowSender(e, getWindow())) return { ok: false, code: 'operator_only', message: 'only the main window may start a bot\'s new conversation' };
    const raw = req && typeof req === 'object' && !Array.isArray(req) ? (req as { botId?: unknown }).botId : undefined;
    if (typeof raw !== 'string' || !BOT_ID_RE.test(raw)) return { ok: false, code: 'invalid_argument', message: 'botId must be a bot id' };
    const r = runtime();
    if (!r) return { ok: false, code: 'not_started', message: 'The factory is not running.' };
    const res = r.newConversation(raw);
    return res.ok ? { ok: true } : { ok: false, code: res.code, message: res.message };
  };
}

/** FACTORY_WORKER_RESUME's body: the sender check, the task id, then the
 *  owner's resume (workerReclaim.ts ownerResumeWorker, which the phone's
 *  Resume runs too). */
export function factoryWorkerResumeHandler(
  getWindow: () => BrowserWindow | null,
  ports: () => WorkerResumePorts | null = getWorkerResumePorts,
  slots: () => AgentSlots | null = getAgentSlots,
): (e: { sender?: unknown; senderFrame?: unknown }, req?: unknown) => Promise<WorkerResumeResult> {
  return async (e, req) => {
    if (!isMainWindowSender(e, getWindow())) return { ok: false, code: 'operator_only', message: 'only the main window may resume a worker' };
    const raw = req && typeof req === 'object' && !Array.isArray(req) ? (req as { taskId?: unknown }).taskId : undefined;
    if (typeof raw !== 'string' || !TASK_ID_RE.test(raw)) return { ok: false, code: 'invalid_argument', message: 'taskId must be a task id' };
    return ownerResumeWorker(raw, ports, slots);
  };
}

/** FACTORY_TASK_APPLY's body: the sender check, the task id, then the
 *  owner's Apply (taskApply.ts), which reads everything else from main's
 *  records. */
export function factoryTaskApplyHandler(
  getWindow: () => BrowserWindow | null,
  ports: () => TaskApplyPorts | null = getTaskApplyPorts,
): (e: { sender?: unknown; senderFrame?: unknown }, req?: unknown) => Promise<FactoryTaskApplyResult> {
  return async (e, req) => {
    if (!isMainWindowSender(e, getWindow())) return { ok: false, code: 'operator_only', message: 'only the main window may apply a task' };
    const raw = req && typeof req === 'object' && !Array.isArray(req) ? (req as { taskId?: unknown }).taskId : undefined;
    if (typeof raw !== 'string' || !TASK_ID_RE.test(raw)) return { ok: false, code: 'invalid_argument', message: 'taskId must be a task id' };
    const p = ports();
    if (!p) return { ok: false, code: 'not_started', message: 'The factory is not running.' };
    return applyTaskToCheckout(p, raw);
  };
}

const DEFAULT_READINESS_DEPS: EngineReadinessDeps = {
  claudeExecutable: resolveClaudeExecutable,
  credential: async () => {
    // The folder the bot engine's claude reads (it inherits main's env).
    const r = await loadClaudeCredential(botClaudeConfigDir());
    return r.ok ? { ok: true } : { ok: false, reason: r.reason, ...(r.detail ? { detail: r.detail } : {}) };
  },
};

/** FACTORY_ENGINE_READINESS: main window only (any other sender reads as
 *  unknown, never as ready). */
export function factoryEngineReadinessHandler(
  getWindow: () => BrowserWindow | null,
  deps: EngineReadinessDeps = DEFAULT_READINESS_DEPS,
): (e: { sender?: unknown; senderFrame?: unknown }) => Promise<FactoryEngineReadiness> {
  return async (e) => {
    if (!isMainWindowSender(e, getWindow())) return { ready: false, reason: 'unknown', message: 'only the main window may ask' };
    return engineReadiness(deps);
  };
}

/** FACTORY_WORKER_AGENTS: the engines a bot's workers may run on, each with
 *  whether its CLI is on the login shell's PATH here (the lookup bot engines
 *  use, botEngines.resolveOnPath). Main window only; any other sender gets
 *  none. */
export function factoryWorkerAgentsHandler(
  getWindow: () => BrowserWindow | null,
  deps: { env?: () => Promise<NodeJS.ProcessEnv>; resolve?: (cmd: string, env: NodeJS.ProcessEnv) => string | null; platform?: NodeJS.Platform } = {},
): (e: { sender?: unknown; senderFrame?: unknown }) => Promise<BotWorkerAgentOption[]> {
  return async (e) => {
    if (!isMainWindowSender(e, getWindow())) return [];
    const env = await (deps.env ?? (() => agentExecEnv(process.env)))();
    const resolve = deps.resolve ?? ((cmd: string, en: NodeJS.ProcessEnv) => resolveOnPath(cmd, en));
    const platform = deps.platform ?? process.platform;
    return BOT_WORKER_AGENTS.map((agent) => ({ agent, label: botWorkerAgentLabel(agent), installed: resolve(agent, env) !== null, supported: botWorkerAgentSupported(agent, platform) }));
  };
}

/** FACTORY_TASK_FOLDERS_USAGE: the space bot task folders use; null for
 *  another sender or before the factory runs. */
export function factoryTaskFoldersUsageHandler(
  getWindow: () => BrowserWindow | null,
  ports: () => ReturnType<typeof getTaskFolderPorts> = getTaskFolderPorts,
): (e: { sender?: unknown; senderFrame?: unknown }) => Promise<FactoryTaskFolderUsage | null> {
  return async (e) => {
    if (!isMainWindowSender(e, getWindow())) return null;
    const p = ports();
    return p ? taskFolderUsage(p, p.allRows()) : null;
  };
}

/** FACTORY_TASK_FOLDERS_CLEAN: Clean up now — the task-end rules applied to
 *  every ended bot task (a folder kept dirty is looked at again). */
export function factoryTaskFoldersCleanHandler(
  getWindow: () => BrowserWindow | null,
  ports: () => ReturnType<typeof getTaskFolderPorts> = getTaskFolderPorts,
): (e: { sender?: unknown; senderFrame?: unknown }) => Promise<FactoryTaskFolderCleanResult> {
  return async (e) => {
    if (!isMainWindowSender(e, getWindow())) return { ok: false, code: 'operator_only', message: 'only the main window may clean up task folders' };
    const p = ports();
    if (!p) return { ok: false, code: 'not_started', message: 'The factory is not running.' };
    try {
      return { ok: true, ...(await cleanTaskFolders(p, p.allRows(), { force: true })) };
    } catch (err) {
      return { ok: false, code: 'unavailable', message: `The daemon could not be read: ${String(err)}` };
    }
  };
}

/** The Claude config folder a bot's turns sign in with: the account its
 *  conversation runs on, else its workspace's binding, else main's own
 *  (botClaudeConfigDir). Undefined: Claude's default folder. Throws for a
 *  bot that is gone. */
export function botLoginConfigDir(
  botId: string,
  ports: {
    workspaceOf: (botId: string) => string | null;
    accountOf: (botId: string) => string | null | undefined;
    resolve?: typeof resolveConversationAccount;
  } = {
    workspaceOf: (id) => getBotStore()?.get(id)?.workspaceId ?? null,
    accountOf: (id) => getBotRuntime()?.claudeAccountOf(id),
  },
): string | undefined {
  const workspaceId = ports.workspaceOf(botId);
  if (!workspaceId) throw new Error('that bot is gone');
  const { run } = (ports.resolve ?? resolveConversationAccount)(workspaceId, 'claude', ports.accountOf(botId));
  return run.env[VENDOR_ENV_KEYS.claude] ?? botClaudeConfigDir();
}

/** FACTORY_ENGINE_LOGIN: open the Claude sign-in tab; main window only.
 *  `{ botId }`: the sign-in of the account that bot runs on. */
export function factoryEngineLoginHandler(
  getWindow: () => BrowserWindow | null,
  deps: Omit<EngineLoginDeps, 'platform'> & { platform?: NodeJS.Platform; botConfigDir?: (botId: string) => string | undefined },
): (e: { sender?: unknown; senderFrame?: unknown }, req?: unknown) => Promise<void> {
  return async (e, req) => {
    if (!isMainWindowSender(e, getWindow())) throw new Error('only the main window may start the Claude sign-in');
    // No request: main's own sign-in. A request names a bot, or is refused.
    let botId: string | null = null;
    if (req !== undefined) {
      const named = req && typeof req === 'object' ? (req as { botId?: unknown }).botId : undefined;
      if (typeof named !== 'string' || !BOT_ID_RE.test(named)) throw new Error('not a bot id');
      botId = named;
    }
    // The sign-in goes to the folder readiness reads and the bots run on,
    // or to the one a named bot's account keeps its sign-in in.
    const { botConfigDir, ...login } = deps;
    const configDir = botId ? (botConfigDir ?? botLoginConfigDir)(botId) : botClaudeConfigDir();
    await startEngineLogin({ ...login, configDir, platform: deps.platform ?? process.platform });
  };
}

function defaultEngineLoginDeps(getWindow: () => BrowserWindow | null): Omit<EngineLoginDeps, 'platform'> {
  return {
    openTab: async (shell, initialCommand) =>
      (await sendToRenderer(getWindow, 'surface.new', { ...(shell ? { shell } : {}), initialCommand }, { timeoutMs: 15_000 })) as { ptyId?: unknown; error?: unknown } | null,
    windowsShell: () => new ShellDetector().getDefault(),
  };
}

/** FACTORY_HERMES_READINESS: main window only (any other sender reads as
 *  unknown, never as ready). `{ fresh: true }`: checked again, not cached. */
export function factoryHermesReadinessHandler(
  getWindow: () => BrowserWindow | null,
  host: () => Pick<HermesHost, 'readiness'> = getHermesHost,
): (e: { sender?: unknown; senderFrame?: unknown }, req?: unknown) => Promise<HermesReadiness> {
  return async (e, req) => {
    if (!isMainWindowSender(e, getWindow())) return { ready: false, reason: 'unknown', message: 'only the main window may ask' };
    const fresh = !!req && typeof req === 'object' && (req as { fresh?: unknown }).fresh === true;
    return host().readiness(fresh);
  };
}

/** FACTORY_HERMES_SETUP: open a terminal tab running Hermes's own `hermes
 *  model` against wmux's Hermes home; main window only. */
export function factoryHermesSetupHandler(
  getWindow: () => BrowserWindow | null,
  deps: Omit<EngineLoginDeps, 'platform' | 'configDir'> & { platform?: NodeJS.Platform; host?: () => Pick<HermesHost, 'setupLine'> },
): (e: { sender?: unknown; senderFrame?: unknown }) => Promise<void> {
  return async (e) => {
    if (!isMainWindowSender(e, getWindow())) throw new Error('only the main window may start the Hermes setup');
    const platform = deps.platform ?? process.platform;
    const shell = platform === 'win32' ? deps.windowsShell() : undefined;
    const line = (deps.host ?? getHermesHost)().setupLine(platform, shell);
    if (line === null) throw new Error('wmux could not find Hermes, or cannot type its setup in this shell.');
    let r: Awaited<ReturnType<EngineLoginDeps['openTab']>>;
    try {
      r = await deps.openTab(shell, line);
    } catch {
      r = null;
    }
    if (!(r && typeof r.ptyId === 'string' && r.ptyId)) throw new Error('wmux could not open a terminal for the Hermes setup.');
  };
}

/** FACTORY_MY_HERMES: the owner's own Hermes profiles and, for `{profile}`,
 *  whether it could serve a bot (read-only; myHermes.ts). Main window only. */
export function factoryMyHermesHandler(
  getWindow: () => BrowserWindow | null,
  deps: Parameters<typeof myHermesStatus>[2] & { store?: typeof getBotStore } = {},
): (e: { sender?: unknown; senderFrame?: unknown }, req?: unknown) => Promise<MyHermesStatus> {
  return async (e, req) => {
    if (!isMainWindowSender(e, getWindow())) return { supported: false, profiles: [] };
    return myHermesStatus((deps.store ?? getBotStore)(), req, deps);
  };
}

type EngineChoice = { kind: 'claude-sdk' } | { kind: 'hermes' } | { kind: 'my-hermes'; profile: string };

/** The engine a request picks (`engine`, and `hermesProfile` for My
 *  Hermes), or null when it names none wmux offers. Pure. */
export function engineChoiceOf(engine: unknown, profile: unknown): EngineChoice | null {
  if (engine === 'claude-sdk' || engine === 'hermes') return { kind: engine };
  if (engine === 'my-hermes') return { kind: 'my-hermes', profile: profile === undefined ? MY_HERMES_DEFAULT_PROFILE : (profile as string) };
  return null;
}

export interface MyHermesHandlerDeps extends MyHermesBindDeps {
  /** The native confirm (default: main's own dialog). */
  confirm?: MyHermesConfirm;
}

const defaultGroups = (): ReturnType<NonNullable<MyHermesBindDeps['groups']>> => getGroupStore()?.list() ?? null;

/** FACTORY_BOT_SET_ENGINE: the owner moves a bot to Claude, to wmux's
 *  Hermes, or to My Hermes (the owner's own Hermes profile; asked first in
 *  main's own native confirm). Main window only: the pipe's
 *  bot.create/update cannot move a bot onto or off an ACP engine (bot.rpc.ts
 *  acpEngineRefusal). The bot's next turn starts on the new engine
 *  (BotRuntime.profileChanged). */
export function factoryBotSetEngineHandler(
  getWindow: () => BrowserWindow | null,
  deps: MyHermesHandlerDeps & { store?: typeof getBotStore; runtime?: () => Pick<NonNullable<ReturnType<typeof getBotRuntime>>, 'profileChanged'> | null } = {},
): (e: { sender?: unknown; senderFrame?: unknown }, req: unknown) => Promise<{ ok: boolean; code?: string; message?: string }> {
  return async (e, req) => {
    if (!isMainWindowSender(e, getWindow())) return { ok: false, code: 'operator_only', message: 'only the main window may change a bot\'s engine' };
    const s = (deps.store ?? getBotStore)();
    if (!s) return { ok: false, code: 'not_started', message: 'The factory is not running.' };
    const r = req && typeof req === 'object' && !Array.isArray(req) ? (req as Record<string, unknown>) : {};
    if (typeof r.botId !== 'string' || !BOT_ID_RE.test(r.botId)) return { ok: false, code: 'invalid_argument', message: 'botId must be a bot id' };
    const choice = engineChoiceOf(r.engine, r.hermesProfile);
    if (!choice) return { ok: false, code: 'invalid_argument', message: 'engine must be claude-sdk, hermes or my-hermes' };
    const current = s.get(r.botId);
    if (!current) return { ok: false, code: 'not_found', message: `no bot ${r.botId}` };
    const ownNow = ownHermesProfile(current.engine);
    // Already there: keep the engine as it is (a Claude bot keeps its model).
    if (choice.kind === 'claude-sdk' && current.engine.kind === 'claude-sdk') return { ok: true };
    if (choice.kind === 'hermes' && current.engine.kind === 'acp' && current.engine.preset === 'hermes' && ownNow === null) return { ok: true };
    if (choice.kind === 'my-hermes' && ownNow === choice.profile) return { ok: true };
    let engine: BotProfile['engine'];
    if (choice.kind === 'my-hermes') {
      const groups = { groups: defaultGroups, ...deps };
      const refusal = myHermesBindRefusal(s, r.botId, choice.profile, groups);
      if (refusal) return { ok: false, code: 'invalid_argument', message: refusal };
      const yes = await (deps.confirm ?? confirmMyHermesNatively)(getWindow(), current.name, choice.profile, true);
      if (!yes) return { ok: false, code: 'cancelled', message: 'Kept the bot\'s engine.' };
      // Checked again: the bot or the profile may have changed while asked.
      const again = myHermesBindRefusal(s, r.botId, choice.profile, groups);
      if (again) return { ok: false, code: 'invalid_argument', message: again };
      engine = myHermesEngine(choice.profile);
    } else {
      engine = choice.kind === 'hermes' ? { ...HERMES_BOT_ENGINE } : { kind: 'claude-sdk' };
    }
    const saved = s.update(r.botId, { engine });
    if (!saved.ok) return { ok: false, code: saved.code, message: saved.message };
    (deps.runtime ?? getBotRuntime)()?.profileChanged(r.botId);
    return { ok: true };
  };
}

const NOT_OPERATOR: FactoryBotCreateResult = { ok: false, code: 'operator_only', message: 'only the main window may add a bot' };

/** A bot just added: its first wake greets the owner (wake reason `intro`). */
function greetAddedBot(bot: BotProfile): void {
  const queue = getWakeQueue();
  if (greetNewBot(bot, queue ? (input) => queue.enqueue(input) : null)) getBotRuntime()?.kick();
}

/** FACTORY_BOT_CREATE's body: the sender check, the store's create, then the
 *  new bot's greeting wake. */
export function factoryBotCreateHandler(
  getWindow: () => BrowserWindow | null,
  deps: BotRepoDeps & MyHermesHandlerDeps & { store?: typeof getBotStore; greet?: (bot: BotProfile) => void } = {},
): (e: { sender?: unknown; senderFrame?: unknown }, req: unknown) => Promise<FactoryBotCreateResult> {
  return async (e, req) => {
    if (!isMainWindowSender(e, getWindow())) return NOT_OPERATOR;
    const store = (deps.store ?? getBotStore)();
    const q = req && typeof req === 'object' && !Array.isArray(req) ? (req as Record<string, unknown>) : {};
    // My Hermes: checked, then asked in main's own confirm, before the bot
    // is made (the store refuses a taken profile again on create).
    if (store && q.engine === 'my-hermes') {
      const profile = q.hermesProfile === undefined ? MY_HERMES_DEFAULT_PROFILE : q.hermesProfile;
      const refusal = myHermesBindRefusal(store, null, profile, deps);
      if (refusal) return { ok: false, code: 'invalid_argument', message: refusal };
      const name = typeof q.name === 'string' ? q.name : '';
      if (!(await (deps.confirm ?? confirmMyHermesNatively)(getWindow(), name, profile as string, false))) {
        return { ok: false, code: 'cancelled', message: 'The bot was not added.' };
      }
    }
    const r = await createBotFromFolder(store, req, deps);
    if (r.ok) (deps.greet ?? greetAddedBot)(r.bot);
    return r;
  };
}

/** FACTORY_BOT_CREATE_TEAM's body: the sender check, the team's missing
 *  bots, then the coordinator's greeting only, when it was made here (five
 *  greetings at once would flood the owner). */
export function factoryBotCreateTeamHandler(
  getWindow: () => BrowserWindow | null,
  deps: BotRepoDeps & { store?: typeof getBotStore; greet?: (bot: BotProfile) => void } = {},
): (e: { sender?: unknown; senderFrame?: unknown }, req: unknown) => Promise<FactoryBotCreateTeamResult> {
  return async (e, req) => {
    if (!isMainWindowSender(e, getWindow())) return { ok: false, code: 'operator_only', message: 'only the main window may add bots' };
    const r = await createTeamFromFolder((deps.store ?? getBotStore)(), req, deps);
    const lead = r.ok ? r.bots.find((b) => isCoordinatorBot(b)) : undefined;
    if (lead) (deps.greet ?? greetAddedBot)(lead);
    return r;
  };
}

/** FACTORY_BOT_SUGGEST_REPO's body: the sender check, then the suggestion
 *  from main's own state (the bot store, the workspace mirror's panes and
 *  main's tracked shell cwds, `cwdOf`, which registerHandlers.ts hands in as
 *  metadata.handler's getCwd). The request carries only the workspace id. */
export function factoryBotSuggestRepoHandler(
  getWindow: () => BrowserWindow | null,
  deps: BotRepoSuggestDeps & { store?: typeof getBotStore } = {},
): (e: { sender?: unknown; senderFrame?: unknown }, req: unknown) => Promise<FactoryBotRepoSuggestion> {
  return async (e, req) => {
    if (!isMainWindowSender(e, getWindow())) return { ok: false, code: 'operator_only' };
    return suggestBotRepo((deps.store ?? getBotStore)(), workspaceOf(req), {
      entries: () => getWorkspaceMirror().getEntries(),
      ...deps,
    });
  };
}

/** The picker over Electron: the open dialog on the main window, the file's
 *  size, `nativeImage` as the decoder. An isolated instance
 *  (WMUX_DATA_SUFFIX) started with WMUX_TEST_AVATAR_FILE takes that file
 *  instead of asking, so a live check can drive the picker. */
export function electronAvatarPickerDeps(getWindow: () => BrowserWindow | null): BotAvatarPickerDeps {
  return {
    chooseFile: async () => {
      const testFile = process.env.WMUX_DATA_SUFFIX ? process.env.WMUX_TEST_AVATAR_FILE : undefined;
      if (testFile) return [testFile];
      const opts: OpenDialogOptions = {
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: [...BOT_AVATAR_EXTENSIONS] }],
      };
      const win = getWindow();
      const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return r.canceled ? null : r.filePaths;
    },
    fileSize: (filePath) => fs.statSync(filePath).size,
    loadImage: (filePath) => nativeImage.createFromPath(filePath),
  };
}

/** FACTORY_BOT_PICK_AVATAR's body: the sender check, then the picker. The
 *  answer is a preview; nothing is saved. */
export function factoryBotPickAvatarHandler(
  getWindow: () => BrowserWindow | null,
  deps?: BotAvatarPickerDeps,
): (e: { sender?: unknown; senderFrame?: unknown }) => Promise<FactoryBotAvatarPickResult> {
  return async (e) => {
    if (!isMainWindowSender(e, getWindow())) return { ok: false, code: 'operator_only' };
    return pickBotAvatar(deps ?? electronAvatarPickerDeps(getWindow));
  };
}

/** FACTORY_BOT_SET_AVATAR's body: the sender check, then the store, which
 *  checks the picture again (null clears it). */
export function factoryBotSetAvatarHandler(
  getWindow: () => BrowserWindow | null,
  store: typeof getBotStore = getBotStore,
): (e: { sender?: unknown; senderFrame?: unknown }, req: unknown) => Promise<FactoryBotAvatarSetResult> {
  return async (e, req) => {
    if (!isMainWindowSender(e, getWindow())) return { ok: false, code: 'operator_only', message: 'only the main window may change a bot\'s picture' };
    const s = store();
    if (!s) return { ok: false, code: 'not_started', message: 'The factory is not running.' };
    const r = req && typeof req === 'object' && !Array.isArray(req) ? (req as Record<string, unknown>) : {};
    if (typeof r.botId !== 'string' || !BOT_ID_RE.test(r.botId)) return { ok: false, code: 'invalid_argument', message: 'botId must be a bot id' };
    if (r.avatar !== null && typeof r.avatar !== 'string') return { ok: false, code: 'invalid_argument', message: 'avatar must be a picture or null' };
    const saved = s.setAvatar(r.botId, r.avatar);
    if (saved.ok) return { ok: true, bot: saved.bot };
    return { ok: false, code: saved.code === 'not_found' ? 'not_found' : 'invalid_argument', message: saved.message };
  };
}

/** FACTORY_BOT_CLEAR_REMOVED's body: the sender check, then the deleted
 *  bot's 1:1 leaves the Archive (botStore.ts clearRemoved). */
export function factoryBotClearRemovedHandler(
  getWindow: () => BrowserWindow | null,
  store: typeof getBotStore = getBotStore,
): (e: { sender?: unknown; senderFrame?: unknown }, req: unknown) => FactoryBotClearRemovedResult {
  return (e, req) => {
    if (!isMainWindowSender(e, getWindow())) return { ok: false, code: 'operator_only', message: 'only the main window may change the Archive' };
    const s = store();
    if (!s) return { ok: false, code: 'not_started', message: 'The factory is not running.' };
    const r = req && typeof req === 'object' && !Array.isArray(req) ? (req as Record<string, unknown>) : {};
    if (typeof r.botId !== 'string' || !BOT_ID_RE.test(r.botId)) return { ok: false, code: 'invalid_argument', message: 'botId must be a bot id' };
    return s.clearRemoved(r.botId) ? { ok: true } : { ok: false, code: 'not_found', message: `no deleted bot ${r.botId}` };
  };
}

/** What switching "Run bots" off stopped (FACTORY_SETTINGS_SET's answer,
 *  present when it stopped something or could not stop everything). */
export interface FactoryOffStopped {
  /** Workers whose processes were confirmed gone. */
  workers: number;
  /** Open bot tasks cancelled ("stopped by owner"). */
  tasks: number;
  ok: boolean;
  /** Why the stop was partial, in main's words (a pane left running). */
  message?: string;
}

/** FACTORY_SETTINGS_SET's body: the sender check, then the settings store.
 *  null = not written. Switching "Run bots" off stops the bots' running
 *  work (factoryStop.ts, `off`): the switch is written first, so nothing new
 *  launches, then the same stop as Stop all runs. */
export function factorySettingsSetHandler(
  getWindow: () => BrowserWindow | null,
  store: typeof getFactorySettingsStore = getFactorySettingsStore,
  stopPorts: () => FactoryStopPorts | null = getFactoryStopPorts,
): (e: { sender?: unknown; senderFrame?: unknown }, patch: unknown) => Promise<(FactorySettings & { stoppedWork?: FactoryOffStopped }) | null> {
  return async (e, patch) => {
    if (!isMainWindowSender(e, getWindow())) return null;
    const s = store();
    if (!s) return null;
    const wasOn = s.get().enabled;
    // The store applies a patch before its write lands, so the switch is
    // live once update() is called. The stop starts in the same tick and
    // reads what it stops right away: a switch-on that lands while it runs
    // (or while the write is pending) keeps the work started after it.
    const writing = s.update(patch);
    const switchingOff = wasOn && !s.get().enabled;
    getBotRuntime()?.kick();
    const ports = switchingOff ? stopPorts() : null;
    const stopping = ports ? stopFactoryWork(ports, { off: true }) : null;
    let next: FactorySettings | null = null;
    let failure: unknown = null;
    try {
      next = await writing;
    } catch (err) {
      // A write that failed after switching off still stops the work.
      failure = err;
    }
    let stoppedWork: FactoryOffStopped | undefined;
    if (stopping) {
      const r = await stopping;
      if (r.workersStopped > 0 || r.tasksCancelled > 0 || !r.ok) stoppedWork = { workers: r.workersStopped, tasks: r.tasksCancelled, ok: r.ok, ...(!r.ok && r.message ? { message: r.message } : {}) };
    }
    if (!next) throw failure;
    return stoppedWork ? { ...next, stoppedWork } : next;
  };
}

/** The bots' Claude API key handlers (claudeApiKey.ts): main window only,
 *  and none throws, so the key never reaches the IPC error log. What comes
 *  back is the key's status, never the key. */
export function factoryClaudeAuthHandlers(
  getWindow: () => BrowserWindow | null,
  store: () => ClaudeApiKeyStore = getClaudeApiKeyStore,
  check: (key: string | null) => Promise<ClaudeApiKeyCheck> = (key) => checkClaudeApiKey(key),
) {
  const denied = { ok: false as const, code: 'operator_only' as const, message: 'only the main window may do this' };
  const failed = { ok: false as const, code: 'error' as const, message: 'The request failed.' };
  type E = { sender?: unknown; senderFrame?: unknown };
  return {
    status: (e: E): ClaudeApiKeyStatus | null => {
      if (!isMainWindowSender(e, getWindow())) return null;
      try { return store().status(); } catch { return null; }
    },
    setKey: (e: E, req: unknown): ClaudeApiKeySetResult | typeof denied | typeof failed => {
      if (!isMainWindowSender(e, getWindow())) return denied;
      try {
        const key = req && typeof req === 'object' ? (req as { key?: unknown }).key : undefined;
        return store().set(key);
      } catch {
        return failed;
      }
    },
    removeKey: (e: E): { ok: boolean; status?: ClaudeApiKeyStatus } => {
      if (!isMainWindowSender(e, getWindow())) return { ok: false };
      try {
        const s = store();
        return s.remove() ? { ok: true, status: s.status() } : { ok: false };
      } catch {
        return { ok: false };
      }
    },
    check: async (e: E): Promise<ClaudeApiKeyCheck | typeof denied> => {
      if (!isMainWindowSender(e, getWindow())) return denied;
      let key: string | null = null;
      try { key = store().key(); } catch { key = null; }
      return check(key);
    },
  };
}

export function registerFactoryHandlers(
  getWindow: () => BrowserWindow | null,
  suggestDeps: Pick<BotRepoSuggestDeps, 'cwdOf' | 'daemonRpc'> = {},
): () => void {
  const channels = [
    IPC.FACTORY_BOT_LIST,
    IPC.FACTORY_BOT_STATUS,
    IPC.FACTORY_SETTINGS_GET,
    IPC.FACTORY_SETTINGS_SET,
    IPC.FACTORY_BOT_CREATE,
    IPC.FACTORY_BOT_CREATE_TEAM,
    IPC.FACTORY_BOT_PICK_AVATAR,
    IPC.FACTORY_BOT_SET_AVATAR,
    IPC.FACTORY_BOT_SUGGEST_REPO,
    IPC.FACTORY_BOT_CLEAR_REMOVED,
    IPC.FACTORY_STOP_ALL,
    IPC.FACTORY_STOP_BOT,
    IPC.FACTORY_BOT_NEW_CONVERSATION,
    IPC.FACTORY_STOP_TASK,
    IPC.FACTORY_WORKER_RESUME,
    IPC.FACTORY_TASK_APPLY,
    IPC.FACTORY_ENGINE_READINESS,
    IPC.FACTORY_ENGINE_LOGIN,
    IPC.FACTORY_HERMES_READINESS,
    IPC.FACTORY_HERMES_SETUP,
    IPC.FACTORY_BOT_SET_ENGINE,
    IPC.FACTORY_MY_HERMES,
    IPC.FACTORY_WORKER_AGENTS,
    IPC.FACTORY_TASK_FOLDERS_USAGE,
    IPC.FACTORY_TASK_FOLDERS_CLEAN,
    IPC.FACTORY_CLAUDE_AUTH_STATUS,
    IPC.FACTORY_CLAUDE_KEY_SET,
    IPC.FACTORY_CLAUDE_KEY_REMOVE,
    IPC.FACTORY_CLAUDE_KEY_CHECK,
  ];
  for (const c of channels) ipcMain.removeHandler(c);

  ipcMain.handle(
    IPC.FACTORY_BOT_LIST,
    wrapHandler(IPC.FACTORY_BOT_LIST, async (_e: Electron.IpcMainInvokeEvent, req: unknown): Promise<{ bots: FactoryBotRow[] }> => ({
      bots: await factoryBotRowsWithTasks(workspaceOf(req)),
    })),
  );

  ipcMain.handle(
    IPC.FACTORY_BOT_STATUS,
    wrapHandler(IPC.FACTORY_BOT_STATUS, (_e: Electron.IpcMainInvokeEvent, req: unknown): { status: BotStatus | null } => {
      const botId = req && typeof req === 'object' ? (req as { botId?: unknown }).botId : undefined;
      return { status: typeof botId === 'string' ? getBotRuntime()?.status(botId) ?? null : null };
    }),
  );

  ipcMain.handle(
    IPC.FACTORY_SETTINGS_GET,
    wrapHandler(IPC.FACTORY_SETTINGS_GET, (): FactorySettings => getFactorySettings()),
  );

  ipcMain.handle(IPC.FACTORY_SETTINGS_SET, wrapHandler(IPC.FACTORY_SETTINGS_SET, factorySettingsSetHandler(getWindow)));

  ipcMain.handle(IPC.FACTORY_BOT_CREATE, wrapHandler(IPC.FACTORY_BOT_CREATE, factoryBotCreateHandler(getWindow)));

  ipcMain.handle(IPC.FACTORY_BOT_CREATE_TEAM, wrapHandler(IPC.FACTORY_BOT_CREATE_TEAM, factoryBotCreateTeamHandler(getWindow)));

  ipcMain.handle(IPC.FACTORY_BOT_PICK_AVATAR, wrapHandler(IPC.FACTORY_BOT_PICK_AVATAR, factoryBotPickAvatarHandler(getWindow)));

  ipcMain.handle(IPC.FACTORY_BOT_SET_AVATAR, wrapHandler(IPC.FACTORY_BOT_SET_AVATAR, factoryBotSetAvatarHandler(getWindow)));

  ipcMain.handle(IPC.FACTORY_BOT_SUGGEST_REPO, wrapHandler(IPC.FACTORY_BOT_SUGGEST_REPO, factoryBotSuggestRepoHandler(getWindow, suggestDeps)));

  ipcMain.handle(IPC.FACTORY_BOT_CLEAR_REMOVED, wrapHandler(IPC.FACTORY_BOT_CLEAR_REMOVED, factoryBotClearRemovedHandler(getWindow)));

  ipcMain.handle(IPC.FACTORY_STOP_ALL, wrapHandler(IPC.FACTORY_STOP_ALL, factoryStopHandler(getWindow, 'all')));

  ipcMain.handle(IPC.FACTORY_STOP_BOT, wrapHandler(IPC.FACTORY_STOP_BOT, factoryStopHandler(getWindow, 'bot')));

  ipcMain.handle(IPC.FACTORY_BOT_NEW_CONVERSATION, wrapHandler(IPC.FACTORY_BOT_NEW_CONVERSATION, factoryBotNewConversationHandler(getWindow)));

  ipcMain.handle(IPC.FACTORY_STOP_TASK, wrapHandler(IPC.FACTORY_STOP_TASK, factoryStopHandler(getWindow, 'task')));

  ipcMain.handle(IPC.FACTORY_WORKER_RESUME, wrapHandler(IPC.FACTORY_WORKER_RESUME, factoryWorkerResumeHandler(getWindow)));

  ipcMain.handle(IPC.FACTORY_TASK_APPLY, wrapHandler(IPC.FACTORY_TASK_APPLY, factoryTaskApplyHandler(getWindow)));

  ipcMain.handle(IPC.FACTORY_ENGINE_READINESS, wrapHandler(IPC.FACTORY_ENGINE_READINESS, factoryEngineReadinessHandler(getWindow)));

  ipcMain.handle(IPC.FACTORY_ENGINE_LOGIN, wrapHandler(IPC.FACTORY_ENGINE_LOGIN, factoryEngineLoginHandler(getWindow, defaultEngineLoginDeps(getWindow))));

  ipcMain.handle(IPC.FACTORY_HERMES_READINESS, wrapHandler(IPC.FACTORY_HERMES_READINESS, factoryHermesReadinessHandler(getWindow)));

  ipcMain.handle(IPC.FACTORY_HERMES_SETUP, wrapHandler(IPC.FACTORY_HERMES_SETUP, factoryHermesSetupHandler(getWindow, defaultEngineLoginDeps(getWindow))));

  ipcMain.handle(IPC.FACTORY_BOT_SET_ENGINE, wrapHandler(IPC.FACTORY_BOT_SET_ENGINE, factoryBotSetEngineHandler(getWindow)));

  ipcMain.handle(IPC.FACTORY_MY_HERMES, wrapHandler(IPC.FACTORY_MY_HERMES, factoryMyHermesHandler(getWindow)));

  ipcMain.handle(IPC.FACTORY_WORKER_AGENTS, wrapHandler(IPC.FACTORY_WORKER_AGENTS, factoryWorkerAgentsHandler(getWindow)));

  ipcMain.handle(IPC.FACTORY_TASK_FOLDERS_USAGE, wrapHandler(IPC.FACTORY_TASK_FOLDERS_USAGE, factoryTaskFoldersUsageHandler(getWindow)));

  ipcMain.handle(IPC.FACTORY_TASK_FOLDERS_CLEAN, wrapHandler(IPC.FACTORY_TASK_FOLDERS_CLEAN, factoryTaskFoldersCleanHandler(getWindow)));

  // These never throw, so wrapHandler's error log (which masks a `key` field
  // anyway) never sees the key.
  const claudeAuth = factoryClaudeAuthHandlers(getWindow);
  ipcMain.handle(IPC.FACTORY_CLAUDE_AUTH_STATUS, wrapHandler(IPC.FACTORY_CLAUDE_AUTH_STATUS, (e: Electron.IpcMainInvokeEvent) => claudeAuth.status(e)));
  ipcMain.handle(IPC.FACTORY_CLAUDE_KEY_SET, wrapHandler(IPC.FACTORY_CLAUDE_KEY_SET, (e: Electron.IpcMainInvokeEvent, req: unknown) => claudeAuth.setKey(e, req)));
  ipcMain.handle(IPC.FACTORY_CLAUDE_KEY_REMOVE, wrapHandler(IPC.FACTORY_CLAUDE_KEY_REMOVE, (e: Electron.IpcMainInvokeEvent) => claudeAuth.removeKey(e)));
  ipcMain.handle(IPC.FACTORY_CLAUDE_KEY_CHECK, wrapHandler(IPC.FACTORY_CLAUDE_KEY_CHECK, (e: Electron.IpcMainInvokeEvent) => claudeAuth.check(e)));

  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}
