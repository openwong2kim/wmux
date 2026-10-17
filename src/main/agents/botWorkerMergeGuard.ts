// ─── A bot's fan-out worker merges only through the merge lane ──────────────
//
// The agent factory's merge lane (moaMergeLane.ts) is the one merger of a
// bot's pull requests: its predicates read fresh facts and it runs no model.
// A fan-out worker a bot started therefore launches with its OWN `--settings`
// file, never the owner's user settings, whose `permissions.deny` refuses
// `gh pr merge` and the `gh api` merge endpoints, force pushes and pushes to
// a default branch, and public `gh` acts (shared/botWorkerGuard.ts
// BOT_WORKER_DENY) — at the fan-out launch, on a
// resume typed into its pane, and on a re-fire, across app restarts. Workers a
// person started (a pane, the GUI, an orchestrator) launch exactly as before.
//
// A codex worker is launched as the fan-out's own first launch, on the line
// its own guard rebuilt (codexWorkerGuard.ts), which records where; a re-fire
// or a typed resume in that pane goes through the codex guard again from the
// record. The sync stages here refuse every codex line (a later pane, the
// factory's worker resume).
//
// Fail-closed: a bot worker's launch line that cannot carry the file (it could
// not be written, the path cannot be quoted, the launcher is not claude or a
// guarded codex, the line is more than one plain command or holds a
// substitution, or it already names another settings file) is not run. pty:create throws (the renderer
// rolls the workspace back and the fan-out reports the task as not launched);
// a resume or re-fire types nothing.
//
// Measured on claude 2.1.292 (interactive TUI, a local fake Messages API):
// `Bash(gh pr merge*)` and `Bash(gh api*merge*)` hold under
// --dangerously-skip-permissions, including a compound line
// (`cd x && gh pr merge 3`); `gh pr view` and a plain `gh api` read pass.

import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import {
  BOT_WORKER_SESSIONS_VERSION,
  buildBotWorkerSettings,
  botWorkerSessionsPath,
  namesClaude,
  readBotWorkerSessions,
  workerProjectSettingsRefusal,
  type BotWorkerLaunchFiles,
  type BotWorkerSessionRecord,
} from '../../shared/botWorkerGuard';
import {
  buildWorkerMcpConfig,
  buildWorkerSettings,
  buildWslWorkerMcpConfig,
  contentFileName,
  spliceWorkerLaunch,
  workerWmuxLevel,
  type WorkerWmuxLevel,
} from '../../shared/botWorkerMcp';
import type { Connector } from '../../shared/botConnector';
import type { PermissionMode } from '../../shared/agentResume';
import { getTaskLedger } from '../deck/taskLedgerHost';
import { getConnectorStore } from '../factory/connectorStore';
import { launchesCodex, namesCodex } from '../../shared/codexWorkerGuard';
import { toWslPath } from '../../shared/imagePaste';
import { dataDirNoShellRefusal } from '../../shared/promptFileArgument';
import { dataSuffix } from '../../shared/constants';
import { bridgeHookGroups, findBridgeSourceFrom } from '../../cli/commands/setupHooks';

// The pure parts live in shared/ (the daemon guards a phone's launches too).
export {
  BOT_WORKER_DENY,
  BOT_WORKER_MERGE_DENY,
  botWorkerSessionsPath,
  botWorkerSettingsPath,
  buildBotWorkerSettings,
  isQuotable,
  isSingleCommand,
  spliceSettingsFlag,
  writeBotWorkerSettings,
} from '../../shared/botWorkerGuard';

export interface BotWorkerGuardDeps {
  /** The instance data dir (default: getWmuxDir()). */
  dir?: string;
  writeSettings?: (dir: string) => string;
  /** Main's ledger: is this workspace a bot's fan-out task? */
  isBotTaskWorkspace?: (workspaceId: string) => boolean;
  /** The wmux MCP bundle a worker's server runs (default: the resolver
   *  pty.handler registers). */
  mcpEntry?: () => string | null;
  /** #2231 — this build's own hook bridge when the instance is isolated
   *  (WMUX_DATA_SUFFIX set), else null: an isolated instance's worker loads
   *  no user settings and runs wmux's hooks on that bridge, not on the
   *  shared ~/.wmux/hooks copy the installed app keeps. */
  isolatedBridge?: () => string | null;
  /** The level of the owner's registered claude wmux server, if any. */
  registeredLevel?: () => string | null;
  /** A recorded session's connections now (default: its task's, from the
   *  ledger, that are still its bot's in the library). */
  sessionConnectors?: (workspaceId: string) => Connector[];
  /** A re-fire's or resume's other folders the line may start in (the pane's
   *  live and spawn folders), checked with the recorded one. */
  folders?: readonly string[];
  /** The Windows runtime a WSL worker's wmux server runs in (default: this
   *  build's own executable). */
  wslRuntime?: () => string;
  platform?: NodeJS.Platform;
}

