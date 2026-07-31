import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { CODEX_NOTIFY_BASENAME } from './configIO';
import {
  readCodexNotifyStatus,
  registerCodexNotify,
  type CodexNotifyStatus,
  type RegisterNotifyResult,
} from './mcpRegistration';

/** Stable bundle/install names for first-party lifecycle integrations. */
export const OPENCODE_PLUGIN_BUNDLE_BASENAME = 'wmux-opencode-plugin.js';
export const OPENCODE_PLUGIN_INSTALL_BASENAME = 'wmux.js';
export const CODEX_NOTIFY_MANAGED_MARKER = 'wmux ↔ Codex CLI notify bridge';
export const OPENCODE_PLUGIN_MANAGED_MARKER = 'wmux-managed: opencode-lifecycle-bridge';

export type LifecycleAssetState =
  | 'current'
  | 'missing'
  | 'stale'
  | 'foreign'
  | 'source-missing'
  | 'error';

export interface LifecycleAssetSpec {
  sourcePath: string | null;
  destinationPath: string;
  /** Any one marker identifies an older or current wmux-owned destination. */
  ownershipMarkers: readonly string[];
}

export interface LifecycleAssetStatus {
  sourcePath: string | null;
  destinationPath: string;
  state: LifecycleAssetState;
  error: string | null;
}

