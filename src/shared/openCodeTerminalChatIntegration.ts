import crossSpawn from 'cross-spawn';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { findLifecycleAssetSourceFrom, inspectLifecycleAsset, installLifecycleAsset } from './lifecycleIntegrations';

export interface OpenCodeTerminalChatInstall {
  state: 'current' | 'manual-config' | 'unavailable' | 'unsupported-version' | 'error';
  configPath: string;
  pluginUrl: string;
  error?: string;
}
/** TUI modules are configured separately from OpenCode's server plugins.
 * Preserve foreign plugins and refuse JSONC/malformed files rather than
 * silently discarding comments or settings. The reported URL can be added by
 * the operator in that case. No global agent config is changed by dev startup. */
export function openCodeTerminalChatIntegration(options: {
  configRoot: string; startDir: string; sourcePath?: string; install?: boolean; version?: string | null;
}): OpenCodeTerminalChatInstall {
  const destinationPath = path.join(options.configRoot, 'wmux-chat-tui.mjs');
  const configPath = path.join(options.configRoot, 'tui.json');
  const pluginUrl = pathToFileURL(destinationPath).href;
  const base = { configPath, pluginUrl };
  if (options.install) {
    let version = options.version;
    if (version === undefined) {
      const probe = crossSpawn.sync('opencode', ['--version'], { encoding: 'utf8', timeout: 3000, maxBuffer: 8192, windowsHide: true });
      version = probe.status === 0 ? probe.stdout : null;
    }
    const match = /^(?:opencode\s+)?(\d+)\.(\d+)\.(\d+)\s*$/.exec(version?.trim() ?? '');
    if (!match || Number(match[1]) !== 1 || Number(match[2]) < 18 || Number(match[2]) === 18 && Number(match[3]) < 30) return { ...base, state: 'unsupported-version' };
  }
  const spec = { destinationPath, ownershipMarkers: ['wmux-managed: opencode-terminal-chat'],
    sourcePath: options.sourcePath ?? findLifecycleAssetSourceFrom(options.startDir, 'wmux-chat-tui.mjs', ['integrations', 'opencode', 'plugins', 'wmux-chat-tui.mjs']) };
  const asset = options.install ? installLifecycleAsset(spec) : inspectLifecycleAsset(spec);
  if (asset.state !== 'current') return { ...base, state: 'unavailable', ...(asset.error ? { error: asset.error } : {}) };
  try {
    if (fs.existsSync(path.join(options.configRoot, 'tui.jsonc'))) return { ...base, state: 'manual-config' };
    let original = '';
    try { original = fs.readFileSync(configPath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let config: Record<string, unknown> = {};
    try {
      if (original) config = JSON.parse(original);
      if (!config || typeof config !== 'object' || Array.isArray(config) || config.plugin !== undefined && !Array.isArray(config.plugin)) return { ...base, state: 'manual-config' };
    } catch { return { ...base, state: 'manual-config' }; }
    const plugins = config.plugin as unknown[] | undefined ?? [];
    if (plugins.some(p => p === pluginUrl || Array.isArray(p) && p[0] === pluginUrl)) return { ...base, state: 'current' };
    if (!options.install) return { ...base, state: 'manual-config' };
    const next = JSON.stringify({ ...config, plugin: [...plugins, pluginUrl] }, null, 2) + '\n';
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, next, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, configPath); }
    finally { try { fs.unlinkSync(temporary); } catch { /* Already renamed. */ } }
    return { ...base, state: 'current' };
  } catch (error) { return { ...base, state: 'error', error: String(error) }; }
}