/** pty.handler points the guard at the app's MCP bundle and the owner's
 *  registered claude profile. */
let defaultMcpEntry: () => string | null = () => null;
let defaultRegisteredLevel: () => string | null = () => null;
export function setWorkerMcpResolvers(r: { entry: () => string | null; registeredLevel: () => string | null }): void {
  defaultMcpEntry = r.entry;
  defaultRegisteredLevel = r.registeredLevel;
}

// ── Which panes are a bot's workers: main's own records, never the renderer's
// echo of the fan-out origin.
//
//  - The fan-out create: FanOutService marks the spawn it is running for a bot
//    (owner workspace + worktree) for the length of the renderer round trip.
//  - Any later create in that task workspace (a replaced dead pane, a new
//    tab): the task ledger row main registered at dispatch.
//  - Every session either created: factory/bot-worker-sessions.json, so a
//    re-fire or a resume after an app restart still knows the pane.

const inflightBotSpawns = new Map<string, number>();
/** Who each in-flight bot spawn is for (bot and task), main's own record:
 *  a secret grant resolves only for a spawn whose identity matches it. */
export interface BotSpawnIdentity {
  botId: string;
  taskId: string;
  /** The task's connections as main resolved them when the fan-out was
   *  accepted (a later edit of the library does not change this launch). */
  connectors?: Connector[];
}
const inflightSpawnIdentities = new Map<string, BotSpawnIdentity[]>();
const spawnKey = (ownerWorkspaceId: string, cwd: string): string => `${ownerWorkspaceId}\u0000${path.resolve(cwd)}`;

/** FanOutService, around the renderer spawn of a bot's worker. Returns the
 *  release. */
export function beginBotWorkerSpawn(ownerWorkspaceId: string, cwd: string, identity?: BotSpawnIdentity): () => void {
  const key = spawnKey(ownerWorkspaceId, cwd);
  inflightBotSpawns.set(key, (inflightBotSpawns.get(key) ?? 0) + 1);
  const mark = identity
    ? { botId: identity.botId, taskId: identity.taskId, ...(identity.connectors && identity.connectors.length > 0 ? { connectors: identity.connectors } : {}) }
    : null;
  if (mark) inflightSpawnIdentities.set(key, [...(inflightSpawnIdentities.get(key) ?? []), mark]);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (mark) {
      const left = (inflightSpawnIdentities.get(key) ?? []).filter((m) => m !== mark);
      if (left.length > 0) inflightSpawnIdentities.set(key, left);
      else inflightSpawnIdentities.delete(key);
    }
    const n = (inflightBotSpawns.get(key) ?? 1) - 1;
    if (n > 0) inflightBotSpawns.set(key, n);
    else {
      inflightBotSpawns.delete(key);
      codexLaunched.delete(key);
    }
  };
}

/** In-flight spawns (by spawnKey) whose one codex launch was claimed. */
const codexLaunched = new Set<string>();

/** codexWorkerGuard: the in-flight fan-out spawn of `ownerWorkspaceId` in
 *  `cwd` launches codex once; true for that one claim, false otherwise. */
export function claimInflightCodexLaunch(ownerWorkspaceId: string, cwd: string): boolean {
  const key = spawnKey(ownerWorkspaceId, cwd);
  if (!ownerWorkspaceId || !inflightBotSpawns.has(key) || codexLaunched.has(key)) return false;
  codexLaunched.add(key);
  return true;
}

/** The creates whose codex line codexWorkerGuard built, with the line and the
 *  folder it checked (main's own memory, per options object: a renderer cannot
 *  put an entry here, and an entry goes with its create). */
const guardedCodexCreates = new WeakMap<object, { line: string; cwd: string; repoKey?: string; codexHome?: string; connectors: string }>();

/** codexWorkerGuard: record a create it built, with the connections its line
 *  carries. */
export function markGuardedCodexCreate(options: object, line: string, cwd: string, repoKey?: string, codexHome?: string, connectors: readonly Connector[] = []): void {
  guardedCodexCreates.set(options, { line, cwd: path.resolve(cwd), ...(repoKey ? { repoKey } : {}), ...(codexHome ? { codexHome } : {}), connectors: JSON.stringify(connectors) });
}