export interface LifecycleAssetInstallOutcome extends LifecycleAssetStatus {
  action: 'none' | 'installed' | 'refreshed';
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** Read-only freshness/ownership check. Never creates a directory or throws. */
export function inspectLifecycleAsset(spec: LifecycleAssetSpec): LifecycleAssetStatus {
  const base = {
    sourcePath: spec.sourcePath,
    destinationPath: spec.destinationPath,
    error: null,
  };
  if (!spec.sourcePath || !fs.existsSync(spec.sourcePath)) {
    return { ...base, state: 'source-missing' };
  }

  let source: Buffer;
  try {
    source = fs.readFileSync(spec.sourcePath);
  } catch (error) {
    return { ...base, state: 'error', error: String(error) };
  }

  let destination: Buffer;
  try {
    destination = fs.readFileSync(spec.destinationPath);
  } catch (error) {
    if (isMissingError(error)) return { ...base, state: 'missing' };
    return { ...base, state: 'error', error: String(error) };
  }

  if (source.equals(destination)) return { ...base, state: 'current' };
  const destinationText = destination.toString('utf8');
  const owned = spec.ownershipMarkers.some((marker) => destinationText.includes(marker));
  return { ...base, state: owned ? 'stale' : 'foreign' };
}

/**
 * Install or refresh one wmux-owned lifecycle asset atomically. A destination
 * without a wmux marker is reported as foreign and is never overwritten.
 */
export function installLifecycleAsset(spec: LifecycleAssetSpec): LifecycleAssetInstallOutcome {
  const before = inspectLifecycleAsset(spec);
  if (before.state !== 'missing' && before.state !== 'stale') {
    return { ...before, action: 'none' };
  }

  try {
    const source = fs.readFileSync(spec.sourcePath as string);
    const destinationDir = path.dirname(spec.destinationPath);
    if (!fs.existsSync(destinationDir)) {
      fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
    }
    const tempPath = `${spec.destinationPath}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tempPath, source, { mode: 0o600 });
    try {
      fs.renameSync(tempPath, spec.destinationPath);
    } catch (error) {
      try { fs.unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
      throw error;
    }
    return {
      sourcePath: spec.sourcePath,
      destinationPath: spec.destinationPath,
      state: 'current',
      error: null,
      action: before.state === 'missing' ? 'installed' : 'refreshed',
    };
  } catch (error) {
    return {
      sourcePath: spec.sourcePath,
      destinationPath: spec.destinationPath,
      state: 'error',
      error: String(error),
      action: 'none',
    };
  }
}

/** Locate one bundled lifecycle asset from CLI, packaged, or repo layouts. */
export function findLifecycleAssetSourceFrom(
  startDir: string,
  bundleBasename: string,
  devRelativePath: readonly string[],
): string | null {
  const candidates = [
    bundleBasename,
    path.join('cli-bundle', bundleBasename),
    // A source checkout is authoritative in development. Checking it before
    // dist prevents an old build from downgrading an installed integration.
    path.join(...devRelativePath),
    path.join('dist', 'cli-bundle', bundleBasename),
  ];
  let current = startDir;
  for (let i = 0; i < 6; i++) {
    for (const relative of candidates) {
      const candidate = path.join(current, relative);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export interface LifecycleIntegrationPaths {
  home: string;
  codex: LifecycleAssetSpec;
  opencode: LifecycleAssetSpec;
}

function resolveOpenCodeConfigHome(home: string): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  return xdgConfigHome && path.isAbsolute(xdgConfigHome)
    ? xdgConfigHome
    : path.join(home, '.config');
}

export function resolveLifecycleIntegrationPaths(home: string, startDir: string): LifecycleIntegrationPaths {
  return {
    home,
    codex: {
      sourcePath: findLifecycleAssetSourceFrom(
        startDir,
        CODEX_NOTIFY_BASENAME,
        ['integrations', 'codex', 'bin', CODEX_NOTIFY_BASENAME],
      ),
      destinationPath: path.join(home, '.wmux', 'hooks', CODEX_NOTIFY_BASENAME),
      ownershipMarkers: [CODEX_NOTIFY_MANAGED_MARKER],
    },
    opencode: {
      sourcePath: findLifecycleAssetSourceFrom(
        startDir,
        OPENCODE_PLUGIN_BUNDLE_BASENAME,
        ['integrations', 'opencode', 'plugins', OPENCODE_PLUGIN_INSTALL_BASENAME],
      ),
      destinationPath: path.join(
        resolveOpenCodeConfigHome(home),
        'opencode',
        'plugins',
        OPENCODE_PLUGIN_INSTALL_BASENAME,
      ),
      ownershipMarkers: [OPENCODE_PLUGIN_MANAGED_MARKER, 'wmux ↔ OpenCode plugin bridge'],
    },
  };
}

export interface LifecycleCodexNotifyStatus extends Omit<CodexNotifyStatus, 'state'> {
  /** stale = wmux-shaped config points somewhere other than the managed current file. */
  state: CodexNotifyStatus['state'] | 'stale';
}

export interface LifecycleIntegrationsStatus {
  codexBridge: LifecycleAssetStatus;
  codexNotify: LifecycleCodexNotifyStatus;
  opencodePlugin: LifecycleAssetStatus;
}

const normalizePath = (value: string): string => value.replace(/\\/g, '/');

export function statusLifecycleIntegrations(paths: LifecycleIntegrationPaths): LifecycleIntegrationsStatus {
  const rawNotify = readCodexNotifyStatus(paths.home);
  let codexNotify: LifecycleCodexNotifyStatus = rawNotify;
  if (rawNotify.state === 'wmux') {
    const configuredPath = rawNotify.path;
    const pathMatches = !!configuredPath
      && normalizePath(configuredPath) === normalizePath(paths.codex.destinationPath);
    const scriptExists = !!configuredPath && fs.existsSync(configuredPath);
    if (!pathMatches || !scriptExists) codexNotify = { ...rawNotify, state: 'stale' };
  }
  return {
    codexBridge: inspectLifecycleAsset(paths.codex),
    codexNotify,
    opencodePlugin: inspectLifecycleAsset(paths.opencode),
  };
}

export interface LifecycleIntegrationsInstallOutcome {
  ok: boolean;
  codexBridge: LifecycleAssetInstallOutcome;
  codexNotify: RegisterNotifyResult | null;
  opencodePlugin: LifecycleAssetInstallOutcome;
}

/** Install/refresh runtime assets and register Codex notify without clobbering conflicts. */
export function installLifecycleIntegrations(
  paths: LifecycleIntegrationPaths,
): LifecycleIntegrationsInstallOutcome {
  const codexBridge = installLifecycleAsset(paths.codex);
  const codexNotify = codexBridge.state === 'current'
    ? registerCodexNotify(paths.home, paths.codex.destinationPath)
    : null;
  const opencodePlugin = installLifecycleAsset(paths.opencode);
  const fatalStates = new Set<LifecycleAssetState>(['source-missing', 'error']);
  return {
    ok: !fatalStates.has(codexBridge.state) && !fatalStates.has(opencodePlugin.state),
    codexBridge,
    codexNotify,
    opencodePlugin,
  };
}
