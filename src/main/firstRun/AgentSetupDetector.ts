import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AGENT_IDS,
  agentUpdateFloor,
  isOlderVersion,
  parseAgentVersion,
  type AgentId,
  type AgentSetupStatus,
} from '../../shared/agentSetup';
import { agentRow, type UnseenCredentials } from '../../shared/agentIdentity';
import { isInternalEnvKey } from '../../shared/envFilter';
import { withFreshWindowsPath } from '../../shared/windowsPathEnv';
import { killProcessTree } from '../../daemon/automation/treeKill';
import {
  agentCandidates,
  isExecutableFile,
  liveResolveEnv,
  resolveAgentExecutableWith,
} from '../claude/resolveClaudeExecutable';
import { resolveClaudeLaunch } from '../claude/resolveClaudeLaunch';

// Read-only detector behind the wizard's "Agent ready" cards: is each agent
// installed, which version, and is it signed in.
//
// Sign-in is read from each agent's own documented status subcommand, never
// from its credential store, so wmux reads no token and needs no knowledge of
// where an agent keeps one (Keychain, a file, a keyring):
//   - Claude Code: `claude auth status --json` (`claude auth status --help`:
//     "--json  Output as JSON (default)"). Measured on 2.1.305: exit 0 with
//     `"loggedIn": true`, exit 1 with `"loggedIn": false`. The JSON also holds
//     the account e-mail and organisation; only the boolean leaves this file.
//   - Codex: `codex login status` (`codex login --help`: "status  Show login
//     status"). Measured on codex-cli 0.163.0: exit 0 when signed in, exit 1
//     printing "Not logged in" when not.
// Anything else (a timeout, an old version without the subcommand, a crash) is
// "could not tell", never "signed out". Probe output is never logged.

/** Output of one probe. `code` is null when the process did not exit normally. */
export interface ProbeResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type ProbeRunner = (
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number; windowsVerbatimArguments?: boolean },
) => Promise<ProbeResult>;

export interface AgentSetupDetectorDeps {
  /** Executable for an agent, or null. Defaults to the shared resolver over `env()`. */
  resolve?: (agent: AgentId, env: NodeJS.ProcessEnv) => string | null;
  /**
   * A path the user typed in the card ("installed but not found"). Used first,
   * and only while it still points at an executable file.
   */
  override?: (agent: AgentId) => string | null;
  /** Is `p` an executable file? Guards the override. */
  isFile?: (p: string) => boolean;
  /** Candidate list shown when nothing was found. */
  candidates?: (agent: AgentId, env: NodeJS.ProcessEnv) => string[];
  run?: ProbeRunner;
  /** The environment probes start from (scrubbed before use). */
  env?: () => NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
  timeoutMs?: number;
  /** A small config file's text, or null when it cannot be read (unseen-credential check). */
  readFile?: (p: string) => string | null;
}

const PROBE_TIMEOUT_MS = 8_000;
const MAX_PROBE_OUTPUT = 64 * 1024;
/** The candidate list is for a person to read, not a full scan dump. */
const MAX_CANDIDATES = 12;


/**
 * The environment a probe runs with. A wmux started from inside a pane (or an
 * agent session) inherits that session's markers; a probe that saw them could
 * report on, or attach to, that session instead of the user's own install. So:
 *   - wmux/Electron internals and agent-nesting markers go (the same predicate
 *     every pane spawn uses), plus every WMUX_* pane identity variable;
 *   - CODEX_* session variables go, but CODEX_HOME stays, like CLAUDE_CONFIG_DIR:
 *     both name the user's real config dir, which is what must be checked;
 *   - DISABLE_AUTOUPDATER=1, so a status check cannot start Claude Code's
 *     background self-update (nothing may run that the user did not ask for).
 * The executable's own folder goes first on PATH: an npm-installed CLI is a
 * `#!/usr/bin/env node` script, and a GUI-launched app's PATH often lacks the
 * node that sits next to it.
 */
export function buildProbeEnv(
  base: NodeJS.ProcessEnv,
  executable: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (isInternalEnvKey(key)) continue;
    if (upper.startsWith('WMUX_')) continue;
    if (upper.startsWith('CODEX_') && upper !== 'CODEX_HOME') continue;
    out[key] = value;
  }
  out.DISABLE_AUTOUPDATER = '1';
  const p = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? ';' : ':';
  const pathKey = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const dir = p.dirname(executable);
  const current = out[pathKey];
  out[pathKey] = current ? `${dir}${sep}${current}` : dir;
  return out;
}

/**
 * Real runner with a hard timeout. On timeout the probe's whole process tree
 * is killed (an npm-installed agent is a node launcher with a native child,
 * which a signal to the launcher alone would leave running), and nothing else:
 * POSIX probes get their own process group, Windows uses taskkill /T on the
 * probe's pid. Output past the cap is dropped, never a reason to kill.
 */