/** pty:create: what the session record keeps of a guarded codex create. */
export function guardedCodexLaunch(options: object | undefined): { agent: string; cwd: string; repoKey?: string; codexHome?: string } | undefined {
  const g = options ? guardedCodexCreates.get(options) : undefined;
  return g ? { agent: 'codex', cwd: g.cwd, ...(g.repoKey ? { repoKey: g.repoKey } : {}), ...(g.codexHome ? { codexHome: g.codexHome } : {}) } : undefined;
}

/** Did the codex guard build this create's line (with exactly these
 *  connections, when given)? */
export function isGuardedCodexCreate(options: { initialCommand?: string } | undefined, connectors?: readonly Connector[]): boolean {
  const g = options ? guardedCodexCreates.get(options) : undefined;
  return !!g && g.line === options?.initialCommand && (connectors === undefined || g.connectors === JSON.stringify(connectors));
}

/**
 * pty:create, once the folder is resolved: a guarded codex create starts in
 * the folder it was checked in, or not at all (never a recovery folder or the
 * home fallback). Null when it may start, and for every other create.
 */
export function guardedCodexCwdRefusal(
  options: { initialCommand?: string } | undefined,
  resolution: { source: string; safeCwd?: string | null },
): string | null {
  const g = options ? guardedCodexCreates.get(options) : undefined;
  if (!g) return null;
  if (cwdMoved(g.cwd, resolution)) return 'PTY_CREATE: a bot\'s codex worker starts only in the folder its rules were written into';
  return null;
}

function cwdMoved(cwd: string, resolution: { source: string; safeCwd?: string | null }): boolean {
  return resolution.source !== 'requested' || !resolution.safeCwd || path.resolve(resolution.safeCwd) !== cwd;
}

/** pty:create, once the folder is resolved: a guarded claude create (its
 *  staged launch, guardedLaunchOf) starts in the folder whose project
 *  settings were checked, or not at all. */
export function guardedClaudeCwdRefusal(
  launch: { launch?: unknown; cwd?: string },
  resolution: { source: string; safeCwd?: string | null },
): string | null {
  if (!launch.launch || !launch.cwd) return null;
  return cwdMoved(launch.cwd, resolution) ? 'PTY_CREATE: a bot\'s claude worker starts only in the folder its settings were checked in' : null;
}

/** The folders a line typed into pane `sessionId` may start in: its live and
 *  spawn folders, from the daemon. Throws when they cannot be read. */
export async function paneLaunchFolders(sessionId: string, rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>): Promise<string[]> {
  const sessions = await rpc('daemon.listSessions', {}) as Array<{ id?: unknown; cwd?: unknown; spawnCwd?: unknown }>;
  const s = Array.isArray(sessions) ? sessions.find((x) => x?.id === sessionId) : undefined;
  if (!s) throw guardError('pty:write-launch', 'the pane\'s folder could not be read');
  return [s.cwd, s.spawnCwd].filter((f): f is string => typeof f === 'string' && f.length > 0);
}

function ledgerSaysBot(workspaceId: string): boolean {
  return getTaskLedger().findByTaskWorkspace(workspaceId)?.dispatch?.origin?.kind === 'bot';
}

/** What pty:create is creating, for the guard: a bot's worker (`strict` for
 *  the fan-out launch itself) in `workspaceId`, or null. */
export interface BotWorkerCreate {
  workspaceId: string;
  strict: boolean;
  /** The fan-out launch only: who the in-flight spawns of this owner and
   *  folder are for (main's record, never the renderer's). */
  spawns?: BotSpawnIdentity[];
}

export function botWorkerForCreate(
  options: { workspaceId?: unknown; cwd?: unknown; fanoutTaskOf?: unknown } | undefined,
  deps: BotWorkerGuardDeps = {},
): BotWorkerCreate | null {
  if (!options) return null;
  const workspaceId = typeof options.workspaceId === 'string' ? options.workspaceId : '';
  const owner = typeof options.fanoutTaskOf === 'string' ? options.fanoutTaskOf : '';
  if (owner && typeof options.cwd === 'string' && options.cwd && inflightBotSpawns.has(spawnKey(owner, options.cwd))) {
    const spawns = inflightSpawnIdentities.get(spawnKey(owner, options.cwd));
    return { workspaceId, strict: true, ...(spawns ? { spawns: spawns.map((s) => ({ ...s, ...(s.connectors ? { connectors: s.connectors } : {}) })) } : {}) };
  }
  if (!workspaceId) return null;
  let bot = false;
  try {
    bot = (deps.isBotTaskWorkspace ?? ledgerSaysBot)(workspaceId);
  } catch (err) {
    throw guardError('PTY_CREATE', `the task ledger could not be read: ${String(err)}`);
  }
  // The sessions record too, for a workspace whose ledger row is gone.
  if (!bot) bot = isBotWorkerWorkspace(workspaceId, deps.dir ?? getWmuxDir());
  return bot ? { workspaceId, strict: !!owner } : null;
}

