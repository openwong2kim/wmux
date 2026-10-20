// ─── Bot commands — the OS sandbox every bot command runs in ───────────────
//
// A bot's Bash runs only inside Claude Code's own OS sandbox (Seatbelt on
// macOS, bubblewrap on Linux), set through the SDK `sandbox` option, which
// the SDK passes to claude as `--settings`:
//   - enabled, with no fallback: claude refuses to start when the sandbox
//     cannot (`failIfUnavailable`), no command may leave it
//     (`allowUnsandboxedCommands: false` makes claude ignore a call's
//     `dangerouslyDisableSandbox`), and being sandboxed allows nothing by
//     itself (`autoAllowBashIfSandboxed: false`: main still decides each
//     command, botExec.ts);
//   - files: writes only in the bot's own folder; no reads of wmux's data
//     folder (stores, tokens, approvals, the bots' Claude config), wmux's
//     pipe and daemon tokens, any Claude config folder or account, SSH, cloud
//     and GitHub credentials, or the keychains — except the bot's own folder;
//   - network: none (no domain is allowed, no Unix socket, no local port);
//   - environment: every variable of the session except a few harmless ones
//     (PATH, HOME, locale, terminal, temp folder) is unset for the command
//     (`credentials.envVars` mode deny: claude runs the command through
//     `env -u NAME …` on macOS and bubblewrap's `--unsetenv` on Linux), so
//     an API key, an account token or a wmux token never reaches it.
//
// Where the sandbox cannot run, a bot gets no command or file-writing tools
// at all (`probeBotExecSupport`): never on Windows; on macOS only with
// /usr/bin/sandbox-exec; on Linux only with bwrap and socat on PATH; and
// only with a claude at or above BOT_EXEC_MIN_CLAUDE_VERSION. That version is
// the lowest one checked to honour every option above (the CLI the SDK in
// this build pins, whose settings schema and sandbox wrapper include
// `credentials.envVars`), not a measured minimum: an older claude may accept
// the options and silently ignore the environment ones, so it is refused.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAuthTokenPath, getDaemonAuthTokenPath, getLegacyDaemonAuthTokenPath } from '../../shared/constants';
import { isExecutableFile } from '../claude/resolveClaudeExecutable';
import { probeClaudeExecutable } from './claudeProbe';

/** The lowest claude checked to honour the sandbox options bots need. */
export const BOT_EXEC_MIN_CLAUDE_VERSION: readonly [number, number, number] = [2, 1, 206];

/** Variables a sandboxed command keeps; every other one is unset. */
export const BOT_EXEC_KEPT_ENV: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'TMPDIR', 'TMP', 'TEMP',
  'TZ', 'PWD', 'SHLVL', 'NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', '__CF_USER_TEXT_ENCODING',
]);

/** Unset for every command even when the session does not carry them. */
const ALWAYS_UNSET_ENV: readonly string[] = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK',
  'WMUX_AUTH_TOKEN', 'WMUX_COMMANDER_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK',
];

/** A name claude's sandbox can unset (its schema's rule). */
export const UNSETTABLE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function keptEnv(name: string): boolean {
  return BOT_EXEC_KEPT_ENV.has(name) || name.startsWith('LC_');
}

/** The variables unset for a bot's commands, from the session's env. Pure. */
export function botExecUnsetEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  const names = new Set<string>(ALWAYS_UNSET_ENV);
  for (const name of Object.keys(env)) if (UNSETTABLE_ENV_NAME.test(name) && !keptEnv(name)) names.add(name);
  return [...names].sort();
}

export interface BotSandboxInput {
  /** The bot's own folder (the session's cwd). */
  botDir: string;
  /** wmux's data folder. */
  wmuxDir: string;
  /** The session's env (what claude runs with). */
  env: Readonly<Record<string, string | undefined>>;
  home?: string;
  /** Claude config folders of the owner's accounts. */
  accountConfigDirs?: readonly string[];
  platform?: NodeJS.Platform;
}

/** Paths no sandboxed command reads. Pure apart from the token path helpers. */
export function botSandboxDenyRead(input: BotSandboxInput): string[] {
  const home = input.home ?? os.homedir();
  const out = new Set<string>([
    input.wmuxDir,
    path.join(home, '.wmux'),
    getAuthTokenPath(),
    path.join(home, '.wmux-auth-token'),
    getDaemonAuthTokenPath(),
    getLegacyDaemonAuthTokenPath(),
    path.join(home, '.claude'),
    path.join(home, '.claude.json'),
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.config', 'gh'),
    path.join(home, '.git-credentials'),
    path.join(home, '.netrc'),
    path.join(home, '.npmrc'),
    path.join(home, '.docker'),
    path.join(home, '.kube'),
    path.join(home, '.gnupg'),
    path.join(home, '.config', 'gcloud'),
    path.join(home, '.azure'),
  ]);
  if ((input.platform ?? process.platform) === 'darwin') {
    out.add(path.join(home, 'Library', 'Keychains'));
    out.add('/Library/Keychains');
  }
  const configDir = input.env.CLAUDE_CONFIG_DIR;
  if (configDir && path.isAbsolute(configDir)) out.add(configDir);
  for (const dir of input.accountConfigDirs ?? []) if (dir && path.isAbsolute(dir)) out.add(dir);
  return [...out].filter(Boolean);
}

