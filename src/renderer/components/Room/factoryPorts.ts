// ─── Factory ports for the room dock and the Factory settings tab ──────────
//
// The room dock reads rooms through `window.electronAPI.rooms` (always in
// this build). Bots and the factory settings belong to the bot runtime,
// whose renderer bridge is wired separately; the dock and the settings tab
// reach them only through the two ports below, so they render correctly
// with no runtime at all (no chips, a "not installed" settings tab).
//
// Default wiring: each port uses `window.electronAPI.factory` when the
// preload exposes it with this shape, and is unavailable otherwise —
//
//   factory: {
//     listBots(req?: { workspaceId?: string }): Promise<{ bots: FactoryBotRow[] }>
//         // IPC.FACTORY_BOT_LIST (main/ipc/handlers/factory.handler.ts)
//     onBotEvent(cb: () => void): () => void
//         // BOT_EVENT (shared/bot.ts) pushes; payload not read, the list is re-read
//     botAction(action: BotAction, botId: string): Promise<{ ok: boolean; message?: string }>
//         // bot.wake | bot.park | bot.resume | bot.interrupt (shared/bot.ts BOT_RPC), as the operator
//     updateBot(botId: string, patch: BotProfilePatch): Promise<{ ok: boolean; message?: string; code?: string }>
//         // bot.update, as the operator (optional: without it the profile rows are read-only)
//     removeBot(botId: string, hue?: number): Promise<{ ok: boolean; message?: string; code?: string }>
//         // bot.remove, as the operator (optional: without it the profile has no Delete bot)
//     createBot(req: FactoryBotCreateRequest): Promise<FactoryBotCreateResult>
//         // IPC.FACTORY_BOT_CREATE (optional: without it Settings › Factory cannot add a bot)
//     createBotTeam(req: FactoryBotCreateTeamRequest): Promise<FactoryBotCreateTeamResult>
//         // IPC.FACTORY_BOT_CREATE_TEAM (optional: without it "Add team" is not offered)
//     pickBotAvatar(): Promise<FactoryBotAvatarPickResult>
//         // IPC.FACTORY_BOT_PICK_AVATAR: main's image dialog → a preview (optional)
//     setBotAvatar(botId: string, avatar: string | null): Promise<FactoryBotAvatarSetResult>
//         // IPC.FACTORY_BOT_SET_AVATAR: save or clear a bot's picture (optional)
//     suggestBotRepo(workspaceId: string): Promise<FactoryBotRepoSuggestion>
//         // IPC.FACTORY_BOT_SUGGEST_REPO: the repository "Add bot" offers (optional)
//     getSettings(): Promise<FactorySettingsView>
//         // IPC.FACTORY_SETTINGS_GET
//     setSettings(patch: Partial<FactorySettingsView>): Promise<FactorySettingsView | null>
//         // IPC.FACTORY_SETTINGS_SET (null: the runtime has not started)
//     stopAll(): Promise<FactoryStopResult>
//         // IPC.FACTORY_STOP_ALL: interrupt every bot turn, cancel running
//         // gates, stop every bot worker (optional: without it there is no stop)
//     stopBot(botId: string): Promise<FactoryStopResult>
//         // IPC.FACTORY_STOP_BOT: the same for one bot (optional)
//     stopTask(taskId: string): Promise<FactoryStopResult>
//         // IPC.FACTORY_STOP_TASK: one bot task's worker, its task
//         // cancelled (optional)
//   }
//
// `setFactoryBotPort` / `setFactorySettingsPort` replace a port outright
// (tests, or a host that wires it another way).