/**
 * pty:create's stage. Returns `options` itself for every create that is not a
 * bot's worker. The fan-out launch of a bot's worker gets its guarded launch
 * line, or this throws (the create fails). Any other create in a bot's task
 * workspace gets a claude launch line guarded the same way, and anything else
 * (a plain shell, no line) unchanged.
 */
export function withBotWorkerMergeGuard<T extends { initialCommand?: string; exec?: unknown; cwd?: unknown }>(
  options: T | undefined,
  worker: BotWorkerCreate | null,
  deps: BotWorkerGuardDeps = {},
  /** `wsl`: the pane's shell is WSL (its launches keep the worker settings
   *  file alone, and take no connections). `level`: the wmux level a role
   *  binding asked for. */
  launch: { wsl?: boolean; level?: string } = {},
): T | undefined {
  if (!options || !worker) return options;
  const connectors = taskConnectors(worker);
  if (worker.strict) {
    if (options.exec !== undefined) throw guardError('PTY_CREATE', 'an exec unit has no launch line to guard');
    if (!options.initialCommand) throw guardError('PTY_CREATE', 'no launch line');
    // A codex worker's line is rebuilt by its own guard (codexWorkerGuard.ts),
    // which ran first, with the task's connections; any other codex line is
    // refused.
    if (launchesCodex(options.initialCommand)) {
      if (isGuardedCodexCreate(options, connectors)) return options;
      throw guardError('PTY_CREATE', 'a codex launch line the codex worker guard did not build');
    }
  } else if (options.initialCommand && namesCodex(options.initialCommand)) {
    throw guardError('PTY_CREATE', 'codex runs in a bot\'s worker pane only as the fan-out\'s own first launch');
  } else if (!options.initialCommand || !namesClaude(options.initialCommand)) {
    return options;
  }
  if (launch.wsl && connectors.length > 0) throw guardError('PTY_CREATE', 'a task with connections does not run in a WSL shell');
  const cwd = typeof options.cwd === 'string' && options.cwd ? path.resolve(options.cwd) : '';
  if (!launch.wsl && !cwd) throw guardError('PTY_CREATE', 'no folder to check the worker\'s settings in');
  const level = workerWmuxLevel(launch.level, (deps.registeredLevel ?? defaultRegisteredLevel)());
  const plan: LaunchPlan = launch.wsl
    ? { kind: 'legacy', level }
    : { kind: 'strict', connectors, level, cwd };
  const guarded = guardLaunchLine('PTY_CREATE', options.initialCommand, deps, plan);
  const next = guarded.line === options.initialCommand ? { ...options } : { ...options, initialCommand: guarded.line };
  launchOfCreate.set(next, { ...(guarded.files ? { launch: guarded.files, cwd } : {}), ...(launch.wsl ? { wsl: true } : {}) });
  return next;
}

/** What a guarded create's launch carried (per options object), for its
 *  session record. */
const launchOfCreate = new WeakMap<object, { launch?: BotWorkerLaunchFiles; cwd?: string; wsl?: boolean }>();

/** The task a create is the fan-out (or resume) launch of: the one task its
 *  in-flight spawns are for; none for any other create in a task workspace
 *  (a split, a new tab, a replaced pane). Pure. */
export function botWorkerLaunchTask(worker: Pick<BotWorkerCreate, 'strict' | 'spawns'> | null): { taskId?: string } {
  if (!worker?.strict || !worker.spawns) return {};
  const ids = [...new Set(worker.spawns.map((s) => s.taskId))];
  return ids.length === 1 && ids[0] ? { taskId: ids[0] } : {};
}

/** pty:create, when it records the session: the guarded launch's files and
 *  the folder it was checked in. */
export function guardedLaunchOf(options: object | undefined): { launch?: BotWorkerLaunchFiles; cwd?: string; wsl?: boolean } {
  return (options && launchOfCreate.get(options)) || {};
}

/** The connections the in-flight fan-out spawn of this create carries: one
 *  set, or the create is refused when its in-flight spawns disagree. */
