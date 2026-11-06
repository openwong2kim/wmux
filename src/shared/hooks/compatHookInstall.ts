// Opt-in installer for the shared Claude-compatible hook bridge.
//
// Driven entirely by COMPAT_HOOK_FLAVOURS: the flavour row says where the CLI
// loads hooks from, which events to register and in which command form. Only
// the `owned-file` strategy is wired (GitHub Copilot CLI): wmux writes a file of
// its own into a directory the CLI scans, so no user settings file is ever
// parsed or rewritten, and uninstall is deleting that file.
//
// Idempotent by construction: install refreshes only a file whose every entry
// runs the shared bridge for this flavour (the ownership proof), reports
// anything else as foreign and leaves it alone, and writes nothing when the
// file is already current.
//
// Command form: when the native bridge (core/wmux-native) ships beside this
// code, its copy under ~/.wmux/hooks/ is what the entries run; otherwise they
// run `node` on the shared bridge script. Both are owned forms, so moving
// between them is a refresh.
//
// Honesty: "written" is all this module can say. Whether the CLI loads the file
// is the CLI's business; the bridge's per-flavour log under ~/.wmux/ is where
// the first real signal shows up.

import * as fs from 'fs';
import * as path from 'path';
import { writeJsonAtomic } from '../settingsFile';
import {
  findLifecycleAssetSourceFrom,
  installLifecycleAsset,
  inspectLifecycleAsset,
  type LifecycleAssetInstallOutcome,
  type LifecycleAssetSpec,
  type LifecycleAssetStatus,
} from '../lifecycleIntegrations';
import {
  COMPAT_HOOK_FLAVOURS,
  COMPAT_HOOK_FLAVOUR_IDS,
  NATIVE_HOOKS_MARKER,
  SHARED_HOOKS_BRIDGE_BASENAME,
  SHARED_HOOKS_BRIDGE_MARKER,
  compatHookExecArgs,
  compatHookNativeExecArgs,
  nativeHooksBasename,
  type CompatHookFlavourId,
} from './hookFlavours';

/** State of wmux's entry in the CLI's hook config. */
export type CompatHookConfigState =
  /** No wmux file (and nothing else) at the path. */
  | 'absent'
  /** wmux's file, byte-for-byte what install would write. */
  | 'current'
  /** wmux's file, but for another bridge path or an older event set. */
  | 'stale'
  /** Something at the path that wmux did not write. Never touched. */
  | 'foreign'
  /** Unreadable or not JSON. Never touched. */
  | 'malformed'
  /** The flavour has no wired installer. */
  | 'unsupported';

/** Where a flavour's config directory came from. */
export type CompatHookConfigDirSource =
  /** The flavour's default directory under the user's home. */
  | 'home'
  /** The flavour's `configDirEnv` (Copilot's COPILOT_HOME). */
  | 'env';

export interface CompatHookConfigDir {
  dir: string;
  source: CompatHookConfigDirSource;
}

export interface CompatHookPaths {
  home: string;
  /** The shared bridge, copied to ~/.wmux/hooks/ so the path survives updates. */
  bridge: LifecycleAssetSpec;
  /** The native bridge, copied beside it for the same reason; null when this
   *  build ships none. */
  nativeHooks: LifecycleAssetSpec | null;
  /**
   * Each owned-file flavour's config directory, resolved ONCE from the
   * environment this run was given, so install, remove and status all agree
   * on the directory the CLI itself reads.
   */
  configDirs: Partial<Record<CompatHookFlavourId, CompatHookConfigDir>>;
}

/**
 * The config directory a flavour's CLI reads: its env override when that is
 * set to a non-blank path (resolved against the cwd, as the CLI started from
 * the same shell would), else the default under `home`. Null for a flavour
 * with no owned-file installer.
 */
