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
// code, its copy under ~/.wmux/hooks/ is what the entries run, once it has
// shown it runs here; otherwise they run `node` on the shared bridge script.
// Both are owned forms, so moving between them is a refresh.
//
// Honesty: "written" is all this module can say. Whether the CLI loads the file
// is the CLI's business; the bridge's per-flavour log under ~/.wmux/ is where
// the first real signal shows up.

import * as fs from 'fs';
import * as path from 'path';
import { writeJsonAtomic } from '../settingsFile';
import {
  expectationKey,
  prepareProbedNative,
  recordedVerdictOf,
  runProbe,
  type ProbeExpectation,
} from '../probedNative';
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
 * The native bridge to install, from two known roots only, since the installer
 * copies and runs what it finds. Both sit inside the roots where wmux-native
 * counts as wmux's own (#3129: below .wmux/, an app resources/ directory, or
 * core/<crate>/target/(debug|release)/):
 *   - a packaged app: resources/native-hooks/ beside the CLI bundle it runs
 *     from (resources/cli-bundle/);
 *   - a source checkout: core/wmux-native/target/release/, seen from the
 *     checkout root or from its dist/cli-bundle/.
 * dist/native-hooks/ (the forge stage) and target/<triple>/ (a cross build)
 * are build inputs, never runtime sources. No other directory is looked at.
 */
