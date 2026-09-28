import crossSpawn from 'cross-spawn';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { getExecEnv } from './execEnv';
import { findLifecycleAssetSourceFrom, inspectLifecycleAsset, installLifecycleAsset } from './lifecycleIntegrations';

export interface OpenCodeTerminalChatInstall {
  state: 'current' | 'manual-config' | 'unavailable' | 'unsupported-version' | 'not-found' | 'timeout' | 'error';
  configPath: string;
  pluginUrl: string;
  error?: string;
}
/** `opencode --version` is a Bun binary; on a loaded machine it takes seconds to start. */
export const OPENCODE_PROBE_TIMEOUT_MS = 10_000;
/** Delay before the one in-session retry after a timed-out probe. */
export const OPENCODE_PROBE_RETRY_MS = 60_000;
/** A version string (null = ran but printed no usable version), or why no version was read. */
export type OpenCodeVersionProbe = { version: string | null } | { state: 'not-found' | 'timeout' | 'error'; error: string };
const probeFailure = (error: NodeJS.ErrnoException): OpenCodeVersionProbe =>
  ({ state: error.code === 'ENOENT' ? 'not-found' : error.code === 'ETIMEDOUT' ? 'timeout' : 'error', error: String(error) });

/**
 * Non-blocking probe for the GUI process. On timeout the whole process tree is
 * killed (POSIX: its own process group, SIGTERM then SIGKILL; Windows:
 * `taskkill /T /F`, since cross-spawn runs opencode.cmd under cmd.exe), and the
 * probe settles only once the child has closed, so a retry never overlaps it.
 */
export function probeOpenCodeVersion(timeoutMs = OPENCODE_PROBE_TIMEOUT_MS, killGraceMs = 2000): Promise<OpenCodeVersionProbe> {
  return new Promise(resolve => {
    const posix = process.platform !== 'win32';
    let stdout = ''; let settled = false; let timedOut = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const done = (result: OpenCodeVersionProbe) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(grace); resolve(result);
    };
    const child = crossSpawn('opencode', ['--version'], { windowsHide: true, env: getExecEnv(), stdio: ['ignore', 'pipe', 'ignore'], detached: posix });
    const killTree = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      if (!posix) { execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { env: getExecEnv(), windowsHide: true }, () => undefined); return; }
      try { process.kill(-child.pid, signal); } catch { /* The group is already gone. */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.stdout?.destroy();
      killTree('SIGTERM');
      grace = setTimeout(() => {
        killTree('SIGKILL');
        grace = setTimeout(() => done({ state: 'error', error: 'opencode --version did not exit after SIGKILL' }), killGraceMs);
      }, killGraceMs);
    }, timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { if (stdout.length < 8192) stdout += chunk; });
    child.on('error', error => done(probeFailure(error)));
    child.on('close', code => {
      if (!timedOut) { done({ version: code === 0 ? stdout : null }); return; }
      // The direct child is gone; reap anything left in its group.
      if (posix) killTree('SIGKILL');
      done(probeFailure(Object.assign(new Error(`opencode --version timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' })));
    });
  });
}

/**
 * Main-process install: the probe never blocks the event loop, and a probe
 * that timed out (a loaded machine at login) is retried once later in the
 * session instead of waiting for the next app start.
 */
export async function installOpenCodeTerminalChat(
  options: { configRoot: string; startDir: string; sourcePath?: string },
  deps: { probe?: () => Promise<OpenCodeVersionProbe>; wait?: (ms: number) => Promise<void>; onRetry?: (first: OpenCodeTerminalChatInstall) => void } = {},
): Promise<OpenCodeTerminalChatInstall> {
  const probe = deps.probe ?? (() => probeOpenCodeVersion());
  const first = openCodeTerminalChatIntegration({ ...options, install: true, probe: await probe() });
  if (first.state !== 'timeout') return first;
  deps.onRetry?.(first);
  await (deps.wait ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms).unref(); })))(OPENCODE_PROBE_RETRY_MS);
  return openCodeTerminalChatIntegration({ ...options, install: true, probe: await probe() });
}

/** TUI modules are configured separately from OpenCode's server plugins.
 * Preserve foreign plugins and refuse JSONC/malformed files rather than
 * silently discarding comments or settings. The reported URL can be added by
 * the operator in that case. No global agent config is changed by dev startup. */
export function openCodeTerminalChatIntegration(options: {
  configRoot: string; startDir: string; sourcePath?: string; install?: boolean; version?: string | null; probe?: OpenCodeVersionProbe;
}): OpenCodeTerminalChatInstall {
  const destinationPath = path.join(options.configRoot, 'wmux-chat-tui.mjs');
  const configPath = path.join(options.configRoot, 'tui.json');
  const pluginUrl = pathToFileURL(destinationPath).href;
  const base = { configPath, pluginUrl };
  if (options.install) {
    let probe: OpenCodeVersionProbe;
    if (options.version !== undefined) probe = { version: options.version };
    else if (options.probe) probe = options.probe;
    else {
      // The CLI (`wmux setup-hooks`) may block; the GUI passes an async probe.
      const run = crossSpawn.sync('opencode', ['--version'], { encoding: 'utf8', timeout: OPENCODE_PROBE_TIMEOUT_MS, maxBuffer: 8192, windowsHide: true, env: getExecEnv() });
      probe = run.error ? probeFailure(run.error) : { version: run.status === 0 ? run.stdout : null };
    }
    // No version was read (not on PATH, or timed out): not a version verdict.
    if ('state' in probe) return { ...base, state: probe.state, error: probe.error };
    const version = probe.version;
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