export function resolveCompatHookConfigDir(
  flavourId: CompatHookFlavourId,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): CompatHookConfigDir | null {
  const install = COMPAT_HOOK_FLAVOURS[flavourId].install;
  if (!install || install.strategy !== 'owned-file') return null;
  const override = install.configDirEnv ? env[install.configDirEnv]?.trim() : undefined;
  if (override) return { dir: path.resolve(override), source: 'env' };
  return { dir: path.join(home, ...install.configDir), source: 'home' };
}

/**
 * The staged native bridge: resources/native-hooks/ in a packaged app (the CLI
 * runs from resources/cli-bundle/), dist/native-hooks/ in a source checkout.
 */
export function findNativeHooksSource(startDir: string, platform: NodeJS.Platform = process.platform): string | null {
  const exe = nativeHooksBasename(platform);
  let current = startDir;
  for (let i = 0; i < 6; i++) {
    for (const relative of [path.join('native-hooks', exe), path.join('dist', 'native-hooks', exe)]) {
      const candidate = path.join(current, relative);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function resolveCompatHookPaths(
  home: string,
  startDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): CompatHookPaths {
  const configDirs: Partial<Record<CompatHookFlavourId, CompatHookConfigDir>> = {};
  for (const id of COMPAT_HOOK_FLAVOUR_IDS) {
    const resolved = resolveCompatHookConfigDir(id, home, env);
    if (resolved) configDirs[id] = resolved;
  }
  const nativeSource = findNativeHooksSource(startDir);
  return {
    home,
    configDirs,
    nativeHooks: nativeSource
      ? {
        sourcePath: nativeSource,
        destinationPath: path.join(home, '.wmux', 'hooks', nativeHooksBasename()),
        ownershipMarkers: [NATIVE_HOOKS_MARKER],
      }
      : null,
    bridge: {
      sourcePath: findLifecycleAssetSourceFrom(
        startDir,
        SHARED_HOOKS_BRIDGE_BASENAME,
        ['integrations', 'shared', 'bin', SHARED_HOOKS_BRIDGE_BASENAME],
      ),
      destinationPath: path.join(home, '.wmux', 'hooks', SHARED_HOOKS_BRIDGE_BASENAME),
      ownershipMarkers: [SHARED_HOOKS_BRIDGE_MARKER],
    },
  };
}

/** Where a flavour's wmux entry lives, or null when the flavour has no wired installer. */
export function compatHookConfigPath(
  flavourId: CompatHookFlavourId,
  paths: Pick<CompatHookPaths, 'configDirs'>,
): string | null {
  const install = COMPAT_HOOK_FLAVOURS[flavourId].install;
  const configDir = paths.configDirs[flavourId];
  if (!install || install.strategy !== 'owned-file' || !configDir) return null;
  return path.join(configDir.dir, ...install.file);
}

interface ExecLeaf {
  type: 'command';
  exec: string;
  args: string[];
  timeoutSec: number;
}

/**
 * The owned hook file for a flavour, as plain data. Exec form: `node` (or the
 * native bridge, when `nativePath` names it) spawned with an argv and no shell,
 * so there is no quoting to get wrong under PowerShell, cmd or bash (#1882).
 * The event name rides in argv because not every dialect repeats it in the
 * payload.
 */
export function buildOwnedHookFile(
  flavourId: CompatHookFlavourId,
  bridgePath: string,
  nativePath: string | null = null,
): { version: 1; hooks: Record<string, ExecLeaf[]> } {
  const install = COMPAT_HOOK_FLAVOURS[flavourId].install;
  if (!install || install.strategy !== 'owned-file') {
    throw new Error(`flavour ${flavourId} has no owned-file installer`);
  }
  const hooks: Record<string, ExecLeaf[]> = {};
  for (const event of install.register) {
    hooks[event] = [{
      type: 'command',
      exec: nativePath ?? 'node',
      args: nativePath ? compatHookNativeExecArgs(flavourId, event) : compatHookExecArgs(bridgePath, flavourId, event),
      timeoutSec: install.timeoutSec,
    }];
  }
  return { version: 1, hooks };
}

function safeReviver(key: string, value: unknown): unknown {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return value;
}

const basename = (p: string): string => path.basename(p.replace(/\\/g, '/'));

/** One entry wmux wrote: `node <shared bridge> <flavour> …`, or
 *  `<wmux-native> hook <flavour> …`. */
function isOwnedLeaf(leaf: unknown, flavourId: CompatHookFlavourId): boolean {
  const { exec, args } = (leaf ?? {}) as { exec?: unknown; args?: unknown };
  if (!Array.isArray(args) || typeof args[0] !== 'string') return false;
  if (basename(args[0]) === SHARED_HOOKS_BRIDGE_BASENAME) return args[1] === flavourId;
  const native = typeof exec === 'string' && ['wmux-native', 'wmux-native.exe'].includes(basename(exec));
  return native && args[0] === 'hook' && args[1] === flavourId;
}

/**
 * True when every hook entry in `parsed` runs the shared bridge (Node or
 * native) for this flavour and nothing else is in the file. One foreign entry, or one key wmux
 * never writes, makes the whole file foreign: the user put something there.
 */
function isOwnedHookFile(parsed: unknown, flavourId: CompatHookFlavourId): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).some((k) => k !== 'version' && k !== 'hooks')) return false;
  const hooks = obj.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  let leaves = 0;
  for (const entries of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(entries)) return false;
    for (const leaf of entries) {
      if (!isOwnedLeaf(leaf, flavourId)) return false;
      leaves++;
    }
  }
  return leaves > 0;
}

