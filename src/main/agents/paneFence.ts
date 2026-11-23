// ─── The worker fence in a person's own pane ────────────────────────────────
//
// A pane the person opted into the fence (the pane menu, or the workspace
// profile for new panes) launches claude inside the same worker fence a bot's
// unattended worker runs in (botWorkerFence.ts attachWorkerFence, workerFence.ts
// workerFenceLaunch): the OS sandbox for Bash, the file hook for claude's own
// write tools, and the credential denies. Off unless the person turns it on.
//
// What differs from a bot worker:
//   - every permission mode is fenced (the mode can change inside a session);
//   - only the full fence launches: where it would be weaker (no OS sandbox,
//     a WSL pane), or did not pass its self-test, the launch is refused with
//     the reason, never started unfenced or without tools;
//   - none of the bot worker's own rules (MCP config, connections, merge lane);
//   - Claude Code only for now: a codex (or any other agent) line is refused.
//
// Like a fenced bot worker, the launch loads no user settings
// (`--setting-sources project`): user hooks, enabledPlugins and statusLine
// are off; env, model, apiKeyHelper and the AWS helpers are carried
// (carriedUserSettings), and wmux's own status hooks come in the fence file.

import path from 'node:path';
import { splitModelEnvMarker } from '../../shared/workerLaunch';
import { tokenize } from '../../shared/agentResume';
import { isClaudeLauncher, isQuotable, workerProjectSettingsRefusal } from '../../shared/botWorkerGuard';
import { buildWorkerMcpConfig, workerWmuxLevel, type WorkerWmuxLevel } from '../../shared/botWorkerMcp';
import { paneLineAgents } from '../../shared/paneFence';
import { getWmuxDir } from '../../daemon/config';
import { bridgeHookGroups, findBridgeSourceFrom } from '../../cli/commands/setupHooks';
import { attachWorkerFence, lastWorkerFenceSupport, writeContentFile, type WorkerFenceAttachInput, type WorkerFenceSupport } from './botWorkerFence';
import { pinClaudeLauncher, workerMcpResolvers } from './botWorkerMergeGuard';
import { mergeWorkerFenceSettings, workerFenceLaunch } from './workerFence';

/** The refusal for an agent the fence does not cover yet. */
export const PANE_FENCE_CLAUDE_ONLY = 'the worker fence runs Claude Code only for now, so this agent does not start in a fenced pane';

/** The folder a fenced pane's settings files are written to. */
export function paneFenceFilesDir(dir: string = getWmuxDir()): string {
  return path.join(dir, 'factory', 'pane-fence');
}

export interface PaneFenceDeps {
  dir?: string;
  /** This computer's fence support (default: the last workerFenceSupport). */
  support?: WorkerFenceSupport | null;
  /** wmux's hook bridge (default: this build's). */
  bridge?: () => string | null;
  platform?: NodeJS.Platform;
  /** wmux's MCP server for the launch (default: the app's bundle and the
   *  owner's registered level, as a bot worker's). */
  mcp?: () => { entry: string | null; level: WorkerWmuxLevel };
  /** Inputs passed on to attachWorkerFence (the pane's env, a resume's temp
   *  folder; the rest for tests). */
  fence?: Partial<Pick<WorkerFenceAttachInput, 'runtime' | 'home' | 'env' | 'accountConfigDirs' | 'claudeTempRoots' | 'paneTempDir'>>;
}

/** What a fenced launch ran with: kept with the session (paneFenceSessions.ts). */
export interface PaneFenceLaunchRecord {
  cwd: string;
  settingsFile: string;
  mcpConfigFile?: string;
  tempDir?: string;
}

/** Whether `line` starts an agent (shared/paneFence.ts paneLineAgents): at
 *  a command word of any of its commands, or behind a wrapper. Pure. */
export function paneLineStartsAgent(line: string): boolean {
  return paneLineAgents(line).length > 0;
}

function defaultPaneMcp(): { entry: string | null; level: WorkerWmuxLevel } {
  const r = workerMcpResolvers();
  return { entry: r.entry(), level: workerWmuxLevel(r.registeredLevel()) };
}

function refusal(why: string): Error {
  return new Error(`worker fence: ${why}`);
}

/** `--setting-sources=project` right after the launcher (the first word
 *  that is not `VAR=value`), and with `mcpConfig`, `--mcp-config="<it>"
 *  --strict-mcp-config` too, so only the servers the line itself names load.
 *  Null when the line already names its own setting sources, or the config
 *  path cannot be quoted. Pure. */
export function spliceProjectSettingSources(fullCommand: string, mcpConfig?: string): string | null {
  const { marker, command } = splitModelEnvMarker(fullCommand);
  const tokens = tokenize(command);
  const first = tokens.findIndex((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.value));
  if (first < 0) return null;
  const rest = tokens.slice(first + 1);
  if (rest.some((t) => /^--setting-sources(=|$)/.test(t.value))) return null;
  let flags = ' --setting-sources=project';
  if (mcpConfig !== undefined) {
    if (!isQuotable(mcpConfig)) return null;
    // A line naming its own MCP config (a wmux tool level's) keeps it.
    if (!rest.some((t) => /^--mcp-config(=|$)/.test(t.value))) flags += ` --mcp-config="${mcpConfig}"`;
    if (!rest.some((t) => t.value === '--strict-mcp-config')) flags += ' --strict-mcp-config';
  }
  const at = tokens[first].end;
  return `${marker}${command.slice(0, at)}${flags}${command.slice(at)}`;
}

