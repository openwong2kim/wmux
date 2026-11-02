// ─── My Hermes — the owner's own Hermes profile, checked read-only ─────────
//
// A bot on "My Hermes" (BotEngine `mode: 'own'`) is bound to one of the
// owner's own Hermes profiles: `~/.hermes` (profile `default`) or
// `~/.hermes/profiles/<name>`. This version stores that choice and shows
// whether the profile could serve a bot; it never starts Hermes for one
// (botEngines.ts refuses the spawn).
//
// Everything here is static: file reads only, no Hermes process at all. The
// Hermes CLI is not run, because its startup can write the Hermes home: on
// macOS and Linux `hermes --version` runs Hermes's update check, which
// writes `.update_check` in the home, and loading the config runs
// `ensure_hermes_home`. It is also separate from wmux's managed Hermes
// (hermesEngine.ts `hermesReadiness` writes wmux's own home and starts a
// probe session; nothing of it is used here):
// - the profile folder is listed and checked with fs reads only;
// - the version is read from the pinned install itself
//   (`~/.hermes/hermes-agent/hermes_cli/__init__.py` `__version__`), the
//   install `hermesExeOwnedBy` proved the `hermes` on PATH starts;
// - ACP support is the `acp` package in that install's venv;
// - the profile's `config.yaml` is parsed (YAML 1.1, as Hermes's PyYAML
//   reads it) for the few keys that decide readiness. Where a key is
//   missing, Hermes's own default applies (hermes_cli/config.py
//   DEFAULT_CONFIG): `model` "" (no model), `approvals.mode` "smart",
//   `mcp_servers` none, `command_allowlist` [], `platforms` none. A missing
//   or unreadable file is `unknown`, never a guess. Not seen by a static
//   read: `${VAR}` references in values, an administrator's managed-scope
//   overlay, and settings Hermes takes from the process environment;
// - the profile's `.env` is read for its variable NAMES only (the messaging
//   tokens that turn a platform on); a value never leaves `envNames`;
// - `gateway_state.json` is read as wmux reads its own gateway's.
// `auth.json` and every other credential file are never opened.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HERMES_PROFILE_RE, MY_HERMES_DEFAULT_PROFILE } from '../../shared/bot';
import {
  HERMES_MESSENGER_TOKEN_ENV,
  HERMES_UPDATE_COMMAND,
  HERMES_VERSION_BELOW,
  HERMES_VERSION_MIN,
  hermesVersionStatus,
  type MyHermesNotice,
  type MyHermesNotReadyReason,
  type MyHermesReadiness,
} from '../../shared/hermesEngine';
import YAML from 'yaml';
import { hermesHasModel, readHermesGatewayState, resolveHermesExecutable } from './hermesEngine';
import { parseInstallVersion } from './hermesInstall';

/** The Hermes root of `home` (the default profile's folder). Pure. */
export function myHermesRoot(home: string): string {
  return path.join(home, '.hermes');
}

/** The folder of `profile` (a checked name: HERMES_PROFILE_RE). Pure. */
export function myHermesProfileDir(home: string, profile: string): string {
  if (!HERMES_PROFILE_RE.test(profile)) throw new Error('not a Hermes profile name');
  const root = myHermesRoot(home);
  return profile === MY_HERMES_DEFAULT_PROFILE ? root : path.join(root, 'profiles', profile);
}

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The owner's Hermes profiles: `default` (always, so a computer without
 *  Hermes still shows the option and says why it is not ready), then each
 *  folder of `~/.hermes/profiles` whose name Hermes accepts. */
export function listMyHermesProfiles(home: string, deps: { isDir?: (p: string) => boolean; readdir?: (p: string) => string[] } = {}): string[] {
  const dirOk = deps.isDir ?? isDir;
  const readdir = deps.readdir ?? ((p: string) => fs.readdirSync(p));
  const root = myHermesRoot(home);
  const out = [MY_HERMES_DEFAULT_PROFILE];
  if (!dirOk(root)) return out;
  let names: string[] = [];
  try {
    names = readdir(path.join(root, 'profiles'));
  } catch {
    names = [];
  }
  for (const name of [...names].sort()) {
    if (name !== MY_HERMES_DEFAULT_PROFILE && HERMES_PROFILE_RE.test(name) && dirOk(path.join(root, 'profiles', name))) out.push(name);
  }
  return out.slice(0, 50);
}