/** The installed native bridge the entries should run, or null for the Node form. */
export function activeNativeHooksPath(paths: Pick<CompatHookPaths, 'nativeHooks'>): string | null {
  const spec = paths.nativeHooks;
  return spec && inspectLifecycleAsset(spec).state === 'current' ? spec.destinationPath : null;
}

export function inspectCompatHookConfig(
  flavourId: CompatHookFlavourId,
  paths: Pick<CompatHookPaths, 'configDirs'>,
  bridgePath: string,
  nativePath: string | null = null,
): { state: CompatHookConfigState; configPath: string | null } {
  const configPath = compatHookConfigPath(flavourId, paths);
  if (!configPath) return { state: 'unsupported', configPath: null };
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { state: 'absent', configPath };
    return { state: 'malformed', configPath };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, safeReviver);
  } catch {
    return { state: 'malformed', configPath };
  }
  if (!isOwnedHookFile(parsed, flavourId)) return { state: 'foreign', configPath };
  const wanted = JSON.stringify(buildOwnedHookFile(flavourId, bridgePath, nativePath));
  return { state: JSON.stringify(parsed) === wanted ? 'current' : 'stale', configPath };
}

export interface CompatHookInstallOutcome {
  ok: boolean;
  flavour: CompatHookFlavourId;
  bridge: LifecycleAssetInstallOutcome;
  /** The native bridge copy, or null when this build ships none. */
  native: LifecycleAssetInstallOutcome | null;
  configPath: string | null;
  /** State BEFORE this run. */
  before: CompatHookConfigState;
  action: 'none' | 'installed' | 'refreshed';
  error: string | null;
}

/**
 * Copy the native bridge when this build ships one, executable by its owner
 * only. Its copy is what the entries run, so a copy that is not current (a
 * foreign file in the way, a locked exe on Windows) leaves them on Node.
 */
function installNativeHooks(spec: LifecycleAssetSpec | null): LifecycleAssetInstallOutcome | null {
  if (!spec) return null;
  const outcome = installLifecycleAsset(spec);
  if (outcome.state !== 'current') return outcome;
  try {
    fs.chmodSync(spec.destinationPath, 0o700);
  } catch (error) {
    return { ...outcome, state: 'error', error: String(error) };
  }
  return outcome;
}

/**
 * Copy the shared bridge (and the native one, when shipped) to ~/.wmux/hooks/
 * and write the flavour's owned hook file pointing at it. Never overwrites a
 * foreign or malformed file.
 */