import type { BotEngine, BotProfile, BotStatus, BotWorkerAgent } from '../../../shared/bot';
import type { BotWorkerAgentOption } from '../../../shared/botWorkerAgent';
import type { BotTaskView, FactoryTaskFolderCleanResult, FactoryTaskFolderUsage } from '../../../shared/botTask';
import type { BotsPlanConsent } from '../../../shared/factorySettings';
import type {
  FactoryBotAvatarPickResult,
  FactoryBotAvatarSetResult,
  FactoryBotCreateRequest,
  FactoryBotCreateTeamRequest,
  FactoryBotCreateTeamResult,
  FactoryBotCreateResult,
  FactoryBotRepoSuggestion,
} from '../../../shared/botCreate';

/** One bot as the runtime reports it; `status` null = not reported yet. */
export interface FactoryBotRow {
  bot: BotProfile;
  status: BotStatus | null;
  /** The bot's tasks, newest first, with their stage (coded / checked /
   *  waiting to merge …, shared/botTask.ts); absent when there are none. */
  tasks?: BotTaskView[];
}

/** What a stop changed (main/factory/factoryStop.ts). `ok:false` with
 *  `code`: operator_only | invalid_argument | not_started (| not_found
 *  for one task). */
export interface FactoryStopResult {
  ok: boolean;
  botsInterrupted: number;
  workersStopped: number;
  gatesCancelled: number;
  /** Open bot tasks moved to `cancelled`. */
  tasksCancelled?: number;
  code?: string;
  message?: string;
}

export type BotAction = 'wake' | 'park' | 'resume' | 'interrupt';

/** What the Factory tab's profile editor changes. */
/** bot.update's patch as the renderer sends it: `job: null` clears the job,
 *  `budget.maxTurnsPerHour: null` removes the hourly cap. */
export type BotProfilePatch = Partial<Pick<BotProfile, 'name' | 'enabled' | 'template'>> & {
  job?: string | null;
  /** What the bot's workers run on; null puts them back on the default. */
  workerAgent?: BotWorkerAgent | null;
  /** The bot's own engine: its model and effort (claude-sdk). */
  engine?: BotEngine;
  /** A picked folder: main makes it the bot's repository as Add bot does. */
  repoFolder?: string;
  budget?: Partial<Omit<BotProfile['budget'], 'maxTurnsPerHour'>> & { maxTurnsPerHour?: number | null };
};

export interface FactoryBotPort {
  /** False: no bot runtime in this build (the chips render nothing). */
  readonly available: boolean;
  /** Every bot, or one workspace's. */
  list(workspaceId?: string): Promise<FactoryBotRow[]>;
  /** Told on any bot change; returns the unsubscribe. */
  subscribe(onChange: () => void): () => void;
  /** A refusal carries the handler's code (repo_mismatch, no_remote…). */
  act(action: BotAction, botId: string): Promise<{ ok: boolean; message?: string; code?: string }>;
  /** Absent: profiles are read-only here. */
  update?(botId: string, patch: BotProfilePatch): Promise<{ ok: boolean; message?: string; code?: string }>;
  /** Absent: no bot can be removed here. Stops its work, removes its
   *  routines, keeps its history (`hue`: its colour slot, for its cards). */
  remove?(botId: string, hue?: number): Promise<{ ok: boolean; message?: string; code?: string }>;
  /** Absent: no bot can be added here. */
  create?(req: FactoryBotCreateRequest): Promise<FactoryBotCreateResult>;
  /** Absent: no team can be added here. */
  createTeam?(req: FactoryBotCreateTeamRequest): Promise<FactoryBotCreateTeamResult>;
  /** Absent: no picture can be chosen here. The answer is a preview. */
  pickAvatar?(): Promise<FactoryBotAvatarPickResult>;
  /** Absent: pictures are read-only here. null clears the picture. */
  setAvatar?(botId: string, avatar: string | null): Promise<FactoryBotAvatarSetResult>;
  /** Absent: "Add bot" suggests no repository (the owner picks a folder). */
  suggestRepo?(workspaceId: string): Promise<FactoryBotRepoSuggestion>;
  /** Absent: no stop here. Interrupts every bot turn, cancels running gates
   *  and stops every bot worker. */
  stopAll?(): Promise<FactoryStopResult>;
  /** Absent: no stop here. The same for one bot's turn and workers. */
  stopBot?(botId: string): Promise<FactoryStopResult>;
  /** Absent: no Stop worker here. One bot task's worker: its task cancelled
   *  ("stopped by owner"), its gate and processes stopped. */
  stopTask?(taskId: string): Promise<FactoryStopResult>;
  /** Absent: no resume here. Relaunch the stopped worker of an ended task
   *  with the same conversation (main/factory/workerReclaim.ts). */
  resumeWorker?(taskId: string): Promise<{ ok: boolean; message?: string; workspaceId?: string; code?: string; cap?: number }>;
  /** Absent: no engine choice here. The engines a bot's workers may run on,
   *  and which are installed. */
  workerAgents?(): Promise<BotWorkerAgentOption[]>;
}