export const execProbe: ProbeRunner = (command, args, opts) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number | null, timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        env: opts.env,
        cwd: opts.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        ...(opts.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch {
      finish(null, false);
      return;
    }
    const append = (cur: string, chunk: Buffer): string =>
      cur.length >= MAX_PROBE_OUTPUT ? cur : (cur + chunk.toString('utf8')).slice(0, MAX_PROBE_OUTPUT);
    child.stdout?.on('data', (c: Buffer) => { stdout = append(stdout, c); });
    child.stderr?.on('data', (c: Buffer) => { stderr = append(stderr, c); });
    child.on('error', () => finish(null, false));
    child.on('close', (code) => finish(typeof code === 'number' ? code : null, false));
    timer = setTimeout(() => {
      if (child.pid) void killProcessTree(child.pid);
      finish(null, true);
    }, opts.timeoutMs);
  });

/**
 * The value a launch would use for `key` in a TOML config, read the way the
 * agent does: the selected profile's table first (`profile = "x"` at the top
 * selects `[<table>.x]`), then the top level. Other tables do not count. Only
 * flat `key = value` lines are read; a value with an inline comment or quotes
 * comes back bare.
 */
export function activeConfigValue(
  text: string,
  key: string,
  profile?: { readonly key: string; readonly table: string },
): string | undefined {
  const tables = new Map<string, Map<string, string>>([['', new Map()]]);
  let table = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      table = header[1].replace(/["']/g, '');
      if (!tables.has(table)) tables.set(table, new Map());
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    tables.get(table)?.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/^["']|["']$/g, ''));
  }
  const top = tables.get('') ?? new Map<string, string>();
  const selected = profile ? top.get(profile.key) : undefined;
  return (selected && profile ? tables.get(`${profile.table}.${selected}`)?.get(key) : undefined) ?? top.get(key);
}

/**
 * Does the agent have a way to run that its status command does not report?
 * A non-empty listed environment variable, or the listed key, as the agent
 * would read it (activeConfigValue), set to anything but the agent's own value
 * in its config file (in the account folder, or the default one under the
 * home folder).
 */
export function hasUnseenCredential(
  unseen: UnseenCredentials | undefined,
  accountEnv: string | undefined,
  env: NodeJS.ProcessEnv,
  home: string,
  readFile: (p: string) => string | null,
): boolean {
  if (!unseen) return false;
  if (unseen.env.some((name) => (env[name] ?? '').trim() !== '')) return true;
  const config = unseen.configKey;
  if (!config) return false;
  const folder = (accountEnv && env[accountEnv]?.trim()) || path.join(home, config.dir);
  const text = readFile(path.join(folder, config.file));
  if (text === null) return false;
  const value = activeConfigValue(text, config.key, config.profile);
  return value !== undefined && value !== '' && value !== config.ownValue;
}

/**
 * Sign-in from a status probe: true / false, or null when it cannot be told.
 * How to read it is the row's `setup.loginStatus`. Only the exit code and a
 * single boolean (or the fixed signed-out line) are read; the rest of the
 * output is dropped here.
 */
export function readLoginState(agent: AgentId, result: ProbeResult): boolean | null {
  const spec = agentRow(agent)?.setup?.loginStatus;
  if (!spec || spec.read === 'none' || result.timedOut || result.code === null) return null;
  if (spec.read === 'json-logged-in') {
    let loggedIn: unknown;
    try {
      loggedIn = (JSON.parse(result.stdout) as { loggedIn?: unknown } | null)?.loggedIn;
    } catch {
      return null;
    }
    if (loggedIn === true && result.code === 0) return true;
    if (loggedIn === false && result.code === 1) return false;
    return null;
  }
  if (result.code === 0) return true;
  const out = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.code === 1 && out.includes(spec.signedOutText)) return false;
  return null;
}

export class AgentSetupDetector {
  private readonly resolve: (agent: AgentId, env: NodeJS.ProcessEnv) => string | null;
  private readonly override: (agent: AgentId) => string | null;
  private readonly isFile: (p: string) => boolean;
  private readonly candidates: (agent: AgentId, env: NodeJS.ProcessEnv) => string[];
  private readonly run: ProbeRunner;
  private readonly env: () => NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly homedir: () => string;
  private readonly timeoutMs: number;
  private readonly readFile: (p: string) => string | null;
  /** Concurrent callers share one probe round instead of spawning twice. */
  private inflight: Promise<AgentSetupStatus[]> | null = null;

  constructor(deps: AgentSetupDetectorDeps = {}) {
    // Windows: PATH as the registry has it now, so an install made while wmux
    // is running is found (and its node launcher can find node) without a restart.
    this.env = deps.env ?? (() => withFreshWindowsPath(process.env));
    this.resolve = deps.resolve ?? ((agent, env) => resolveAgentExecutableWith(liveResolveEnv(env), agent));
    this.override = deps.override ?? (() => null);
    this.isFile = deps.isFile ?? isExecutableFile;
    this.candidates = deps.candidates ?? ((agent, env) => agentCandidates(liveResolveEnv(env), agent));
    this.run = deps.run ?? execProbe;
    this.platform = deps.platform ?? process.platform;
    this.homedir = deps.homedir ?? os.homedir;
    this.timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
    this.readFile = deps.readFile ?? ((p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } });
  }

  detectAll(): Promise<AgentSetupStatus[]> {
    if (!this.inflight) {
      this.inflight = Promise.all(AGENT_IDS.map((a) => this.detect(a))).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** The executable the card would probe and sign in with, or null. */
  resolveExecutable(agent: AgentId, env: NodeJS.ProcessEnv = this.env()): string | null {
    try {
      const chosen = this.override(agent);
      if (chosen && this.isFile(chosen)) return chosen;
    } catch {
      /* unreadable override: fall back to the search */
    }
    try {
      return this.resolve(agent, env);
    } catch {
      return null;
    }
  }

  /** The probe environment for `executable` (scrubbed, fresh PATH). */
  probeEnvFor(executable: string): NodeJS.ProcessEnv {
    return buildProbeEnv(this.env(), executable, this.platform);
  }

  /** `x.y.z` from `<executable> --version`, or null when it does not run. */
  async readVersion(executable: string): Promise<string | null> {
    const result = await this.probe(executable, this.probeEnvFor(executable), ['--version']);
    return result.code === 0 ? parseAgentVersion(result.stdout) : null;
  }

  /**
   * Sign-in from the agent's own status command only (no `--version` run),
   * with `env` as the pane or run would have it, so CLAUDE_CONFIG_DIR /
   * CODEX_HOME pick the account: true / false, or null when it cannot be told.
   */
  async loginState(agent: AgentId, env: NodeJS.ProcessEnv = this.env()): Promise<boolean | null> {
    const loginStatus = agentRow(agent)?.setup?.loginStatus;
    if (!loginStatus || loginStatus.read === 'none') return null;
    const executable = this.resolveExecutable(agent, env);
    if (!executable) return null;
    const signedIn = readLoginState(agent, await this.probe(executable, buildProbeEnv(env, executable, this.platform), loginStatus.args));
    // The agent may run on a credential its status command does not report.
    if (signedIn === false && hasUnseenCredential(loginStatus.unseenCredentials, loginStatus.accountEnv, env, this.homedir(), this.readFile)) return null;
    return signedIn;
  }

  private probe(executable: string, probeEnv: NodeJS.ProcessEnv, args: readonly string[]): Promise<ProbeResult> {
    const launch = resolveClaudeLaunch(executable, { args, platform: this.platform });
    return this.run(launch.command, launch.args, {
      env: launch.env ? { ...probeEnv, ...launch.env } : probeEnv,
      // Never an opened repo: a project folder's config must not change the answer.
      cwd: this.homedir(),
      timeoutMs: this.timeoutMs,
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  }

  async detect(agent: AgentId): Promise<AgentSetupStatus> {
    const env = this.env();
    const executable = this.resolveExecutable(agent, env);
    if (!executable) {
      let candidates: string[] = [];
      try {
        candidates = this.candidates(agent, env).slice(0, MAX_CANDIDATES);
      } catch {
        candidates = [];
      }
      return {
        agent,
        readiness: 'not-installed',
        executable: null,
        version: null,
        updateRecommended: false,
        loginKnown: true,
        candidates,
      };
    }

    const probeEnv = buildProbeEnv(env, executable, this.platform);
    const probe = (args: readonly string[]): Promise<ProbeResult> => this.probe(executable, probeEnv, args);

    // An agent with no documented status subcommand is only run for its
    // version: its sign-in is its own, and the card says wmux cannot check it.
    const loginStatus = agentRow(agent)?.setup?.loginStatus;
    const statusArgs = loginStatus && loginStatus.read !== 'none' ? loginStatus.args : null;
    const [versionResult, statusResult] = await Promise.all([
      probe(['--version']),
      statusArgs ? probe(statusArgs) : Promise.resolve(null),
    ]);
    const version = versionResult.code === 0 ? parseAgentVersion(versionResult.stdout) : null;
    const loggedIn = statusResult ? readLoginState(agent, statusResult) : null;
    const floor = agentUpdateFloor(agent);
    return {
      agent,
      readiness: !statusArgs ? 'installed' : loggedIn === true ? 'ready' : 'login-needed',
      executable,
      version,
      updateRecommended: version !== null && floor !== null && isOlderVersion(version, floor),
      loginKnown: loggedIn !== null,
      candidates: [],
    };
  }
}
