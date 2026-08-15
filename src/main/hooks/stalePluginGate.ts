/**
 * #898 — find a Claude Code plugin install whose bridge still forces a prompt.
 *
 * The gate fix ships in two copies of the same file. `refreshHookBridge` brings
 * `~/.wmux/hooks/wmux-bridge.mjs` up to date at boot, but a plugin install is a
 * SEPARATE copy that Claude Code owns: it lives in a version-named directory
 * under the plugin cache and its content is a snapshot taken at install time.
 * Updating wmux does not touch it, so a user who installed the plugin can keep
 * being prompted for every tool call long after the fix has shipped.
 *
 * Worse, the version alone cannot tell you whether an install is affected.
 * `plugin.json` sat at 0.2.0 across the release that introduced the permission
 * gate, so `0.2.0` names two different snapshots — one without the gate at all
 * (harmless) and one with the `ask` bug (broken) — and `claude plugin update`
 * compares versions, so it reports "already at the latest version" for both.
 *
 * Hence a BEHAVIOURAL test rather than a version or a source-text match: run
 * the installed bridge the way a hook would and look at what it writes. The
 * probe uses `WMUX_GATE=0`, which the bridge answers before it reads a token or
 * opens a pipe — no daemon contact, no network, nothing of the user's touched.
 * A fixed bridge writes nothing; the broken one writes a `permissionDecision`.
 *
 * Everything here is READ-ONLY on the plugin cache. wmux does not repair
 * another tool's managed directory: writing there would mean a version
 * directory whose content no longer matches its name, and — since a user can
 * be running a newer plugin than the installed app — could silently downgrade
 * a bridge. The finding is surfaced to the user, who runs the update.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The plugin whose bridge answers the permission gate. */
const PLUGIN_NAME = 'wmux-claude-integration';

/** A hung probe must never hold the boot path. */
const PROBE_TIMEOUT_MS = 5_000;

/** Bound the work on a config with an implausible number of installs. */
const MAX_INSTALLS_PROBED = 8;

const PROBE_PAYLOAD = JSON.stringify({
  tool_name: 'Read',
  tool_input: { file_path: 'wmux-stale-gate-probe' },
});

export interface StalePluginGate {
  /** `wmux-claude-integration@wmux` — the id `claude plugin update` takes. */
  pluginKey: string;
  version: string;
  installPath: string;
  /** The exact command that fixes it. */
  updateCommand: string;
}

export interface DetectOptions {
  /** Defaults to CLAUDE_CONFIG_DIR, then `~/.claude`. */
  configDir?: string;
  /** Node-capable executable that runs the probe. */
  execPath?: string;
  /** Extra env for the probe process. */
  probeEnv?: NodeJS.ProcessEnv;
}

interface InstalledEntry {
  installPath?: unknown;
  version?: unknown;
}

function resolveConfigDir(opts: DetectOptions): string | null {
  if (opts.configDir) return opts.configDir;
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (fromEnv) return fromEnv;
  const home = os.homedir();
  return home ? path.join(home, '.claude') : null;
}

/**
 * The plugin ids in `installed_plugins.json` are `name@marketplace`, and the
 * marketplace half varies per user (whoever they added it from), so match on
 * the name half only.
 */
function isOurPlugin(pluginKey: string): boolean {
  return pluginKey.split('@')[0] === PLUGIN_NAME;
}

/**
 * A bridge that never runs cannot prompt. An install whose hooks.json does not
 * register `--permission-gate` predates the gate entirely, and warning about it
 * would be a false alarm.
 */
function registersPermissionGate(installPath: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(installPath, 'hooks', 'hooks.json'), 'utf8');
    return raw.includes('--permission-gate');
  } catch {
    return false;
  }
}

/**
 * Run the installed bridge on a path that returns before any I/O of its own,
 * and report whether it wrote a decision. HOME/USERPROFILE point at a throwaway
 * directory so a bridge that logs on this path cannot append to the real one.
 */
function bridgeForcesPrompt(bridgePath: string, opts: DetectOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let tmpHome: string | null = null;
    try {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-gate-probe-'));
    } catch {
      resolve(false);
      return;
    }
    const cleanup = () => {
      try {
        if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        // Best effort — a leftover temp dir is not worth failing boot over.
      }
    };
    let settled = false;
    const finish = (forced: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(forced);
    };
    try {
      const child = spawn(
        opts.execPath ?? process.execPath,
        [bridgePath, 'PreToolUse', '--permission-gate'],
        {
          timeout: PROBE_TIMEOUT_MS,
          windowsHide: true,
          env: {
            PATH: process.env.PATH ?? '',
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            HOME: tmpHome,
            USERPROFILE: tmpHome,
            // Answered before the token walk and before any pipe is opened.
            WMUX_GATE: '0',
            WMUX_PTY_ID: 'wmux-stale-gate-probe',
            CLAUDE_CODE_ENTRYPOINT: 'cli',
            CLAUDECODE: '1',
            // process.execPath is Electron in the app; without this it would
            // launch a second app instance instead of running the script.
            ELECTRON_RUN_AS_NODE: '1',
            ...(opts.probeEnv ?? {}),
          },
        },
      );
      let stdout = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.on('error', () => finish(false));
      child.on('close', () => finish(stdout.trim().length > 0));
      child.stdin?.on('error', () => {
        // A bridge that exits before reading stdin is fine; `close` decides.
      });
      child.stdin?.end(PROBE_PAYLOAD);
    } catch {
      finish(false);
    }
  });
}

/**
 * Plugin installs whose bridge would force a permission prompt. Empty on every
 * ordinary machine — no plugin, an up-to-date one, or one without the gate.
 * Never throws: a detector cannot be allowed to break startup.
 */
export async function detectStalePluginGates(opts: DetectOptions = {}): Promise<StalePluginGate[]> {
  try {
    const configDir = resolveConfigDir(opts);
    if (!configDir) return [];
    const recordPath = path.join(configDir, 'plugins', 'installed_plugins.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    } catch {
      return [];
    }
    const plugins = (parsed as { plugins?: unknown } | null)?.plugins;
    if (!plugins || typeof plugins !== 'object') return [];

    const candidates: Array<{ pluginKey: string; installPath: string; version: string }> = [];
    for (const [pluginKey, entries] of Object.entries(plugins as Record<string, unknown>)) {
      if (!isOurPlugin(pluginKey) || !Array.isArray(entries)) continue;
      for (const entry of entries as InstalledEntry[]) {
        const installPath = typeof entry?.installPath === 'string' ? entry.installPath : null;
        if (!installPath) continue;
        candidates.push({
          pluginKey,
          installPath,
          version: typeof entry?.version === 'string' ? entry.version : 'unknown',
        });
        if (candidates.length >= MAX_INSTALLS_PROBED) break;
      }
      if (candidates.length >= MAX_INSTALLS_PROBED) break;
    }

    const found: StalePluginGate[] = [];
    for (const c of candidates) {
      if (!registersPermissionGate(c.installPath)) continue;
      const bridgePath = path.join(c.installPath, 'bin', 'wmux-bridge.mjs');
      if (!fs.existsSync(bridgePath)) continue;
      if (!(await bridgeForcesPrompt(bridgePath, opts))) continue;
      found.push({
        pluginKey: c.pluginKey,
        version: c.version,
        installPath: c.installPath,
        updateCommand: `claude plugin update ${c.pluginKey}`,
      });
    }
    return found;
  } catch {
    return [];
  }
}
