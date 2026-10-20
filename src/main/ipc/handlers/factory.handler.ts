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
// stopped worker (FACTORY_WORKER_RESUME: factory/workerReclaim.ts).
// A bot row carries the bot's tasks with their stage (factory/botTasks.ts).
import fs from 'node:fs';
import { dialog, ipcMain, nativeImage, type BrowserWindow, type OpenDialogOptions } from 'electron';
import { IPC } from '../../../shared/constants';
import { BOT_ID_RE, type BotProfile, type BotStatus } from '../../../shared/bot';
import { wrapHandler } from '../wrapHandler';
import { getBotStore } from '../../factory/botStore';
import { getBotRuntime } from '../../factory/BotRuntime';
import { getFactorySettings, getFactorySettingsStore, type FactorySettings } from '../../factory/factorySettings';
import { createBotFromFolder, createTeamFromFolder, greetNewBot, suggestBotRepo, type BotRepoDeps, type BotRepoSuggestDeps } from '../../factory/botCreate';
import { getWakeQueue } from '../../factory/wakeQueue';
import type {
  FactoryBotAvatarPickResult,
  FactoryBotAvatarSetResult,
  FactoryBotCreateResult,
  FactoryBotCreateTeamResult,
  FactoryBotRepoSuggestion,
} from '../../../shared/botCreate';
import { getWorkspaceMirror } from '../../workspace/WorkspaceMirror';
import { BOT_AVATAR_EXTENSIONS, pickBotAvatar, type BotAvatarPickerDeps } from '../../factory/botAvatar';
import { isMainWindowSender } from '../mainWindowSender';
import type { BotTaskView, FactoryTaskFolderCleanResult, FactoryTaskFolderUsage } from '../../../shared/botTask';
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
  deps: BotRepoDeps & { store?: typeof getBotStore; greet?: (bot: BotProfile) => void } = {},
): (e: { sender?: unknown; senderFrame?: unknown }, req: unknown) => Promise<FactoryBotCreateResult> {
  return async (e, req) => {
    if (!isMainWindowSender(e, getWindow())) return NOT_OPERATOR;
    const r = await createBotFromFolder((deps.store ?? getBotStore)(), req, deps);
    if (r.ok) (deps.greet ?? greetAddedBot)(r.bot);
    return r;
  };
}

/** FACTORY_BOT_CREATE_TEAM's body: the sender check, the five bots, then
 *  the coordinator's greeting only (five greetings at once would flood the
 *  owner). */
export function factoryBotCreateTeamHandler(
  getWindow: () => BrowserWindow | null,
  deps: BotRepoDeps & { store?: typeof getBotStore; greet?: (bot: BotProfile) => void } = {},
): (e: { sender?: unknown; senderFrame?: unknown }, req: unknown) => Promise<FactoryBotCreateTeamResult> {
  return async (e, req) => {
    if (!isMainWindowSender(e, getWindow())) return { ok: false, code: 'operator_only', message: 'only the main window may add bots' };
    const r = await createTeamFromFolder((deps.store ?? getBotStore)(), req, deps);
    if (r.ok) (deps.greet ?? greetAddedBot)(r.bots[0]);
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
  suggestDeps: Pick<BotRepoSuggestDeps, 'cwdOf'> = {},
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
    IPC.FACTORY_STOP_ALL,
    IPC.FACTORY_STOP_BOT,
    IPC.FACTORY_STOP_TASK,
    IPC.FACTORY_WORKER_RESUME,
    IPC.FACTORY_ENGINE_READINESS,
    IPC.FACTORY_ENGINE_LOGIN,
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

  ipcMain.handle(IPC.FACTORY_STOP_ALL, wrapHandler(IPC.FACTORY_STOP_ALL, factoryStopHandler(getWindow, 'all')));

  ipcMain.handle(IPC.FACTORY_STOP_BOT, wrapHandler(IPC.FACTORY_STOP_BOT, factoryStopHandler(getWindow, 'bot')));

  ipcMain.handle(IPC.FACTORY_STOP_TASK, wrapHandler(IPC.FACTORY_STOP_TASK, factoryStopHandler(getWindow, 'task')));

  ipcMain.handle(IPC.FACTORY_WORKER_RESUME, wrapHandler(IPC.FACTORY_WORKER_RESUME, factoryWorkerResumeHandler(getWindow)));

  ipcMain.handle(IPC.FACTORY_ENGINE_READINESS, wrapHandler(IPC.FACTORY_ENGINE_READINESS, factoryEngineReadinessHandler(getWindow)));

  ipcMain.handle(IPC.FACTORY_ENGINE_LOGIN, wrapHandler(IPC.FACTORY_ENGINE_LOGIN, factoryEngineLoginHandler(getWindow, defaultEngineLoginDeps(getWindow))));

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
