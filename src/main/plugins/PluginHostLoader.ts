// PluginHostLoader — discovers UI plugin bundles under `~/.wmux/plugins/`
// and registers their declared capabilities with the existing trust stack.
//
// Discovery model (B-1 core): one directory per plugin, directory name ==
// manifest `name` == identity key in plugin-trust.json. A bundle is
//
//   ~/.wmux/plugins/<name>/manifest.json   (required, see shared/pluginHost)
//   ~/.wmux/plugins/<name>/**              (static assets, served read-only
//                                           over fmux-plugin://<name>/...)
//
// Loading a manifest is equivalent to the MCP `mcp.identify` +
// `mcp.declarePermissions` handshake: the declaration goes through
// PluginTrustStore.upsertDeclaration, so first-load plugins surface as
// `unconfirmed`, capability widening on update demotes `trusted` back to
// `unconfirmed`, and `denied` never regresses. The renderer host mounts UI
// contributions only for `trusted` plugins.

import * as fs from 'fs';
import * as path from 'path';
import { getWmuxHomeDir } from '../../shared/constants';
import {
  parsePluginManifest,
  requiredUiCapabilities,
  PLUGIN_NAME_REGEX,
  type PluginHostPluginSummary,
  type PluginManifest,
} from '../../shared/pluginHost';
import { parsePermissionList } from '../mcp/permissionGrammar';
import type { PluginTrustStore } from '../mcp/PluginTrustStore';

export interface LoadedHostPlugin {
  manifest: PluginManifest;
  /** Absolute, realpath-resolved bundle directory — the containment root
   *  the fmux-plugin:// protocol handler checks every request against. */
  dir: string;
}

export interface PluginLoadFailure {
  name: string;
  errors: string[];
}

export function getPluginsDir(): string {
  return path.join(getWmuxHomeDir(), 'plugins');
}

/**
 * Normalize a bundle-relative URL path inside `dir` (already realpathed),
 * or null when it escapes. Strictly-inside check: the bundle dir itself is
 * not servable, only files under it.
 *
 * Lexical-only: `path.resolve` collapses `..`/encoded traversal and the
 * strict-prefix check rejects escapes. This does NOT defend against a
 * symlink/junction *file inside* the bundle pointing back out — callers
 * that serve the file (the protocol handler) MUST additionally realpath
 * the result via `resolveWithinReal`. Used as-is only for existence checks
 * at load time, where following an in-bundle symlink is harmless.
 */
function resolveWithin(dir: string, urlPath: string): string | null {
  const decoded = urlPath.replace(/^\/+/, '');
  if (decoded.length === 0 || decoded.includes('\0')) return null;
  const resolved = path.resolve(dir, decoded);
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  if (!resolved.startsWith(prefix)) return null;
  return resolved;
}

/**
 * Like `resolveWithin`, then realpath the resolved target and re-check
 * containment. This closes the symlink-file escape: a file *inside* the
 * bundle that is a symlink/junction to an out-of-bundle target (e.g.
 * `bundle/leak.html -> C:\Users\x\.ssh\id_rsa`) passes the lexical check
 * but its realpath lands outside the bundle, so we reject it. `dir` is
 * already realpathed at load time, so comparing realpaths is apples to
 * apples. A non-existent target (realpath throws) returns null — the
 * protocol handler then 404s, same as a missing file.
 */
function resolveWithinReal(dir: string, urlPath: string): string | null {
  const lexical = resolveWithin(dir, urlPath);
  if (lexical === null) return null;
  let real: string;
  try {
    real = fs.realpathSync(lexical);
  } catch {
    return null;
  }
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  if (real !== lexical && !real.startsWith(prefix)) return null;
  return real;
}

export class PluginHostLoader {
  private plugins = new Map<string, LoadedHostPlugin>();
  private failures: PluginLoadFailure[] = [];

  constructor(
    private readonly trustStore: PluginTrustStore,
    private readonly pluginsDir: string = getPluginsDir(),
  ) {}