/**
 * The fenced launch of `line` in an opted-in pane whose folder is `cwd`.
 * Null when the line starts no agent (a plain shell command is typed as it
 * is). Throws the refusal, starting with `worker fence:`, when the full fence
 * cannot be put around it: nothing is launched then.
 */
export function paneFenceLaunch(line: string, cwd: string | undefined, launch: { wsl?: boolean } = {}, deps: PaneFenceDeps = {}): { line: string; record: PaneFenceLaunchRecord } | null {
  const agents = paneLineAgents(line);
  if (agents.length === 0) return null;
  if (agents.some((a) => !isClaudeLauncher(a))) throw refusal(PANE_FENCE_CLAUDE_ONLY);
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') throw refusal('it needs the OS sandbox (macOS sandbox-exec or Linux bubblewrap), which Windows does not have');
  if (launch.wsl) throw refusal('a WSL pane cannot run the OS sandbox');
  if (!cwd) throw refusal('the pane has no folder to fence');
  const support = deps.support !== undefined ? deps.support : lastWorkerFenceSupport();
  // Only the full fence: a weaker one leaves Bash outside the sandbox, and a
  // self-test failure would start claude with no tools.
  if (support && !support.capable && !support.transient) throw refusal(`it needs the OS sandbox, which cannot run here (${support.reason})`);
  if (support && support.capable && !support.selfTest.ok && !support.selfTest.transient) throw refusal(`the fence failed its self-test, so claude does not start (${support.selfTest.reason})`);
  const dir = deps.dir ?? getWmuxDir();
  const bridge = (deps.bridge ?? (() => findBridgeSourceFrom(__dirname)))();
  if (!bridge) throw refusal('wmux\'s hook bridge was not found, so a fenced pane could not report');
  const mcp = (deps.mcp ?? defaultPaneMcp)();
  if (!mcp.entry) throw refusal('the wmux MCP bundle was not found, so a fenced pane could not report');
  const attached = attachWorkerFence({ line, cwd, wsl: false, dir, switchedOff: false, always: true, support: support ?? null, platform, ...(deps.fence ?? {}) });
  if (attached.kind !== 'fence' || attached.strength !== 'full' || !attached.launcher) throw refusal('only the full fence starts in a fenced pane');
  // The project settings still load (--setting-sources=project): a hook or
  // helper they name would run outside the OS sandbox, so the same rule as a
  // bot's worker holds.
  const unsafe = workerProjectSettingsRefusal(cwd);
  if (unsafe) throw refusal(`the folder's Claude settings run programs outside the fence (${unsafe})`);
  const merged = mergeWorkerFenceSettings(attached.settings, [{ disableAllHooks: false, hooks: bridgeHookGroups(bridge) }]);
  if (!merged.ok) throw refusal(`wmux's hooks change the fence's ${merged.key}`);
  const settingsFile = writeContentFile(paneFenceFilesDir(dir), `${JSON.stringify(merged.settings, null, 2)}\n`);
  // Only wmux's own server loads, as for a bot's worker (botWorkerMcp.ts).
  const mcpConfigFile = writeContentFile(paneFenceFilesDir(dir), `${JSON.stringify(buildWorkerMcpConfig({ entry: mcp.entry, level: mcp.level, connectors: [], runDir: () => dir, npmrc: () => dir }), null, 2)}\n`);
  const checked = workerFenceLaunch({ line, settingsPath: settingsFile, fence: merged.settings });
  if (!checked.ok) throw refusal(checked.reason);
  // The full fence runs exactly the claude its self-test ran.
  const pinned = pinClaudeLauncher(checked.line, attached.launcher);
  if (pinned === null) throw refusal('the launch line cannot run the claude the fence was checked on');
  const sourced = spliceProjectSettingSources(pinned, mcpConfigFile);
  if (sourced === null) throw refusal('the line names its own --setting-sources, which would load settings the fence keeps out');
  return { line: sourced, record: { cwd, settingsFile, mcpConfigFile, ...(attached.tempDir ? { tempDir: attached.tempDir } : {}) } };
}

/** pty:create, once the folder is resolved: a fenced pane starts in the
 *  folder its fence was built for (a respawn's recovered folder included),
 *  or not at all. */
export function paneFenceCwdRefusal(record: { cwd: string } | undefined, resolution: { source: string; safeCwd?: string | null }): string | null {
  if (!record) return null;
  const moved = !resolution.safeCwd || path.resolve(resolution.safeCwd) !== path.resolve(record.cwd);
  return moved ? 'PTY_CREATE: worker fence: the pane would start in another folder than the one its fence was built for' : null;
}
