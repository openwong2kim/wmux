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
import { namesClaude, workerProjectSettingsRefusal } from '../../shared/botWorkerGuard';
import { namesCodex } from '../../shared/codexWorkerGuard';
import { getWmuxDir } from '../../daemon/config';
import { bridgeHookGroups, findBridgeSourceFrom } from '../../cli/commands/setupHooks';
import { startsAgent } from '../factory/workerSlots';
import { attachWorkerFence, lastWorkerFenceSupport, writeContentFile, type WorkerFenceAttachInput, type WorkerFenceSupport } from './botWorkerFence';
import { pinClaudeLauncher } from './botWorkerMergeGuard';
import { mergeWorkerFenceSettings, workerFenceLaunch, WRAPPER_STEMS } from './workerFence';
import { launcherStem } from '../../shared/agentResume';

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
  /** Test inputs passed on to attachWorkerFence. */
  fence?: Partial<Pick<WorkerFenceAttachInput, 'runtime' | 'home' | 'env' | 'accountConfigDirs' | 'claudeTempRoots'>>;
}

/** What a fenced launch ran with: kept with the session (paneFenceSessions.ts). */
export interface PaneFenceLaunchRecord {
  cwd: string;
  settingsFile: string;
  tempDir?: string;
}

/** Whether `line` starts an agent, also behind wrapper words (`command`,
 *  `sh -c`, `nice -n 5`, `timeout 30`, ...), which startsAgent alone does not
 *  look past: a line that starts with a wrapper and names an agent in any
 *  later word counts. Over-matching is the safe side. Pure. */
export function paneLineStartsAgent(line: string): boolean {
  if (namesClaude(line) || namesCodex(line) || startsAgent(line)) return true;
  const tokens = tokenize(splitModelEnvMarker(line.trim()).command.trim());
  const first = tokens.findIndex((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.value));
  if (first < 0 || !WRAPPER_STEMS.has(launcherStem(tokens[first].value))) return false;
  return tokens.slice(first + 1).some((t) => namesCodex(t.value) || startsAgent(t.value));
}

function refusal(why: string): Error {
  return new Error(`worker fence: ${why}`);
}

/** `--setting-sources=project` right after the launcher; null when the line
 *  already names its own. Pure. */
export function spliceProjectSettingSources(fullCommand: string): string | null {
  const { marker, command } = splitModelEnvMarker(fullCommand);
  const tokens = tokenize(command);
  if (tokens.length === 0) return null;
  if (tokens.slice(1).some((t) => /^--setting-sources(=|$)/.test(t.value))) return null;
  const at = tokens[0].end;
  return `${marker}${command.slice(0, at)} --setting-sources=project${command.slice(at)}`;
}

/**
 * The fenced launch of `line` in an opted-in pane whose folder is `cwd`.
 * Null when the line starts no agent (a plain shell command is typed as it
 * is). Throws the refusal, starting with `worker fence:`, when the full fence
 * cannot be put around it: nothing is launched then.
 */
export function paneFenceLaunch(line: string, cwd: string | undefined, launch: { wsl?: boolean } = {}, deps: PaneFenceDeps = {}): { line: string; record: PaneFenceLaunchRecord } | null {
  if (!namesClaude(line)) {
    if (paneLineStartsAgent(line)) throw refusal(PANE_FENCE_CLAUDE_ONLY);
    return null;
  }
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
  const attached = attachWorkerFence({ line, cwd, wsl: false, dir, switchedOff: false, always: true, support: support ?? null, platform, ...(deps.fence ?? {}) });
  if (attached.kind !== 'fence' || attached.strength !== 'full' || !attached.launcher) throw refusal('only the full fence starts in a fenced pane');
  // The project settings still load (--setting-sources=project): a hook or
  // helper they name would run outside the OS sandbox, so the same rule as a
  // bot's worker holds.
  const unsafe = workerProjectSettingsRefusal(cwd);
  if (unsafe) throw refusal(`the folder's Claude settings run programs outside the fence (${unsafe})`);
  const bridge = (deps.bridge ?? (() => findBridgeSourceFrom(__dirname)))();
  if (!bridge) throw refusal('wmux\'s hook bridge was not found, so a fenced pane could not report');
  const merged = mergeWorkerFenceSettings(attached.settings, [{ disableAllHooks: false, hooks: bridgeHookGroups(bridge) }]);
  if (!merged.ok) throw refusal(`wmux's hooks change the fence's ${merged.key}`);
  const settingsFile = writeContentFile(paneFenceFilesDir(dir), `${JSON.stringify(merged.settings, null, 2)}\n`);
  const checked = workerFenceLaunch({ line, settingsPath: settingsFile, fence: merged.settings });
  if (!checked.ok) throw refusal(checked.reason);
  // The full fence runs exactly the claude its self-test ran.
  const pinned = pinClaudeLauncher(checked.line, attached.launcher);
  if (pinned === null) throw refusal('the launch line cannot run the claude the fence was checked on');
  const sourced = spliceProjectSettingSources(pinned);
  if (sourced === null) throw refusal('the line names its own --setting-sources, which would load settings the fence keeps out');
  return { line: sourced, record: { cwd, settingsFile, ...(attached.tempDir ? { tempDir: attached.tempDir } : {}) } };
}

/** pty:create, once the folder is resolved: a fenced pane starts in the
 *  folder its fence was built for, or not at all. */
export function paneFenceCwdRefusal(record: { cwd: string } | undefined, resolution: { source: string; safeCwd?: string | null }): string | null {
  if (!record) return null;
  const moved = resolution.source !== 'requested' || !resolution.safeCwd || path.resolve(resolution.safeCwd) !== path.resolve(record.cwd);
  return moved ? 'PTY_CREATE: worker fence: the pane would start in another folder than the one its fence was built for' : null;
}