/** The connections a create's in-flight spawns agree on ([] for any other
 *  create); throws when they disagree. */
export function taskConnectors(worker: { strict: boolean; spawns?: Array<{ connectors?: Connector[] }> }): Connector[] {
  if (!worker.strict || !worker.spawns || worker.spawns.length === 0) return [];
  const sets = worker.spawns.map((s) => s.connectors ?? []);
  const key = (cs: Connector[]) => JSON.stringify(cs);
  if (sets.some((cs) => key(cs) !== key(sets[0]))) throw guardError('PTY_CREATE', 'two task spawns in one folder name different connections');
  return sets[0];
}

/** The POSIX shells whose `clear; <line>` clears the screen first. */
const CLEARING_SHELL = /(^|[\\/])(sh|bash|zsh|dash|ksh|fish)$/;

/**
 * A bot worker's typed launch line, cleared from the screen before it runs:
 * `clear; <line>`, so the pane (shown on the Bots page) starts at the agent's
 * own screen instead of the shell's echo of a long command line. Only for a
 * POSIX shell the line is typed into (a WSL or Windows shell keeps the line
 * as it is). Typed at write time, after every stage that reads the line, so
 * the flags, the guard and the session pin are untouched. Pure.
 */
export function clearedLaunchLine(line: string | undefined, shell: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!line || line.trim().length === 0 || platform === 'win32') return line;
  return CLEARING_SHELL.test(shell.trim()) ? `clear; ${line}` : line;
}

function guardError(where: string, why: string): Error {
  return new Error(`${where}: a bot's fan-out worker starts only with the merge-lane guard (${why})`);
}

/** How a launch is guarded: the worker settings file and this build's wmux
 *  server alone (a WSL shell, which takes no connections), or per-launch
 *  files for these connections, in a folder whose project settings are
 *  checked first. */
type LaunchPlan =
  | { kind: 'legacy'; level: WorkerWmuxLevel }
  | { kind: 'strict'; connectors: readonly Connector[]; level: WorkerWmuxLevel; cwd: string; folders?: readonly string[]; strayKeys?: readonly string[] };

function guardLaunchLine(where: string, line: string, deps: BotWorkerGuardDeps, plan: LaunchPlan): { line: string; files?: BotWorkerLaunchFiles } {
  const dir = deps.dir ?? getWmuxDir();
  // #2268: the guard's files are named under the data folder, so a folder no
  // shell can quote refuses every launch. Say that (as #2256 does for a
  // Command Prompt pane), not that the line cannot carry the files. Not a
  // guardError: the room card takes this sentence whole.
  const stuck = dataDirNoShellRefusal(dir);
  if (stuck) throw new Error(`${where}: ${stuck}`);
  if (plan.kind === 'legacy') {
    let settingsPath: string;
    try {
      // A per-launch copy, so the session record names it as main's own.
      settingsPath = deps.writeSettings
        ? deps.writeSettings(dir)
        : writeContentFile(path.join(dir, 'factory', 'worker-settings'), `${JSON.stringify(buildBotWorkerSettings(), null, 2)}\n`);
    } catch (err) {
      throw guardError(where, `the worker settings could not be written: ${String(err)}`);
    }
    // The legacy plan is a WSL pane's: Linux claude opens each file through
    // its /mnt mount, never by the Windows path, and loads this build's wmux
    // server alone (--strict-mcp-config), run in the Windows runtime like a
    // WSL pane's own: never whichever wmux server the distro's claude config
    // names. A path Linux cannot reach is refused, not guessed.
    const platform = deps.platform ?? process.platform;
    const inWsl = (p: string): string | null => toWslPath(p) ?? (platform === 'win32' ? null : p);
    const entry = (deps.mcpEntry ?? defaultMcpEntry)();
    if (!entry) throw guardError(where, 'the wmux MCP bundle was not found, so the worker could not report');
    const runtime = inWsl((deps.wslRuntime ?? (() => process.execPath))());
    if (!runtime) throw guardError(where, 'this build\'s runtime cannot be reached from WSL, so the worker could not load its wmux server');
    let mcpConfigFile: string;
    try {
      mcpConfigFile = writeContentFile(path.join(dir, 'factory', 'worker-mcp'), `${JSON.stringify(buildWslWorkerMcpConfig(runtime, entry, plan.level), null, 2)}\n`);
    } catch (err) {
      throw guardError(where, `the worker's MCP config could not be written: ${String(err)}`);
    }
    const settingsInWsl = inWsl(settingsPath);
    const mcpInWsl = inWsl(mcpConfigFile);
    if (!settingsInWsl || !mcpInWsl) throw guardError(where, 'the worker\'s settings and MCP config cannot be reached from WSL');
    const guarded = spliceWorkerLaunch(line, settingsInWsl, mcpInWsl);
    if (guarded === null) throw guardError(where, 'the launch line cannot carry the worker\'s MCP config and rules');
    return { line: guarded, files: { settingsFile: settingsPath, mcpConfigFile, level: plan.level } };
  }
  const unsafe = [plan.cwd, ...(plan.folders ?? [])].map(workerProjectSettingsRefusal).find((r) => r !== null);
  if (unsafe) throw guardError(where, `the worker's folder has Claude settings a bot's worker does not start with (${unsafe})`);
  const entry = (deps.mcpEntry ?? defaultMcpEntry)();
  if (!entry) throw guardError(where, 'the wmux MCP bundle was not found, so the worker could not report');
  let files: BotWorkerLaunchFiles;
  try {
    files = writeWorkerLaunchFiles(dir, entry, plan.level, plan.connectors, plan.strayKeys, (deps.isolatedBridge ?? defaultIsolatedBridge)());
  } catch (err) {
    throw guardError(where, `the worker's MCP and rules files could not be written: ${String(err)}`);
  }
  const guarded = spliceWorkerLaunch(line, files.settingsFile, files.mcpConfigFile, files.settingSources);
  if (guarded === null) throw guardError(where, 'the launch line cannot carry the worker\'s MCP config and rules');
  return { line: guarded, files };
}