/** The largest launcher script read to see which install it starts. */
const LAUNCHER_MAX_BYTES = 8 * 1024;

/** Whether `exe` is the Hermes installed in `root` (`<root>/hermes-agent`):
 *  the executable itself lives there, or it is the installer's small
 *  launcher script that execs a `hermes` there. A Hermes from elsewhere
 *  could migrate this home's state to its own version. */
export function hermesExeOwnedBy(
  exe: string,
  root: string,
  deps: { realpath?: (p: string) => string; readSmall?: (p: string) => string | null } = {},
): boolean {
  const real = deps.realpath ?? ((p: string) => fs.realpathSync(p));
  const install = path.join(root, 'hermes-agent');
  let installReal = install;
  try {
    installReal = real(install);
  } catch {
    /* compare as written */
  }
  const inside = (p: string): boolean => p === installReal || p.startsWith(installReal + path.sep) || p.startsWith(install + path.sep);
  try {
    if (inside(real(exe))) return true;
  } catch {
    return false;
  }
  const text = (deps.readSmall ?? readSmallText)(exe);
  if (text === null || !text.startsWith('#!')) return false;
  // `exec "<root>/hermes-agent/venv/bin/hermes" "$@"` (the installer's launcher).
  for (const m of text.matchAll(/(["']?)(\/[^"'\s]+\/hermes)\1/g)) {
    if (inside(m[2])) return true;
  }
  return false;
}

function readSmallText(p: string): string | null {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > LAUNCHER_MAX_BYTES) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** The variable names a `.env` text sets (`NAME=…`, `export NAME=…`),
 *  without their values. Pure. */
export function envNames(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** The names in the profile's `.env` (never a value), or [] when it has none. */
function readEnvNames(file: string): string[] {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 1024 * 1024) return [];
    return envNames(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

const truthy = (v: unknown): boolean => v === true || v === 1 || (typeof v === 'string' && /^(true|yes|on|1)$/i.test(v.trim()));
const falsy = (v: unknown): boolean => v === false || v === 0 || (typeof v === 'string' && /^(false|no|off|0)$/i.test(v.trim()));

/** The platforms a Hermes `platforms` block turns on (`<name>.enabled`), and
 *  the ones it turns off explicitly. `local` is the terminal, not a
 *  messenger. Pure. */
export function configuredPlatforms(...blocks: unknown[]): { on: string[]; off: string[] } {
  const on = new Set<string>();
  const off = new Set<string>();
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const [name, cfg] of Object.entries(block as Record<string, unknown>)) {
      if (name === 'local' || !cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
      const enabled = (cfg as Record<string, unknown>).enabled;
      if (truthy(enabled)) on.add(name);
      else if (falsy(enabled)) off.add(name);
    }
  }
  return { on: [...on], off: [...off] };
}

/** Hermes's approvals.mode as Hermes reads it (tools/approval.py
 *  `_normalize_approval_mode`). Pure. */
export function hermesApprovalMode(v: unknown): 'manual' | 'smart' | 'off' {
  if (typeof v === 'boolean') return v ? 'manual' : 'off';
  if (typeof v === 'string') {
    const m = v.trim().toLowerCase();
    if (m === 'smart' || m === 'off') return m;
  }
  return 'manual';
}

/** MCP server names wmux refuses in the owner's config: a wmux server there
 *  would hand the bot wmux's operator tools. */
const WMUX_MCP_NAMES = new Set(['wmux', 'mcp-wmux', 'mcp_wmux']);

export interface MyHermesReadinessDeps {
  home: string;
  platform: NodeJS.Platform;
  resolveExe: () => string | null;
  /** Base environment (default process.env), for whoever spawns Hermes later. */
  baseEnv?: NodeJS.ProcessEnv;
  isDir?: (p: string) => boolean;
  /** A small text file's content, or null when it is missing or unreadable
   *  (default: fs, at most 1 MiB). */
  readText?: (file: string) => string | null;
  /** Whether a PID is alive (default: signal 0). */
  pidAlive?: (pid: number) => boolean;
  ownedBy?: (exe: string, root: string) => boolean;
  envNamesOf?: (file: string) => string[];
}

/** At most this much of a file is read (the version module, config.yaml). */
const TEXT_MAX_BYTES = 1024 * 1024;

function readTextFile(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > TEXT_MAX_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The install a profile's `hermes` runs (hermesExeOwnedBy pins it). Pure. */
export function myHermesInstallDir(root: string): string {
  return path.join(root, 'hermes-agent');
}

export { parseInstallVersion };

/** Whether the install's venv holds the `acp` package Hermes's ACP adapter
 *  imports: true, false, or null when the venv cannot be read. */
export function installHasAcp(installDir: string, isDirFn: (p: string) => boolean = isDir): boolean | null {
  const lib = path.join(installDir, 'venv', 'lib');
  let pythons: string[];
  try {
    pythons = fs.readdirSync(lib).filter((n) => /^python3(\.\d+)?$/.test(n));
  } catch {
    return null;
  }
  if (pythons.length === 0) return null;
  return pythons.some((py) => isDirFn(path.join(lib, py, 'site-packages', 'acp')));
}

/** A profile's config.yaml as Hermes's PyYAML reads it (YAML 1.1: `off` is
 *  false), or null when it is not a mapping. Throws when it does not parse. */
export function parseHermesConfig(text: string): Record<string, unknown> | null {
  const doc: unknown = YAML.parse(text, { version: '1.1' });
  if (doc === null || doc === undefined) return {};
  return typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
}

/** `cfg[a][b]…`, or undefined. Pure. */
function pick(cfg: Record<string, unknown>, ...keys: string[]): unknown {
  let v: unknown = cfg;
  for (const k of keys) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function notReady(reason: MyHermesNotReadyReason, message: string, extra: Partial<MyHermesReadiness> = {}): MyHermesReadiness {
  return { ready: false, reason, message, notices: [], ...extra };
}

/** Whether `profile` of the owner's Hermes could serve a bot, read-only.
 *  Never throws, never writes. */
export async function myHermesReadiness(profile: string, deps: MyHermesReadinessDeps): Promise<MyHermesReadiness> {
  try {
    if (deps.platform === 'win32') return notReady('unsupported-os', 'My Hermes runs on macOS and Linux in this version.');
    if (!HERMES_PROFILE_RE.test(profile)) return notReady('profile-missing', 'That is not a Hermes profile name.');
    const exe = deps.resolveExe();
    if (!exe) return notReady('not-installed', 'Hermes is not installed (no hermes executable found).');
    const dir = myHermesProfileDir(deps.home, profile);
    if (!(deps.isDir ?? isDir)(dir)) return notReady('profile-missing', `No Hermes profile ${profile} was found.`);
    const root = myHermesRoot(deps.home);
    if (!(deps.ownedBy ?? hermesExeOwnedBy)(exe, root)) {
      return notReady('foreign-install', `The hermes wmux found (${exe}) is not the one installed in ~/.hermes.`);
    }
    const readText = deps.readText ?? readTextFile;
    const install = myHermesInstallDir(root);
    const versionText = readText(path.join(install, 'hermes_cli', '__init__.py'));
    const version = versionText === null ? null : parseInstallVersion(versionText);
    if (!version) return notReady('unknown', 'wmux could not read the version of the Hermes installed in ~/.hermes.');
    const status = hermesVersionStatus(version);
    if (status === 'outdated') return notReady('outdated', `Hermes ${version} is older than ${HERMES_VERSION_MIN}. Update it with \`${HERMES_UPDATE_COMMAND}\`.`, { version });
    if (status === 'unsupported') return notReady('unsupported', `Hermes ${version} is newer than the versions wmux was tested with (below ${HERMES_VERSION_BELOW}).`, { version });
    const acp = installHasAcp(install, deps.isDir ?? isDir);
    if (acp === null) return notReady('unknown', 'wmux could not read the Hermes install in ~/.hermes.', { version });
    if (!acp) return notReady('acp-missing', 'Hermes\'s ACP support is missing from its install.', { version });

    const cfgText = readText(path.join(dir, 'config.yaml'));
    if (cfgText === null) return notReady('unknown', 'wmux could not read this Hermes profile\'s config.yaml.', { version });
    let cfg: Record<string, unknown> | null;
    try {
      cfg = parseHermesConfig(cfgText);
    } catch {
      cfg = null;
    }
    if (!cfg) return notReady('unknown', 'wmux could not read this Hermes profile\'s config.yaml.', { version });
    // Hermes's defaults for a key the file leaves out (DEFAULT_CONFIG).
    const model = pick(cfg, 'model');
    const approvals = pick(cfg, 'approvals', 'mode') ?? 'smart';
    const mcpServers = pick(cfg, 'mcp_servers');
    const allowlist = pick(cfg, 'command_allowlist');
    const platforms = pick(cfg, 'platforms');
    const gatewayPlatforms = pick(cfg, 'gateway', 'platforms');

    const notices: MyHermesNotice[] = [];
    const mode = hermesApprovalMode(approvals);
    if (mode === 'smart') notices.push({ kind: 'approvals-smart' });
    if (Array.isArray(allowlist) && allowlist.length > 0) notices.push({ kind: 'allowlist', count: allowlist.length });
    const servers = mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers) ? Object.keys(mcpServers) : [];
    const wmuxServer = servers.find((s) => WMUX_MCP_NAMES.has(s.toLowerCase()));
    const others = servers.filter((s) => !WMUX_MCP_NAMES.has(s.toLowerCase()));
    if (others.length > 0) notices.push({ kind: 'mcp-servers', names: others.slice(0, 20) });
    const base = { version, notices };

    if (!hermesHasModel(model)) return notReady('no-model', 'This Hermes has no model set.', base);
    if (mode === 'off') return notReady('approvals-off', 'Approvals are off in this Hermes (approvals.mode: off), so every command would run without asking.', base);
    if (wmuxServer) {
      return notReady('wmux-mcp', `This Hermes has an MCP server named ${wmuxServer}, which would give the bot wmux's own tools. Remove it from ${profile === MY_HERMES_DEFAULT_PROFILE ? '~/.hermes' : `~/.hermes/profiles/${profile}`}/config.yaml.`, base);
    }
    const switches = configuredPlatforms(gatewayPlatforms, platforms);
    const fromEnv = (deps.envNamesOf ?? readEnvNames)(path.join(dir, '.env'))
      .map((n) => HERMES_MESSENGER_TOKEN_ENV[n])
      .filter((p): p is string => typeof p === 'string' && !switches.off.includes(p));
    const messengers = [...new Set([...switches.on, ...fromEnv])].sort();
    if (messengers.length > 0) {
      return notReady('messengers', `This Hermes connects to ${messengers.join(', ')}.`, { ...base, platforms: messengers });
    }
    const state = readHermesGatewayState(dir);
    const live = state ? Object.keys(state.platforms).filter((p) => p !== 'local') : [];
    if (state && live.length > 0 && (deps.pidAlive ?? defaultPidAlive)(state.pid)) {
      return notReady('gateway-messengers', `This Hermes's gateway is running ${live.slice(0, 5).join(', ')}.`, { ...base, platforms: live.slice(0, 5).sort() });
    }
    return { ready: true, ...base };
  } catch (err) {
    return notReady('unknown', `Hermes could not be checked (${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}).`);
  }
}

/** The app's checks: the real home and PATH. */
export function defaultMyHermesDeps(): MyHermesReadinessDeps {
  return { home: os.homedir(), platform: process.platform, resolveExe: () => resolveHermesExecutable() };
}

/** How long an answer serves the picker's re-asks; a Check again is fresh. */
const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; value: MyHermesReadiness }>();
const inFlight = new Map<string, Promise<MyHermesReadiness>>();

/** `myHermesReadiness`, one check per profile at a time, cached briefly. */
export function myHermesReadinessCached(profile: string, fresh: boolean, deps: MyHermesReadinessDeps = defaultMyHermesDeps(), now: () => number = Date.now): Promise<MyHermesReadiness> {
  const hit = cache.get(profile);
  if (!fresh && hit && now() - hit.at < CACHE_MS) return Promise.resolve(hit.value);
  const running = inFlight.get(profile);
  if (running) return running;
  const p = myHermesReadiness(profile, deps).then((value) => {
    cache.set(profile, { at: now(), value });
    return value;
  }).finally(() => inFlight.delete(profile));
  inFlight.set(profile, p);
  return p;
}

/** Forget the cached answers (tests). */
export function clearMyHermesCache(): void {
  cache.clear();
  inFlight.clear();
}