export function findNativeHooksSource(startDir: string, platform: NodeJS.Platform = process.platform): string | null {
  const exe = nativeHooksBasename(platform);
  const parent = path.dirname(startDir);
  const candidates: string[] = [];
  const inCliBundle = path.basename(startDir) === 'cli-bundle';
  if (inCliBundle && path.basename(parent).toLowerCase() === 'resources') {
    candidates.push(path.join(parent, 'native-hooks', exe));
  }
  const repo = inCliBundle && path.basename(parent) === 'dist' ? path.dirname(parent) : startDir;
  if (fs.existsSync(path.join(repo, 'core', 'wmux-native', 'Cargo.toml'))) {
    candidates.push(path.join(repo, 'core', 'wmux-native', 'target', 'release', exe));
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
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
        // Runnable from the moment it appears: a hook may fire mid-refresh.
        mode: 0o700,
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
      // The same argv for both: an older wmux recognises its entries by it.
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

const basename = (p: string): string => path.basename(p.replace(/\\/g, '/'));

/** One entry wmux wrote: `<node | wmux-native> <shared bridge> <flavour> …`.
 *  The same rule every shipped wmux applies, so they agree on ownership. */
function isOwnedLeaf(leaf: unknown, flavourId: CompatHookFlavourId): boolean {
  const args = (leaf as { args?: unknown } | null)?.args;
  if (!Array.isArray(args) || typeof args[0] !== 'string') return false;
  return basename(args[0]) === SHARED_HOOKS_BRIDGE_BASENAME && args[1] === flavourId;
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

/**
 * Whether a copy runs here: a noexec home, an application-control policy or a
 * foreign libc would fail every hook event where `node <bridge>` works. Every
 * build answers `--version` with the marker line, the oldest included.
 */
const NATIVE_HOOKS_PROBE: ProbeExpectation = { contains: NATIVE_HOOKS_MARKER };
const NATIVE_HOOKS_PROBE_KEY = expectationKey(NATIVE_HOOKS_PROBE);
const NATIVE_HOOKS_PROBE_TIMEOUT_MS = 5000;

/**
 * The installed native bridge the entries should run, or null for the Node
 * form, from a status of its copy. Never runs the binary: the copy is offered
 * when its bytes have a recorded pass. A copy with no verdict recorded counts
 * when it is the shipped one: a wmux before the record kept a copy only once
 * it ran.
 */
function activeNativeHooksPath(spec: LifecycleAssetSpec | null, native: LifecycleAssetStatus | null): string | null {
  if (!spec || !native || (native.state !== 'current' && native.state !== 'stale')) return null;
  const verdict = recordedVerdictOf(spec.destinationPath, path.dirname(spec.destinationPath), NATIVE_HOOKS_PROBE_KEY);
  if (verdict) return verdict === 'pass' ? spec.destinationPath : null;
  return native.state === 'current' ? spec.destinationPath : null;
}

/** One line on which command the entries run, and why; for `setup-hooks`. */
function describeNativeHooks(
  flavourId: CompatHookFlavourId,
  shipped: boolean,
  native: LifecycleAssetStatus | LifecycleAssetInstallOutcome | null,
  active: string | null,
): string {
  const node = 'hooks run `node <bridge>`';
  const install = `wmux setup-hooks --agent ${flavourId}`;
  if (!shipped || !native) return `native hook bridge: not shipped with this build; ${node}`;
  const action = 'action' in native ? native.action : 'none';
  if (active && native.state === 'current') {
    return action === 'none'
      ? `native hook bridge: ${active} (up to date); hooks run it`
      : `native hook bridge: ${action} → ${active}; hooks run it`;
  }
  if (active) {
    // The copy in place runs; the shipped one did not replace it.
    return native.error
      ? `native hook bridge: ${active} kept (${native.error}); hooks run it`
      : `native hook bridge: ${active} is stale but runs (re-run \`${install}\`, with --reprobe if the new build failed its check); hooks run it`;
  }
  switch (native.state) {
    case 'current':
      // The shipped bytes, recorded as not running here.
      return `native hook bridge: not used (${native.destinationPath} did not run here when checked; \`${install} --reprobe\` checks again); ${node}`;
    case 'missing':
      return `native hook bridge: not installed (${native.destinationPath}); ${node}`;
    case 'stale':
      return `native hook bridge: ${native.destinationPath} is stale (re-run \`${install}\`); ${node}`;
    case 'foreign':
      return `native hook bridge: not used (${native.destinationPath} is not wmux-owned; left untouched); ${node}`;
    default:
      return `native hook bridge: not used (${native.error ?? native.state}); ${node}`;
  }
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
  /** The native bridge copy: null when this build ships none, or when the
   *  run stopped before it (foreign config, bridge not installed). */
  native: LifecycleAssetInstallOutcome | null;
  /** Which command the entries run and why, or null when nothing was decided. */
  nativeSummary: string | null;
  configPath: string | null;
  /** State BEFORE this run. */
  before: CompatHookConfigState;
  action: 'none' | 'installed' | 'refreshed';
  error: string | null;
}

export interface CompatHookInstallOptions {
  /** Run the copy's check again even when its bytes were judged before
   *  (`wmux setup-hooks --reprobe`). */
  reprobe?: boolean;
}

/**
 * Install the native bridge when this build ships one: the new bytes are
 * staged and run before they take the copy's name, under the lock of
 * ~/.wmux/hooks (see probedNative). A refresh whose bytes do not run here
 * leaves the copy in place, which is still offered when it ran before; with
 * nothing that runs, or a foreign file in the way, the entries stay on Node.
 */
async function installNativeHooks(
  spec: LifecycleAssetSpec | null,
  opts: CompatHookInstallOptions,
): Promise<{ outcome: LifecycleAssetInstallOutcome; active: string | null } | null> {
  if (!spec) return null;
  const before = inspectLifecycleAsset(spec);
  let probed = false;
  const result = await prepareProbedNative({
    sourcePath: spec.sourcePath,
    destinationPath: spec.destinationPath,
    recordDir: path.dirname(spec.destinationPath),
    line: NATIVE_HOOKS_PROBE_KEY,
    probe: (binary) => {
      probed = true;
      return runProbe(binary, ['--version'], NATIVE_HOOKS_PROBE, NATIVE_HOOKS_PROBE_TIMEOUT_MS);
    },
    ownershipMarkers: spec.ownershipMarkers,
    mode: spec.mode,
    reprobe: opts.reprobe,
  });
  const after = inspectLifecycleAsset(spec);
  // Nothing offered without a probe (the lock held elsewhere) proved nothing:
  // the copy in place is then judged as status judges it. Once a probe ran
  // and did not pass, even one that proved nothing (a copy that could not be
  // started), only a recorded pass, which prepareProbedNative already offers,
  // keeps the entries native.
  const active = result.binary ?? (probed ? null : activeNativeHooksPath(spec, after));
  if (active && after.state === 'current') {
    const action = before.state === 'missing' ? 'installed' : before.state === 'current' ? 'none' : 'refreshed';
    return { outcome: { ...after, action }, active };
  }
  if (active) return { outcome: { ...after, state: 'stale', error: result.reason ?? null, action: 'none' }, active };
  if (after.state === 'foreign' || after.state === 'source-missing') return { outcome: { ...after, action: 'none' }, active: null };
  return { outcome: { ...after, state: 'error', error: result.reason ?? after.error, action: 'none' }, active: null };
}

/**
 * Copy the shared bridge (and the native one, when shipped) to ~/.wmux/hooks/
 * and write the flavour's owned hook file pointing at it. Never overwrites a
 * foreign or malformed file.
 */
export async function installCompatHooks(
  flavourId: CompatHookFlavourId,
  paths: CompatHookPaths,
  opts: CompatHookInstallOptions = {},
): Promise<CompatHookInstallOutcome> {
  const configPath = compatHookConfigPath(flavourId, paths);
  const bridgeDest = paths.bridge.destinationPath;
  const stopped = { flavour: flavourId, configPath, native: null, nativeSummary: null, action: 'none' as const };
  if (!configPath) {
    const bridge: LifecycleAssetInstallOutcome = { ...inspectLifecycleAsset(paths.bridge), action: 'none' };
    return { ...stopped, ok: false, bridge, before: 'unsupported', error: null };
  }
  // A file wmux will not touch is decided before anything is copied or run;
  // ownership does not depend on which command form the entries use.
  const { state: owned } = inspectCompatHookConfig(flavourId, paths, bridgeDest);
  if (owned === 'foreign' || owned === 'malformed') {
    const bridge: LifecycleAssetInstallOutcome = { ...inspectLifecycleAsset(paths.bridge), action: 'none' };
    return { ...stopped, ok: false, bridge, before: owned, error: null };
  }
  const bridge = installLifecycleAsset(paths.bridge);
  if (bridge.state !== 'current') {
    // A config pointing at a bridge that is not there would spawn `node` on a
    // missing file for every event. Write nothing.
    return { ...stopped, ok: false, bridge, before: owned, error: bridge.error };
  }
  const installed = await installNativeHooks(paths.nativeHooks, opts);
  const native = installed?.outcome ?? null;
  const nativePath = installed?.active ?? null;
  const nativeSummary = describeNativeHooks(flavourId, !!paths.nativeHooks, native, nativePath);
  const base = { flavour: flavourId, configPath, native, nativeSummary, bridge };
  const { state: before } = inspectCompatHookConfig(flavourId, paths, bridgeDest, nativePath);
  if (before === 'current') return { ...base, ok: true, before, action: 'none', error: null };
  try {
    writeJsonAtomic(configPath, buildOwnedHookFile(flavourId, bridgeDest, nativePath));
  } catch (error) {
    return { ...base, ok: false, before, action: 'none', error: String(error) };
  }
  return { ...base, ok: true, before, action: before === 'absent' ? 'installed' : 'refreshed', error: null };
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
  const native = paths.nativeHooks ? inspectLifecycleAsset(paths.nativeHooks) : null;
  const { state: before, configPath } = inspectCompatHookConfig(
    flavourId, paths, paths.bridge.destinationPath, activeNativeHooksPath(paths.nativeHooks, native),
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
  /** Which command the entries run and why. */
  nativeSummary: string;
  configPath: string | null;
  /** Whether `configPath` came from the CLI's env override (COPILOT_HOME) or the
   *  default under the home directory. Null when the flavour has no installer. */
  configDirSource: CompatHookConfigDirSource | null;
  config: CompatHookConfigState;
}

export function statusCompatHooks(flavourId: CompatHookFlavourId, paths: CompatHookPaths): CompatHookStatus {
  // Read once, never run: status must not spawn the binary.
  const native = paths.nativeHooks ? inspectLifecycleAsset(paths.nativeHooks) : null;
  const active = activeNativeHooksPath(paths.nativeHooks, native);
  const { state, configPath } = inspectCompatHookConfig(flavourId, paths, paths.bridge.destinationPath, active);
  return {
    flavour: flavourId,
    verified: COMPAT_HOOK_FLAVOURS[flavourId].verified,
    bridge: inspectLifecycleAsset(paths.bridge),
    native,
    nativeSummary: describeNativeHooks(flavourId, !!paths.nativeHooks, native, active),
    configPath,
    configDirSource: paths.configDirs[flavourId]?.source ?? null,
    config: state,
  };
}