/** A worker launch's two files under `<dir>/factory/` (0600, folders 0700),
 *  named by their content, and each stdio connection's run folder with its
 *  empty npm user config. They hold names and paths only. */
export function writeWorkerLaunchFiles(dir: string, entry: string, level: WorkerWmuxLevel, connectors: readonly Connector[], strayKeys: readonly string[] = [], ownBridge: string | null = null): BotWorkerLaunchFiles {
  const factory = path.join(dir, 'factory');
  const { runDir, npmrc } = prepareConnectorRunDirs(dir, connectors);
  const mcp = `${JSON.stringify(buildWorkerMcpConfig({ entry, level, connectors, runDir, npmrc, strayKeys }), null, 2)}\n`;
  const connectionKeys = [...new Set([...connectors.flatMap((c) => c.secrets.map((s) => s.secret)), ...strayKeys])];
  const settings = `${JSON.stringify(buildWorkerSettings(connectors, ownBridge ? bridgeHookGroups(ownBridge) : undefined), null, 2)}\n`;
  return {
    settingsFile: writeContentFile(path.join(factory, 'worker-settings'), settings),
    mcpConfigFile: writeContentFile(path.join(factory, 'worker-mcp'), mcp),
    level,
    ...(connectionKeys.length > 0 ? { connectionKeys } : {}),
    // Its hooks are in its own file: the user's (which name the shared
    // bridge) are not loaded.
    ...(ownBridge ? { settingSources: 'project' as const } : {}),
  };
}

/** This build's hook bridge in an isolated instance, else null. */
function defaultIsolatedBridge(): string | null {
  return dataSuffix() !== '' ? findBridgeSourceFrom(__dirname) : null;
}

/** Each stdio connection's run folder under `<dir>/factory/connector-run/`
 *  (0700, outside every worktree) with its empty npm user config (0600). */
export function prepareConnectorRunDirs(dir: string, connectors: readonly Connector[]): { runDir: (c: Connector) => string; npmrc: (c: Connector) => string } {
  const runDir = (c: Connector) => path.join(dir, 'factory', 'connector-run', c.id);
  const npmrc = (c: Connector) => path.join(runDir(c), 'npmrc');
  for (const c of connectors) {
    if (c.transport !== 'stdio') continue;
    fs.mkdirSync(runDir(c), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(npmrc(c))) fs.writeFileSync(npmrc(c), '', { mode: 0o600 });
  }
  return { runDir, npmrc };
}

function writeContentFile(folder: string, content: string): string {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, contentFileName(content));
  try {
    if (fs.readFileSync(file, 'utf8') === content) {
      // In use again: the startup prune keeps it.
      try { fs.utimesSync(file, new Date(), new Date()); } catch { /* best effort */ }
      return file;
    }
  } catch {
    /* missing: write it */
  }
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
  return file;
}

// ── factory/bot-worker-sessions.json ─────────────────────────────────────────

type SessionRecord = BotWorkerSessionRecord;