export function installCompatHooks(flavourId: CompatHookFlavourId, paths: CompatHookPaths): CompatHookInstallOutcome {
  const configPath = compatHookConfigPath(flavourId, paths);
  const bridgeDest = paths.bridge.destinationPath;
  if (!configPath) {
    const bridge: LifecycleAssetInstallOutcome = { ...inspectLifecycleAsset(paths.bridge), action: 'none' };
    return { flavour: flavourId, configPath, ok: false, bridge, native: null, before: 'unsupported', action: 'none', error: null };
  }
  const bridge = installLifecycleAsset(paths.bridge);
  const native = installNativeHooks(paths.nativeHooks);
  const nativePath = native?.state === 'current' ? native.destinationPath : null;
  const base = { flavour: flavourId, configPath, native };
  const { state: before } = inspectCompatHookConfig(flavourId, paths, bridgeDest, nativePath);
  if (bridge.state !== 'current') {
    // A config pointing at a bridge that is not there would spawn `node` on a
    // missing file for every event. Write nothing.
    return { ...base, ok: false, bridge, before, action: 'none', error: bridge.error };
  }
  if (before === 'current') return { ...base, ok: true, bridge, before, action: 'none', error: null };
  if (before === 'foreign' || before === 'malformed') {
    return { ...base, ok: false, bridge, before, action: 'none', error: null };
  }
  try {
    writeJsonAtomic(configPath, buildOwnedHookFile(flavourId, bridgeDest, nativePath));
  } catch (error) {
    return { ...base, ok: false, bridge, before, action: 'none', error: String(error) };
  }
  return { ...base, ok: true, bridge, before, action: before === 'absent' ? 'installed' : 'refreshed', error: null };
}

export interface CompatHookRemoveOutcome {
  ok: boolean;
  flavour: CompatHookFlavourId;
  configPath: string | null;
  before: CompatHookConfigState;
  removed: boolean;
  error: string | null;
}

/**
 * Delete the flavour's owned hook file. A foreign or malformed file is left in
 * place. The shared bridge copy stays: other flavours may run it.
 */
export function removeCompatHooks(flavourId: CompatHookFlavourId, paths: CompatHookPaths): CompatHookRemoveOutcome {
  const { state: before, configPath } = inspectCompatHookConfig(
    flavourId, paths, paths.bridge.destinationPath, activeNativeHooksPath(paths),
  );
  const base = { flavour: flavourId, configPath, before };
  if (before !== 'current' && before !== 'stale') {
    return { ...base, ok: before !== 'unsupported', removed: false, error: null };
  }
  try {
    fs.unlinkSync(configPath as string);
  } catch (error) {
    return { ...base, ok: false, removed: false, error: String(error) };
  }
  return { ...base, ok: true, removed: true, error: null };
}

export interface CompatHookStatus {
  flavour: CompatHookFlavourId;
  verified: 'live' | 'docs';
  bridge: LifecycleAssetStatus;
  /** The native bridge copy, or null when this build ships none. */
  native: LifecycleAssetStatus | null;
  configPath: string | null;
  /** Whether `configPath` came from the CLI's env override (COPILOT_HOME) or the
   *  default under the home directory. Null when the flavour has no installer. */
  configDirSource: CompatHookConfigDirSource | null;
  config: CompatHookConfigState;
}

export function statusCompatHooks(flavourId: CompatHookFlavourId, paths: CompatHookPaths): CompatHookStatus {
  const { state, configPath } = inspectCompatHookConfig(
    flavourId, paths, paths.bridge.destinationPath, activeNativeHooksPath(paths),
  );
  return {
    flavour: flavourId,
    verified: COMPAT_HOOK_FLAVOURS[flavourId].verified,
    bridge: inspectLifecycleAsset(paths.bridge),
    native: paths.nativeHooks ? inspectLifecycleAsset(paths.nativeHooks) : null,
    configPath,
    configDirSource: paths.configDirs[flavourId]?.source ?? null,
    config: state,
  };
}