/** The SDK `sandbox` option of a bot session that runs commands. Pure apart
 *  from the token path helpers. */
export function botSandboxSettings(input: BotSandboxInput): Record<string, unknown> {
  const home = input.home ?? os.homedir();
  const configDir = input.env.CLAUDE_CONFIG_DIR && path.isAbsolute(input.env.CLAUDE_CONFIG_DIR) ? input.env.CLAUDE_CONFIG_DIR : path.join(home, '.claude');
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
    excludedCommands: [],
    filesystem: {
      allowWrite: [input.botDir],
      denyRead: botSandboxDenyRead(input),
      // The bot's folder sits inside wmux's data folder; claude's shell
      // snapshot (the owner's shell functions and aliases, no variables) is
      // read by every command before it runs.
      allowRead: [input.botDir, path.join(configDir, 'shell-snapshots')],
    },
    network: { allowedDomains: [], allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false },
    credentials: { envVars: botExecUnsetEnv(input.env).map((name) => ({ name, mode: 'deny' })) },
  };
}

// ── Capability ─────────────────────────────────────────────────────────────

export type BotExecSupport = { ok: true; version: string } | { ok: false; reason: string };

/** `2.1.305 (Claude Code)` → [2, 1, 305]; null when there is no version. */
export function parseClaudeVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(v: readonly number[], min: readonly number[]): boolean {
  for (let k = 0; k < 3; k++) {
    if (v[k] !== min[k]) return v[k] > min[k];
  }
  return true;
}

export interface BotExecPlatformDeps {
  platform?: NodeJS.Platform;
  isFile?: (p: string) => boolean;
  onPath?: (command: string) => boolean;
}

function onPathDefault(command: string): boolean {
  return (process.env.PATH ?? '').split(':').filter(Boolean).some((d) => isExecutableFile(path.join(d, command)));
}

/** Why the sandbox cannot run on this machine, or null. */
export function botExecPlatformRefusal(deps: BotExecPlatformDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  const isFile = deps.isFile ?? ((p: string) => fs.existsSync(p));
  const onPath = deps.onPath ?? onPathDefault;
  if (platform === 'darwin') return isFile('/usr/bin/sandbox-exec') ? null : 'macOS sandbox-exec is missing';
  if (platform === 'linux') {
    const missing = ['bwrap', 'socat'].filter((c) => !onPath(c));
    return missing.length === 0 ? null : `the sandbox needs ${missing.join(' and ')} on PATH`;
  }
  return `bots do not run commands on ${platform}`;
}

/** Whether a claude that reported `versionText` runs bot commands. Pure. */
export function botExecVersionRefusal(versionText: string): string | null {
  const v = parseClaudeVersion(versionText);
  if (!v) return 'the Claude Code version could not be read';
  if (!atLeast(v, BOT_EXEC_MIN_CLAUDE_VERSION)) return `Claude Code ${v.join('.')} is older than ${BOT_EXEC_MIN_CLAUDE_VERSION.join('.')}`;
  return null;
}

export interface BotExecProbeDeps extends BotExecPlatformDeps {
  /** `claude --version` (default: probeClaudeExecutable, cached by path and mtime). */
  version?: (exe: string) => Promise<{ ok: true; version: string } | { ok: false; detail: string }>;
}

const supportCache = new Map<string, BotExecSupport>();

/**
 * Whether bots on `exe` get the command tools: the platform's sandbox is
 * present and `exe` is new enough. Never throws; cached per path and
 * version (the version probe itself is cached per path and mtime).
 */
export async function probeBotExecSupport(exe: string | null, deps: BotExecProbeDeps = {}): Promise<BotExecSupport> {
  const platform = botExecPlatformRefusal(deps);
  if (platform) return { ok: false, reason: platform };
  if (!exe) return { ok: false, reason: 'no claude executable' };
  let probed: { ok: true; version: string } | { ok: false; detail: string };
  try {
    probed = await (deps.version ?? ((p: string) => probeClaudeExecutable(p)))(exe);
  } catch (err) {
    return { ok: false, reason: `claude --version failed: ${String(err)}` };
  }
  if (!probed.ok) return { ok: false, reason: `claude --version failed: ${probed.detail}` };
  const key = `${exe}\0${probed.version}`;
  const hit = supportCache.get(key);
  if (hit) return hit;
  const refusal = botExecVersionRefusal(probed.version);
  const result: BotExecSupport = refusal ? { ok: false, reason: refusal } : { ok: true, version: probed.version };
  supportCache.set(key, result);
  return result;
}

/** Test-only. */
export function __clearBotExecSupportCacheForTesting(): void {
  supportCache.clear();
}