// A record kept until its pane is closed. `unreadable`: the file exists but
// could not be read; every session then counts as a bot worker's, and
// nothing new is recorded over it.
let sessions: Map<string, SessionRecord> | null = null;
let sessionsDir: string | null = null;
let unreadable: string | null = null;

function loadSessions(dir: string): Map<string, SessionRecord> {
  if (sessions && sessionsDir === dir) return sessions;
  const read = readBotWorkerSessions(dir);
  unreadable = 'unreadable' in read ? read.unreadable : null;
  if (unreadable) console.warn(`[factory] ${botWorkerSessionsPath(dir)} is unreadable; every pane's launch line is guarded until it is fixed: ${unreadable}`);
  sessions = 'sessions' in read ? read.sessions : new Map();
  sessionsDir = dir;
  return sessions;
}

function saveSessions(dir: string, map: Map<string, SessionRecord>): void {
  const file = botWorkerSessionsPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const content = `${JSON.stringify({ version: BOT_WORKER_SESSIONS_VERSION, sessions: Object.fromEntries(map) })}\n`;
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
}

/** pty:create records a bot worker's session. Throws when the record cannot
 *  be written (the create fails: a session nobody could recognise after a
 *  restart is not started). */
export function noteBotWorkerSession(
  sessionId: string,
  workspaceId: string,
  dir: string = getWmuxDir(),
  /** What the launch carried: a guarded codex launch's folder and
   *  repository, or a claude launch's files (and whether its shell is WSL). */
  launch: { agent?: string; cwd?: string; repoKey?: string; codexHome?: string; launch?: BotWorkerLaunchFiles; wsl?: boolean; conversation?: { sessionId: string; permissionMode?: PermissionMode } | null; taskId?: string } = {},
): void {
  const map = loadSessions(dir);
  if (unreadable) throw guardError('PTY_CREATE', `the worker sessions record is unreadable: ${unreadable}`);
  const next = new Map(map);
  next.set(sessionId, {
    workspaceId,
    at: Date.now(),
    ...(launch.cwd ? { cwd: launch.cwd } : {}),
    ...(launch.agent && launch.cwd ? { agent: launch.agent, ...(launch.repoKey ? { repoKey: launch.repoKey } : {}), ...(launch.codexHome ? { codexHome: launch.codexHome } : {}) } : {}),
    ...(launch.launch ? { launch: launch.launch } : {}),
    ...(launch.wsl ? { wsl: true } : {}),
    ...(launch.conversation ? { launchSessionId: launch.conversation.sessionId, ...(launch.conversation.permissionMode ? { permissionMode: launch.conversation.permissionMode } : {}) } : {}),
    ...(launch.taskId ? { taskId: launch.taskId } : {}),
  });
  try {
    saveSessions(dir, next);
  } catch (err) {
    throw guardError('PTY_CREATE', `the worker session could not be recorded: ${String(err)}`);
  }
  map.set(sessionId, next.get(sessionId)!);
}

/** The pane is gone. Best-effort: a record left behind only keeps guarding. */
export function forgetBotWorkerSession(sessionId: string, dir: string = getWmuxDir()): void {
  const map = loadSessions(dir);
  if (unreadable || !map.has(sessionId)) return;
  const next = new Map(map);
  next.delete(sessionId);
  try {
    saveSessions(dir, next);
    map.delete(sessionId);
  } catch (err) {
    console.warn(`[factory] could not forget bot worker session ${sessionId}: ${String(err)}`);
  }
}

/** A bot worker's session record, or null (none, or the record is unreadable). */
export function botWorkerSessionRecord(sessionId: string, dir: string = getWmuxDir()): SessionRecord | null {
  const map = loadSessions(dir);
  if (unreadable !== null) return null;
  const r = map.get(sessionId);
  return r ? { ...r } : null;
}

/** A bot worker's session — every session while the record is unreadable. */
export function isBotWorkerSession(sessionId: string, dir: string = getWmuxDir()): boolean {
  const map = loadSessions(dir);
  return unreadable !== null || map.has(sessionId);
}

/** A workspace a bot worker's session was recorded in (any, while unreadable). */
function isBotWorkerWorkspace(workspaceId: string, dir: string): boolean {
  const map = loadSessions(dir);
  if (unreadable !== null) return true;
  for (const r of map.values()) if (r.workspaceId === workspaceId) return true;
  return false;
}

/** Tests: drop the in-memory copy, as an app restart does. */
export function reloadBotWorkerSessionsForTests(): void {
  sessions = null;
  sessionsDir = null;
  unreadable = null;
}