/** The factory settings the tab shows (main/factory/factorySettings.ts). */
export interface FactorySettingsView {
  version: 1;
  enabled: boolean;
  hqWorkspaceId: string | null;
  trustedAuthors: string[];
  morning: { hour: number; weekdays: number[] };
  verifierOnOwnerPrs: boolean;
  defaultEngine: BotEngine;
  globalConcurrentBots: number;
  /** Agents (bots in a turn and live workers) running at once; a bot's new
   *  worker past it waits for a slot. */
  maxConcurrentAgents?: number;
  /** The merge lane merges a bot PR by itself (shared/factorySettings.ts). */
  laneAutoMerge: boolean;
  /** Most lane merges per local day. */
  laneDailyCap: number;
  /** The bot the phone talks to (absent: automatic); null in a patch clears it. */
  phoneBotId?: string | null;
  /** The owner's consent that bots run on their own Claude plan
   *  (Bots/BotsPlanConsent.tsx); turning bots on needs it. */
  planConsent?: BotsPlanConsent;
}

export interface FactorySettingsPort {
  /** False: no factory settings in this build (the tab says so). */
  readonly available: boolean;
  get(): Promise<FactorySettingsView | null>;
  set(patch: Partial<FactorySettingsView>): Promise<FactorySettingsView | null>;
  /** Absent: no task folder line. The space bot task folders use (null:
   *  the factory is not running). */
  taskFolderUsage?(): Promise<FactoryTaskFolderUsage | null>;
  /** Absent: no Clean up now. The task-end rules over every ended bot task. */
  cleanTaskFolders?(): Promise<FactoryTaskFolderCleanResult>;
}

interface FactoryBridge {
  listBots?: (req?: { workspaceId?: string }) => Promise<{ bots: FactoryBotRow[] }>;
  onBotEvent?: (cb: () => void) => () => void;
  botAction?: (action: BotAction, botId: string) => Promise<{ ok: boolean; message?: string; code?: string }>;
  updateBot?: (botId: string, patch: BotProfilePatch) => Promise<{ ok: boolean; message?: string; code?: string }>;
  removeBot?: (botId: string, hue?: number) => Promise<{ ok: boolean; message?: string; code?: string }>;
  createBot?: (req: FactoryBotCreateRequest) => Promise<FactoryBotCreateResult>;
  createBotTeam?: (req: FactoryBotCreateTeamRequest) => Promise<FactoryBotCreateTeamResult>;
  pickBotAvatar?: () => Promise<FactoryBotAvatarPickResult>;
  setBotAvatar?: (botId: string, avatar: string | null) => Promise<FactoryBotAvatarSetResult>;
  suggestBotRepo?: (workspaceId: string) => Promise<FactoryBotRepoSuggestion>;
  getSettings?: () => Promise<FactorySettingsView>;
  setSettings?: (patch: Partial<FactorySettingsView>) => Promise<FactorySettingsView | null>;
  stopAll?: () => Promise<FactoryStopResult>;
  stopBot?: (botId: string) => Promise<FactoryStopResult>;
  stopTask?: (taskId: string) => Promise<FactoryStopResult>;
  resumeWorker?: (taskId: string) => Promise<{ ok: boolean; message?: string; workspaceId?: string; code?: string; cap?: number }>;
  workerAgents?: () => Promise<BotWorkerAgentOption[]>;
  taskFolderUsage?: () => Promise<FactoryTaskFolderUsage | null>;
  cleanTaskFolders?: () => Promise<FactoryTaskFolderCleanResult>;
}