  /**
   * Scan the plugins directory and (re)build the loaded set. Invalid
   * bundles are recorded in `failures` and skipped — one broken manifest
   * must never block the rest. Returns the loaded plugins.
   */
  async loadAll(): Promise<LoadedHostPlugin[]> {
    this.plugins = new Map();
    this.failures = [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });
    } catch {
      return []; // no plugins dir — normal on most installs
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (!PLUGIN_NAME_REGEX.test(name)) {
        this.failures.push({ name, errors: ['directory name is not a valid plugin name'] });
        continue;
      }
      const loaded = this.loadOne(name);
      if ('errors' in loaded) {
        this.failures.push(loaded);
        continue;
      }
      this.plugins.set(name, loaded);
      // Register the declaration with the trust stack (identity key =
      // plugin name). Awaited per-plugin: the store serializes writes
      // internally, and load happens once at boot, off any hot path.
      try {
        await this.trustStore.upsertDeclaration(
          name,
          loaded.manifest.capabilities,
          loaded.manifest.description,
          loaded.manifest.version,
        );
      } catch (err) {
        console.warn(`[PluginHostLoader] trust declaration failed for ${name}:`, err);
      }
    }
    return [...this.plugins.values()];
  }

  private loadOne(name: string): LoadedHostPlugin | PluginLoadFailure {
    const dirRaw = path.join(this.pluginsDir, name);
    let dir: string;
    try {
      // realpath collapses symlinks/junctions so the protocol handler's
      // containment check can't be bypassed by a symlinked bundle dir.
      dir = fs.realpathSync(dirRaw);
    } catch {
      return { name, errors: ['bundle directory is not readable'] };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
    } catch (err) {
      return { name, errors: [`manifest.json unreadable or invalid JSON: ${err instanceof Error ? err.message : String(err)}`] };
    }

    const parsed = parsePluginManifest(raw);
    if (!parsed.ok) return { name, errors: parsed.errors };
    const manifest = parsed.manifest;

    if (manifest.name !== name) {
      return { name, errors: [`manifest name "${manifest.name}" does not match directory name "${name}"`] };
    }

    // Capability grammar validation — same parser mcp.declarePermissions
    // uses, so the loader and the RPC path can't drift.
    const { errors: capErrors } = parsePermissionList(manifest.capabilities);
    if (capErrors.length > 0) {
      return { name, errors: capErrors.map((e) => `capability ${JSON.stringify(e.permission)}: ${e.reason}`) };
    }

    // Every contribution must be backed by its ui.* capability in the same
    // manifest, so the approval prompt shows exactly what the UI will do.
    const declared = new Set(manifest.capabilities.map((c) => c.split(':')[0]));
    const missing = requiredUiCapabilities(manifest.contributes).filter((c) => !declared.has(c));
    if (missing.length > 0) {
      return { name, errors: [`contributions require undeclared capabilities: ${missing.join(', ')}`] };
    }

    // Contribution entries must exist inside the bundle.
    for (const entry of [manifest.contributes.sidebar?.entry, manifest.contributes.statusbar?.entry]) {
      if (entry === undefined) continue;
      const resolved = resolveWithin(dir, entry);
      if (!resolved || !fs.existsSync(resolved)) {
        return { name, errors: [`contribution entry not found in bundle: ${entry}`] };
      }
    }

    return { manifest, dir };
  }

  get(name: string): LoadedHostPlugin | undefined {
    return this.plugins.get(name);
  }

  list(): LoadedHostPlugin[] {
    return [...this.plugins.values()];
  }

  listFailures(): PluginLoadFailure[] {
    return [...this.failures];
  }

  /**
   * Resolve a bundle-relative URL path to an absolute file path, or null
   * when the plugin is unknown or the path escapes the bundle directory.
   * This is the containment gate the fmux-plugin:// protocol handler
   * trusts — keep it paranoid:
   *   - only loaded plugins resolve (an arbitrary dir name is not enough)
   *   - normalized path must stay strictly inside the realpathed bundle dir
   */
  resolveBundlePath(pluginName: string, urlPath: string): string | null {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) return null;
    // realpath-checked: this result is served to an iframe, so an in-bundle
    // symlink must not be allowed to escape (see resolveWithinReal).
    return resolveWithinReal(plugin.dir, urlPath);
  }

  /** Renderer-facing summaries with the current trust status attached. */
  async summaries(): Promise<PluginHostPluginSummary[]> {
    const out: PluginHostPluginSummary[] = [];
    for (const plugin of this.plugins.values()) {
      let trustStatus: PluginHostPluginSummary['trustStatus'] = 'unconfirmed';
      try {
        const record = await this.trustStore.get(plugin.manifest.name);
        if (record) trustStatus = record.status;
      } catch {
        // unreadable trust DB → keep the fail-closed default (unconfirmed)
      }
      out.push({
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        ...(plugin.manifest.description ? { description: plugin.manifest.description } : {}),
        capabilities: [...plugin.manifest.capabilities],
        activationEvents: [...plugin.manifest.activationEvents],
        contributes: plugin.manifest.contributes,
        trustStatus,
      });
    }
    return out;
  }
}