/**
 * worktask:refire's stage: the line to re-type into `sessionId`. A bot
 * worker's session gets the guarded line, or this throws (nothing is typed);
 * any other session gets `line` unchanged.
 */
export function guardRefireLine(sessionId: string, line: string, deps: BotWorkerGuardDeps = {}): string {
  if (!isBotWorkerSession(sessionId, deps.dir ?? getWmuxDir())) return line;
  if (namesCodex(line)) throw guardError('worktask:refire', 'codex is not re-fired in a bot\'s worker pane');
  return guardLaunchLine('worktask:refire', line, deps, recordedPlan('worktask:refire', sessionId, deps)).line;
}

/** A recorded session's launch: in a WSL shell the worker settings and this
 *  build's wmux server, at its recorded level;
 *  otherwise new files for the folder it was launched in, at its recorded
 *  wmux level (the owner's registered one for a record without files), with
 *  the task's connections that are still its bot's now. A session with no
 *  folder on record (or a record that cannot be read) is refused. */
function recordedPlan(where: string, sessionId: string, deps: BotWorkerGuardDeps): LaunchPlan {
  const rec = loadSessions(deps.dir ?? getWmuxDir()).get(sessionId);
  if (rec?.wsl) return { kind: 'legacy', level: rec.launch?.level ?? workerWmuxLevel((deps.registeredLevel ?? defaultRegisteredLevel)()) };
  if (!rec?.cwd) throw guardError(where, 'the session has no folder on record to check the worker\'s settings in');
  return {
    kind: 'strict',
    connectors: rec.launch ? (deps.sessionConnectors ?? ledgerTaskConnectors)(rec.workspaceId) : [],
    level: rec.launch?.level ?? workerWmuxLevel((deps.registeredLevel ?? defaultRegisteredLevel)()),
    cwd: rec.cwd,
    ...(deps.folders ? { folders: deps.folders } : {}),
    // The first launch's keys are still in the pane's environment.
    ...(rec.launch?.connectionKeys ? { strayKeys: rec.launch.connectionKeys } : {}),
  };
}

/** A task's connections now: the ones it was started with (its ledger row)
 *  that are still its bot's in the library; one turned off, out of scope or
 *  gone since is left out. */
export function ledgerTaskConnectors(workspaceId: string): Connector[] {
  const dispatch = getTaskLedger().findByTaskWorkspace(workspaceId)?.dispatch;
  const named = dispatch?.connectors ?? [];
  const botId = dispatch?.origin.kind === 'bot' ? dispatch.origin.botId : undefined;
  if (named.length === 0 || !botId) return [];
  return (getConnectorStore()?.forBot(botId) ?? []).filter((c) => named.includes(c.name));
}

/**
 * pty:write-launch's stage (a resume line typed into a pane, or the start of
 * one): in a bot worker's session, text that starts claude gets the guard or
 * this throws (nothing is typed). Text that names no claude launcher (the
 * second half of a staged resume) and every other session pass unchanged.
 */
export function guardSessionLaunch(sessionId: string, text: string, deps: BotWorkerGuardDeps = {}): string {
  if (!isBotWorkerSession(sessionId, deps.dir ?? getWmuxDir())) return text;
  if (namesCodex(text)) throw guardError('pty:write-launch', 'codex is not started again in a bot\'s worker pane');
  if (!namesClaude(text)) return text;
  return guardLaunchLine('pty:write-launch', text, deps, recordedPlan('pty:write-launch', sessionId, deps)).line;
}

/** Startup: remove per-launch files no session record names and older than
 *  a day (a fresh one may be in use between its write and the pane's
 *  create). Best effort; nothing is removed while the record is unreadable. */
export function pruneWorkerLaunchFiles(dir: string = getWmuxDir(), now: number = Date.now()): number {
  const read = readBotWorkerSessions(dir);
  if (!('sessions' in read)) return 0;
  const named = new Set<string>();
  for (const r of read.sessions.values()) {
    if (r.launch) {
      named.add(r.launch.settingsFile);
      named.add(r.launch.mcpConfigFile);
    }
  }
  let removed = 0;
  for (const sub of ['worker-settings', 'worker-mcp']) {
    const folder = path.join(dir, 'factory', sub);
    let names: string[] = [];
    try {
      names = fs.readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(folder, name);
      if (named.has(file) || !/^[0-9a-f]{12}\.json$/.test(name)) continue;
      try {
        if (now - fs.statSync(file).mtimeMs < 24 * 3600_000) continue;
        fs.unlinkSync(file);
        removed += 1;
      } catch { /* best effort */ }
    }
  }
  return removed;
}
