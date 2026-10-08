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
  SHARED_HOOKS_BRIDGE_BASENAME,
  SHARED_HOOKS_BRIDGE_MARKER,
  compatHookExecArgs,
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

export interface CompatHookPaths {
  home: string;
  /** The shared bridge, copied to ~/.wmux/hooks/ so the path survives updates. */
  bridge: LifecycleAssetSpec;
}

export function resolveCompatHookPaths(home: string, startDir: string): CompatHookPaths {
  return {
    home,
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
export function compatHookConfigPath(flavourId: CompatHookFlavourId, home: string): string | null {
  const install = COMPAT_HOOK_FLAVOURS[flavourId].install;
  if (!install || install.strategy !== 'owned-file') return null;
  return path.join(home, ...install.userFile);
}

interface ExecLeaf {
  type: 'command';
  exec: string;
  args: string[];
  timeoutSec: number;
}

/**
 * The owned hook file for a flavour, as plain data. Exec form: `node` spawned
 * with an argv and no shell, so there is no quoting to get wrong under
 * PowerShell, cmd or bash (#1882). The event name rides in argv because not
 * every dialect repeats it in the payload.
 */
export function buildOwnedHookFile(
  flavourId: CompatHookFlavourId,
  bridgePath: string,
): { version: 1; hooks: Record<string, ExecLeaf[]> } {
  const install = COMPAT_HOOK_FLAVOURS[flavourId].install;
  if (!install || install.strategy !== 'owned-file') {
    throw new Error(`flavour ${flavourId} has no owned-file installer`);
  }
  const hooks: Record<string, ExecLeaf[]> = {};
  for (const event of install.register) {
    hooks[event] = [{
      type: 'command',
      exec: 'node',
      args: compatHookExecArgs(bridgePath, flavourId, event),
      timeoutSec: install.timeoutSec,
    }];
  }
  return { version: 1, hooks };
}

function safeReviver(key: string, value: unknown): unknown {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return value;
}

/**
 * True when every hook entry in `parsed` runs the shared bridge for this
 * flavour and nothing else is in the file. One foreign entry, or one key wmux
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
      const args = (leaf as { args?: unknown })?.args;
      if (!Array.isArray(args) || typeof args[0] !== 'string') return false;
      if (path.basename(args[0].replace(/\\/g, '/')) !== SHARED_HOOKS_BRIDGE_BASENAME) return false;
      if (args[1] !== flavourId) return false;
      leaves++;
    }
  }
  return leaves > 0;
}

export function inspectCompatHookConfig(
  flavourId: CompatHookFlavourId,
  home: string,
  bridgePath: string,
): { state: CompatHookConfigState; configPath: string | null } {
  const configPath = compatHookConfigPath(flavourId, home);
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
  const wanted = JSON.stringify(buildOwnedHookFile(flavourId, bridgePath));
  return { state: JSON.stringify(parsed) === wanted ? 'current' : 'stale', configPath };
}

export interface CompatHookInstallOutcome {
  ok: boolean;
  flavour: CompatHookFlavourId;
  bridge: LifecycleAssetInstallOutcome;
  configPath: string | null;
  /** State BEFORE this run. */
  before: CompatHookConfigState;
  action: 'none' | 'installed' | 'refreshed';
  error: string | null;
}

/**
 * Copy the shared bridge to ~/.wmux/hooks/ and write the flavour's owned hook
 * file pointing at it. Never overwrites a foreign or malformed file.
 */
export function installCompatHooks(flavourId: CompatHookFlavourId, paths: CompatHookPaths): CompatHookInstallOutcome {
  const configPath = compatHookConfigPath(flavourId, paths.home);
  const bridgeDest = paths.bridge.destinationPath;
  const base = { flavour: flavourId, configPath };
  if (!configPath) {
    const bridge: LifecycleAssetInstallOutcome = { ...inspectLifecycleAsset(paths.bridge), action: 'none' };
    return { ...base, ok: false, bridge, before: 'unsupported', action: 'none', error: null };
  }
  const bridge = installLifecycleAsset(paths.bridge);
  const { state: before } = inspectCompatHookConfig(flavourId, paths.home, bridgeDest);
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
    writeJsonAtomic(configPath, buildOwnedHookFile(flavourId, bridgeDest));
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
  const { state: before, configPath } = inspectCompatHookConfig(flavourId, paths.home, paths.bridge.destinationPath);
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
  configPath: string | null;
  config: CompatHookConfigState;
}

export function statusCompatHooks(flavourId: CompatHookFlavourId, paths: CompatHookPaths): CompatHookStatus {
  const { state, configPath } = inspectCompatHookConfig(flavourId, paths.home, paths.bridge.destinationPath);
  return {
    flavour: flavourId,
    verified: COMPAT_HOOK_FLAVOURS[flavourId].verified,
    bridge: inspectLifecycleAsset(paths.bridge),
    configPath,
    config: state,
  };
}