function bridge(): FactoryBridge | null {
  const api = (globalThis as { electronAPI?: { factory?: unknown } }).electronAPI;
  const f = api?.factory;
  return f && typeof f === 'object' ? (f as FactoryBridge) : null;
}

const NO_BOTS: FactoryBotPort = {
  available: false,
  list: async () => [],
  subscribe: () => () => undefined,
  act: async () => ({ ok: false, message: 'no bot runtime' }),
};

const NO_SETTINGS: FactorySettingsPort = {
  available: false,
  get: async () => null,
  set: async () => null,
};

/** The preload bridge as a bot port, or the empty port. */
export function bridgeBotPort(): FactoryBotPort {
  const b = bridge();
  if (!b?.listBots) return NO_BOTS;
  const listBots = b.listBots;
  return {
    available: true,
    list: async (workspaceId) => (await listBots(workspaceId ? { workspaceId } : {})).bots ?? [],
    subscribe: (fn) => b.onBotEvent?.(fn) ?? (() => undefined),
    act: (action, botId) => b.botAction?.(action, botId) ?? Promise.resolve({ ok: false, message: 'no bot runtime' }),
    ...(b.updateBot ? { update: b.updateBot } : {}),
    ...(b.removeBot ? { remove: b.removeBot } : {}),
    ...(b.createBot ? { create: b.createBot } : {}),
    ...(b.createBotTeam ? { createTeam: b.createBotTeam } : {}),
    ...(b.pickBotAvatar ? { pickAvatar: b.pickBotAvatar } : {}),
    ...(b.setBotAvatar ? { setAvatar: b.setBotAvatar } : {}),
    ...(b.suggestBotRepo ? { suggestRepo: b.suggestBotRepo } : {}),
    ...(b.stopAll ? { stopAll: b.stopAll } : {}),
    ...(b.stopBot ? { stopBot: b.stopBot } : {}),
    ...(b.stopTask ? { stopTask: b.stopTask } : {}),
    ...(b.resumeWorker ? { resumeWorker: b.resumeWorker } : {}),
    ...(b.workerAgents ? { workerAgents: b.workerAgents } : {}),
  };
}

/** The preload bridge as a settings port, or the unavailable port. */
export function bridgeSettingsPort(): FactorySettingsPort {
  const b = bridge();
  if (!b?.getSettings || !b.setSettings) return NO_SETTINGS;
  const { getSettings, setSettings } = b;
  return {
    available: true,
    get: () => getSettings(),
    set: (patch) => setSettings(patch),
    ...(b.taskFolderUsage ? { taskFolderUsage: b.taskFolderUsage } : {}),
    ...(b.cleanTaskFolders ? { cleanTaskFolders: b.cleanTaskFolders } : {}),
  };
}

let botPort: FactoryBotPort | null = null;
let settingsPort: FactorySettingsPort | null = null;

export function getFactoryBotPort(): FactoryBotPort {
  botPort ??= bridgeBotPort();
  return botPort;
}

export function setFactoryBotPort(port: FactoryBotPort | null): void {
  botPort = port;
}

export function getFactorySettingsPort(): FactorySettingsPort {
  settingsPort ??= bridgeSettingsPort();
  return settingsPort;
}

export function setFactorySettingsPort(port: FactorySettingsPort | null): void {
  settingsPort = port;
}
