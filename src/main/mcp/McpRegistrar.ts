import { installOpenCodeTerminalChat, OPENCODE_PROBE_RETRY_MS, OPENCODE_PROBE_TIMEOUT_MS, type OpenCodeTerminalChatInstall } from '../../shared/openCodeTerminalChatIntegration';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { getAuthTokenPath } from '../../shared/constants';
import { secureWriteTokenFile } from '../../shared/security';
import { isMac } from '../../shared/platform';
import { formatMacosError, MACOS_ERRORS } from '../../shared/errors/macos';
import { MCP_TARGETS, externalRegistrationSkipReason } from '../../shared/mcpTargets';
import { isMcpBrokerEnabled } from './BrokerSupervisor';
import { canConnectBrokerPipe } from './brokerProbe';
import { stabilizeMcpBundle, type StabilizeResult } from './stabilizeBundle';
import { prepareNativeLauncher } from './nativeLauncher';
import { chooseLauncher, nativeLauncherPath, runNativeSelfTest, type LauncherChoice, type SelfTestVerdict } from '../../shared/mcpLauncher';
import { nativeHooksBasename } from '../../shared/hooks/hookFlavours';
import { CODEX_NOTIFY_BASENAME } from '../../shared/configIO';
import {
  OPENCODE_PLUGIN_BUNDLE_BASENAME,
  installLifecycleAsset,
  resolveLifecycleIntegrationPaths,
} from '../../shared/lifecycleIntegrations';
import {
  readAllTargetStatuses,
  readTargetStatus,
  registerTarget,
  unregisterTarget,
  registerCodexNotify,
  unregisterCodexNotify,
  readCodexNotifyStatus,
  unregisterCodexHooks,
  type TargetRegStatus,
  type ServerRegState,
  type CodexNotifyStatus,
} from '../../shared/mcpRegistration';

/** Per-server registration state surfaced via getStatus(). */
export type McpServerStatus = ServerRegState;
/** Registration state for a single agent target (Claude / Codex / Gemini / Antigravity). */
export type McpTargetStatus = TargetRegStatus;

/** Fixed registration error sentences surfaced via McpTargetResult.error. */
export const MCP_ERROR_CONFIG_NOT_FOUND = 'The CLI config file was not found';
export const MCP_ERROR_CONFIG_UPDATE_FAILED = 'The config file could not be updated';
export const MCP_ERROR_UNAVAILABLE = 'Registration is unavailable right now';

/** Per-target registration result returned by register() and registerTarget(). */
export interface McpTargetResult {
  id: string;
  success: boolean;
  error?: string;
}

/** Per-registration stabilize results, by source directory. */
type StabilizeMemo = Map<string, StabilizeResult>;

export interface McpRegistrarDeps {
  /** The native launcher's self-test; the real one runs the binary. */
  nativeSelfTest?: (binary: string) => Promise<SelfTestVerdict>;
}

export interface RegisterOptions {
  useShim?: boolean;
  explicit?: boolean;
  targets?: string[];
}

/** Aggregate snapshot of MCP integration state for CLI / Settings UI. */
export interface McpRegistrarStatus {
  targets: McpTargetStatus[];
  /** Codex resume-capture `notify` registration (X6 codex resume). */
  codexNotify: CodexNotifyStatus;
}

/**
 * Registers/unregisters the wmux MCP server (`wmux`) into the config files of
 * the installed agent CLIs, and writes the auth token to a
 * well-known file so the MCP server can read it. The per-target fs + config
 * orchestration lives in `shared/mcpRegistration` so this class and the
 * `wmux mcp` CLI behave identically; this class adds the Electron-specific
 * bundle-path resolution, the auth-token write, and macOS error hints.
 *
 * Targets (see `shared/mcpTargets.ts`):
 *   - Claude Code  ~/.claude.json          (JSON, created on demand)
 *   - Codex CLI    ~/.codex/config.toml     (TOML, only if installed)
 *   - Gemini CLI   ~/.gemini/settings.json  (JSON, only if installed; unverified)
 *   - Antigravity  ~/.gemini/config/mcp_config.json (JSON, opt-in via
 *                  `wmux mcp register --target agy`; never at boot)
 *
 * EMPIRICAL GATE: a non-Claude target is only written when its config already
 * exists (the CLI is installed) and is shipped as `verified` only after the
 * agent was confirmed to discover AND use the wmux tools end-to-end — which
 * additionally requires the agent's MCP `clientName` to be first-party
 * recognized by the daemon enforcer (`firstParty.ts`). Codex (`codex-mcp-client`)
 * was verified 2026-06-15.
 *
 * NOTE (macOS Claude Desktop `~/Library/Application Support/Claude/`): still
 * pending empirical verification — out of scope, do not add speculatively.
 */
export class McpRegistrar {
  private readonly home: string;
  private readonly authTokenPath: string;
  private registered = false;
  /** Per-target sets of keys wmux wrote this session (so we update/own them). */
  private readonly ownedKeys = new Map<string, Set<string>>();
  private readonly nativeSelfTest: (binary: string) => Promise<SelfTestVerdict>;

  constructor(deps: McpRegistrarDeps = {}) {
    this.home = app.getPath('home');
    this.authTokenPath = getAuthTokenPath();
    this.nativeSelfTest = deps.nativeSelfTest ?? runNativeSelfTest;
  }

  /** Absolute path to the Claude Code user config file (back-compat accessor). */
  getClaudeJsonPath(): string {
    return path.join(this.home, '.claude.json');
  }

  private ownedFor(targetId: string): Set<string> {
    let set = this.ownedKeys.get(targetId);
    if (!set) {
      set = new Set<string>();
      this.ownedKeys.set(targetId, set);
    }
    return set;
  }

  /**
   * Read-only snapshot of MCP registration state across all targets. Pure read
   * — never creates a file, never throws. Corrupted/missing configs yield "not
   * registered".
   */
  getStatus(): McpRegistrarStatus {
    return {
      targets: readAllTargetStatuses(this.home),
      codexNotify: readCodexNotifyStatus(this.home),
    };
  }

  /**
   * Force-remove the wmux key from every target config. Invoked
   * from explicit user actions (`wmux mcp unregister`, Settings "Unregister").
   * Only removes wmux-owned-shaped keys; foreign entries and unrelated keys are
   * left intact.
   */
  forceUnregister(): void {
    // #1151 — symmetric guard: an isolated instance must not DELETE the
    // production registration either (same suffix-blind config paths).
    const skipReason = externalRegistrationSkipReason();
    if (skipReason) {
      console.log(`[McpRegistrar] ${skipReason} (unregister)`);
      return;
    }
    for (const target of MCP_TARGETS) {
      try {
        const result = unregisterTarget(target, this.home);
        this.ownedFor(target.id).clear();
        if (result.removed.length > 0) {
          console.log(`[McpRegistrar] Unregistered ${result.removed.join(', ')} from ${result.configPath}`);
        }
      } catch (err) {
        console.error(`[McpRegistrar] Failed to force-unregister ${target.displayName}:`, err);
      }
    }
    try {
      const { removed, configPath } = unregisterCodexNotify(this.home);
      if (removed) console.log(`[McpRegistrar] Unregistered Codex notify from ${configPath}`);
    } catch (err) {
      console.error('[McpRegistrar] Failed to unregister Codex notify:', err);
    }
    // #1107 — the hooks block leaves with the notify bridge. Marker-bounded
    // removal (configIO), so a user's own [[hooks.*]] tables survive.
    try {
      const { removed, configPath } = unregisterCodexHooks(this.home);
      if (removed) console.log(`[McpRegistrar] Removed Codex hooks block from ${configPath}`);
    } catch (err) {
      console.error('[McpRegistrar] Failed to remove Codex hooks block:', err);
    }
    this.registered = false;
  }

  /**
   * Resolve whether registration should point agents at the thin shim (broker
   * topology) or the full bundle (legacy single-child). Always false in a
   * packaged build, which never registers the shim. In a dev build an explicit
   * `opts.useShim` wins; otherwise, when the broker flag is on, probe the pipe
   * so EVERY call site (boot, renderer re-register IPC, first-run onboarding) is
   * self-correcting — a caller that omits opts never has to know the broker's
   * live health (RISK 6). Flag off short-circuits with no probe and no logs so
   * the pre-broker world is byte-identical.
   */
  private async resolveUseShim(opts?: { useShim?: boolean }): Promise<boolean> {
    // A packaged build never registers the shim: nothing to probe or force.
    if (app.isPackaged) return false;
    if (opts && typeof opts.useShim === 'boolean') return opts.useShim;
    if (!isMcpBrokerEnabled()) return false;
    return canConnectBrokerPipe(300);
  }

  /**
   * Write auth token to file and register the MCP servers in every installed
   * target. Must be called after PipeServer.start().
   *
   * In a dev build `opts.useShim` forces the topology (boot passes the
   * readiness-gate result); omitting it lets register() probe the broker itself
   * so re-register call sites stay self-correcting. A packaged build ignores it.
   *
   * When `opts.explicit` is true:
   *   - If `opts.targets` is provided, registers only those targets.
   *   - If `opts.targets` is omitted, registers all targets in MCP_TARGETS.
   * When `opts.explicit` is false/omitted (boot path):
   *   - Registers only targets where `autoRegister` is true.
   */
  async register(authToken: string, opts?: RegisterOptions): Promise<McpTargetResult[]> {
    const useShim = await this.resolveUseShim(opts);
    // Only a dev build's broker topology surfaces a path-choice log (a packaged
    // build never takes the shim); flag-off stays silent.
    if (isMcpBrokerEnabled() && !app.isPackaged) {
      console.log(useShim ? '[mcp] broker reachable → shim' : '[mcp] broker unreachable → full bundle');
    }
    const results: McpTargetResult[] = [];
    try {
      // Write auth token to file so the MCP server can read it. Skip when the
      // on-disk value already matches (S-A cold-start): a rewrite costs a 1-2s
      // PowerShell ACL rebuild. A mismatch (rotation / stale) still rewrites.
      let onDisk: string | null = null;
      try {
        onDisk = fs.readFileSync(this.authTokenPath, 'utf8').trim();
      } catch { /* missing/unreadable — write below */ }
      if (onDisk === authToken) {
        console.log(`[McpRegistrar] Auth token already current at ${this.authTokenPath} — skipping rewrite`);
      } else {
        secureWriteTokenFile(this.authTokenPath, authToken);
        console.log(`[McpRegistrar] Auth token written to ${this.authTokenPath}`);
      }

      // #1151 — an isolated instance must not rewrite the PRODUCTION agent
      // configs. Every external target below (`~/.claude.json` et al., Codex
      // notify, the OpenCode plugin) lives at a suffix-blind path, so a
      // WMUX_DATA_SUFFIX boot — dev's automatic "-dev" included — would point
      // the user's daily agents at this instance's bundle. The entry is only a
      // script-path slot anyway (which instance a pane talks to is decided by
      // the WMUX_DATA_SUFFIX env the pane inherits), so the isolated instance
      // gains nothing by claiming it. The auth token above is already written
      // to a suffixed path and stays. WMUX_MCP_REGISTER_EXTERNAL=1 opts back
      // in for dogfood runs that deliberately want to claim the slot.
      const skipReason = externalRegistrationSkipReason();
      if (skipReason) {
        console.log(`[McpRegistrar] ${skipReason}`);
        if (opts?.targets) {
          return opts.targets.map((id) => ({ id, success: false, error: skipReason }));
        }
        return results;
      }

      // Only past the skip above: the stable directory ignores the data
      // suffix, so an isolated instance must never install or run a launcher
      // there that production agents would then start.
      const choice = await this.resolveLauncher(useShim);
      if (!choice) {
        console.warn('[McpRegistrar] Could not determine MCP script path — skipping registration.');
        if (opts?.targets) {
          return opts.targets.map((id) => ({
            id,
            success: false,
            error: MCP_ERROR_UNAVAILABLE,
          }));
        }
        return results;
      }

      // Record errors for any unknown target IDs requested in opts.targets
      if (opts?.explicit && opts.targets) {
        for (const tid of opts.targets) {
          if (!MCP_TARGETS.some((t) => t.id === tid)) {
            results.push({
              id: tid,
              success: false,
              error: MCP_ERROR_CONFIG_NOT_FOUND,
            });
          }
        }
      }

      for (const target of MCP_TARGETS) {
        if (opts?.explicit) {
          // Explicit registration: when opts.targets is provided, register only those targets; when omitted, register all MCP_TARGETS.
          if (opts.targets && !opts.targets.includes(target.id)) continue;
        } else {
          // Non-explicit / boot path: register only autoRegister targets.
          if (!target.autoRegister) continue;
        }
        try {
          // No profile argument on purpose. This is the AUTOMATIC path (boot,
          // path refresh), and it must never overrule a profile the user chose
          // with `wmux mcp register --profile`: omitting it preserves whatever
          // the config already carries. Only that CLI flag sets one explicitly.
          const result = registerTarget(target, this.home, choice.launcher, this.ownedFor(target.id));
          if (result.wrote.length > 0) {
            console.log(`[McpRegistrar] ${target.displayName}: wrote ${result.wrote.join(', ')} → ${result.configPath}`);
          }
          if (result.foreign.length > 0) {
            console.warn(`[McpRegistrar] ${target.displayName}: left foreign key(s) ${result.foreign.join(', ')} untouched`);
          }
          if (result.skipped === 'absent') {
            results.push({
              id: target.id,
              success: false,
              error: MCP_ERROR_CONFIG_NOT_FOUND,
            });
          } else if (result.skipped === 'malformed') {
            results.push({
              id: target.id,
              success: false,
              error: MCP_ERROR_CONFIG_UPDATE_FAILED,
            });
          } else if (result.foreign.length > 0 && result.wrote.length === 0) {
            results.push({
              id: target.id,
              success: false,
              error: MCP_ERROR_CONFIG_UPDATE_FAILED,
            });
          } else {
            results.push({
              id: target.id,
              success: true,
            });
          }
        } catch (err) {
          // Per-target isolation: one target's failure must not abort the rest.
          // A write/permission failure reaches here (registerTarget propagates
          // it rather than misreporting "malformed"); surface the macOS hint.
          console.error(`[McpRegistrar] ${target.displayName} registration failed:`, err);
          const code = (err as NodeJS.ErrnoException)?.code;
          if (isMac && (code === 'EACCES' || code === 'ENOACCES' || code === 'EPERM')) {
            console.error('\n' + formatMacosError(MACOS_ERRORS.mcpPermissionDenied));
          }
          results.push({
            id: target.id,
            success: false,
            error: MCP_ERROR_CONFIG_UPDATE_FAILED,
          });
        }
      }

      // No entry may stay on a launcher this build does not offer, including
      // targets this call did not cover (a target registered only on request):
      // the node shim an older build registered, and the native launcher when
      // it is not offered this time (its copy is kept but may not run here).
      if (app.isPackaged) {
        // Compared resolved, and without case on Windows, so an entry written
        // with other slashes or drive-letter case still matches.
        const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
        const stableDir = norm(path.join(this.home, '.wmux', 'mcp'));
        const native = choice.lane !== 'native' ? norm(nativeLauncherPath(path.join(this.home, '.wmux', 'mcp'))) : null;
        // The shim's stable copy, or a versioned one in an installed app's
        // resources/mcp-bundle (a dev checkout's dist/ is left alone).
        const isShim = (at: string) =>
          path.basename(at) === 'shim.js' &&
          (path.dirname(at) === stableDir ||
            (path.basename(path.dirname(at)) === 'mcp-bundle' && path.basename(path.dirname(path.dirname(at))).toLowerCase() === 'resources'));
        for (const target of MCP_TARGETS) {
          let what: string | undefined;
          try {
            const raw = readTargetStatus(target, this.home).wmux.path;
            const at = raw ? norm(raw) : null;
            what = !at ? undefined : isShim(at) ? 'the node shim' : at === native ? 'the native launcher' : undefined;
            if (!what) continue;
            const moved = registerTarget(target, this.home, choice.launcher, this.ownedFor(target.id));
            if (moved.wrote.length > 0) console.log(`[McpRegistrar] ${target.displayName}: moved off ${what} → ${moved.configPath}`);
          } catch (err) {
            console.error(`[McpRegistrar] ${target.displayName}: could not move off ${what}:`, err);
          }
        }
      }

      // Official lifecycle integrations are isolated so one agent's config or
      // filesystem failure never aborts MCP registration or another bridge.
      // A per-target Register touches only its target: the Codex notify bridge goes with Codex,
      // and the OpenCode plugin only with the full (boot) registration.
      if (!opts?.targets || opts.targets.includes('codex')) {
        try {
          this.installAndRegisterCodexNotify();
        } catch (err) {
          console.error('[McpRegistrar] Codex notify registration failed:', err);
        }
      }
      if (!opts?.targets) {
        try {
          this.installOpenCodePlugin();
        } catch (err) {
          console.error('[McpRegistrar] OpenCode plugin installation failed:', err);
        }
      }

      this.registered = true;
      const registered = choice.launcher.kind === 'node' ? choice.launcher.script : `${choice.launcher.binary} mcp-shim`;
      console.log(`[McpRegistrar] Registered wmux MCP (${choice.lane}) → ${registered}`);
    } catch (err) {
      console.error('[McpRegistrar] Failed to register:', err);
      // macOS Time Machine restore / sudo-written configs surface
      // ENOACCES/EACCES/EPERM with no hint that the fix is `chmod 600`.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (isMac && (code === 'EACCES' || code === 'ENOACCES' || code === 'EPERM')) {
        console.error('\n' + formatMacosError(MACOS_ERRORS.mcpPermissionDenied));
      }
      if (results.length === 0 && opts?.targets) {
        for (const tid of opts.targets) {
          results.push({
            id: tid,
            success: false,
            error: MCP_ERROR_UNAVAILABLE,
          });
        }
      }
    }
    return results;
  }

  /**
   * Explicitly register a single target by id (e.g. 'agy').
   * Returns a per-target result with success and error details.
   */
  async registerTarget(authToken: string, targetId: string): Promise<McpTargetResult> {
    const results = await this.register(authToken, { explicit: true, targets: [targetId] });
    return results.find((r) => r.id === targetId) ?? {
      id: targetId,
      success: false,
      error: MCP_ERROR_UNAVAILABLE,
    };
  }

  /**
   * Previously removed MCP entries on quit, which deadlocked discovery (Claude
   * couldn't find the server wmux deleted on exit). Now persistent; the MCP
   * process handles pipe-not-available gracefully when wmux isn't running.
   */
  unregister(): void {
    // Intentionally no-op: keep registration persistent so agents can always
    // discover the wmux MCP server.
    this.ownedKeys.clear();
  }

  /**
   * The launcher to register: the native launcher when the broker is enabled
   * and it is healthy (no readiness probe, see shared/mcpLauncher.ts), else,
   * in a dev build only, the node shim when the broker answers (`useShim`),
   * else the full bundle.
   */
  private async resolveLauncher(useShim: boolean): Promise<LauncherChoice | null> {
    const brokerEnabled = isMcpBrokerEnabled();
    // One stabilize (one hash of the bundle) per registration, shared by
    // every script resolved from the same directory below.
    const memo: StabilizeMemo = new Map();
    const nativeBinary = brokerEnabled && app.isPackaged ? await this.prepareNative(memo) : null;
    return chooseLauncher({
      packaged: app.isPackaged,
      // In a dev build an explicit `useShim: true` still selects the shim with
      // the flag off.
      brokerEnabled: brokerEnabled || useShim,
      nativeBinary,
      brokerReady: async () => useShim,
      // Resolved only when it can be chosen, as before: the shim is stabilized
      // and its absence logged only for a broker that answers.
      shimScript: useShim && !nativeBinary ? this.getShimScriptPath() : null,
      bundleScript: this.getMcpScriptPath(memo),
    });
  }

  /**
   * Copy the shipped native launcher beside the stable bundle and self-test
   * it. Only when that bundle stabilized: the launcher falls back to the
   * `index.js` next to it, so without one it would have nothing to run.
   */
  private async prepareNative(memo: StabilizeMemo): Promise<string | null> {
    const bundle = path.join(process.resourcesPath, 'mcp-bundle', 'index.js');
    if (!fs.existsSync(bundle)) return null;
    const stableDir = path.join(this.home, '.wmux', 'mcp');
    const stable = this.stabilizeOnce(bundle, memo);
    if (!stable.stabilized) {
      console.warn(`[McpRegistrar] native MCP launcher not used: the stable bundle is unavailable (${stable.reason})`);
      return null;
    }
    const result = await prepareNativeLauncher({
      sourcePath: path.join(process.resourcesPath, 'native-hooks', nativeHooksBasename()),
      stableDir,
      selfTest: this.nativeSelfTest,
    });
    if (!result.binary) console.warn(`[McpRegistrar] native MCP launcher not used: ${result.reason}`);
    return result.binary;
  }

  /** A dev build's node shim for the broker topology, or null when it has none. */
  private getShimScriptPath(): string | null {
    const shim = path.join(app.getAppPath(), 'dist', 'mcp', 'mcp', 'shim.js');
    if (fs.existsSync(shim)) return shim;
    console.error('[McpRegistrar] WMUX_MCP_BROKER=1 but shim.js missing — falling back to full bundle');
    return null;
  }

  private getMcpScriptPath(memo: StabilizeMemo): string | null {
    if (app.isPackaged) {
      // Production: bundled single-file in resources/mcp-bundle/. Register a
      // STABLE copy under ~/.wmux/mcp/ instead of this versioned resourcesPath
      // so the command wmux writes into ~/.claude.json never dangles when the
      // app-{version} dir (or a dogfood worktree/out/) is later removed — see
      // stabilizeMcpBundle. Fail-open returns the versioned path.
      const bundlePath = path.join(process.resourcesPath, 'mcp-bundle', 'index.js');
      if (fs.existsSync(bundlePath)) return this.stabilizePackaged(bundlePath, memo);
      // Fallback: old layout (resources/mcp/mcp/index.js)
      const legacyPath = path.join(process.resourcesPath, 'mcp', 'mcp', 'index.js');
      if (fs.existsSync(legacyPath)) return this.stabilizePackaged(legacyPath, memo);
      return null;
    }

    // Dev mode: use the unbundled tsc output (has access to node_modules).
    // entry.js is the stdio boot; index.js is now a side-effect-free factory
    // (the broker split moved main() into entry.ts), so pointing at index.js
    // would launch a module that does nothing.
    const appPath = app.getAppPath();

    const devPath = path.join(appPath, 'dist', 'mcp', 'mcp', 'entry.js');
    if (fs.existsSync(devPath)) return devPath;

    // Walk up directories until we find dist/mcp/mcp/entry.js or hit root
    let current = appPath;
    for (let i = 0; i < 5; i++) {
      const parent = path.resolve(current, '..');
      if (parent === current) break;
      const candidate = path.join(parent, 'dist', 'mcp', 'mcp', 'entry.js');
      if (fs.existsSync(candidate)) return candidate;
      current = parent;
    }

    return null;
  }

  /**
   * Relocate a packaged bundle entry into the stable `~/.wmux/mcp/` directory
   * and return the path to register. Keeps the registered MCP command out of the
   * versioned `resourcesPath`, so it never dangles across app updates / worktree
   * cleanup — the exact failure captured in the RCA (a registered args path
   * pointing at an already-deleted dogfood `out/…/mcp-bundle/index.js`). Refreshes
   * on boot (version-marker gated), mirroring installAndRegisterCodexNotify. On
   * any copy failure it fails open to the versioned source so MCP still works
   * this session (see stabilizeMcpBundle).
   */
  /** stabilizeMcpBundle once per source directory and registration: the
   *  copy is the whole directory, so every script in it shares the result. */
  private stabilizeOnce(source: string, memo: StabilizeMemo): StabilizeResult {
    const dir = path.dirname(source);
    let result = memo.get(dir);
    if (!result) {
      result = stabilizeMcpBundle(source, path.join(this.home, '.wmux', 'mcp'), app.getVersion());
      memo.set(dir, result);
    }
    if (!result.stabilized) return { ...result, scriptPath: source };
    return { ...result, scriptPath: path.join(path.dirname(result.scriptPath), path.basename(source)) };
  }

  private stabilizePackaged(source: string, memo: StabilizeMemo): string {
    const result = this.stabilizeOnce(source, memo);
    if (result.stabilized) {
      if (result.synced) {
        console.log(`[McpRegistrar] MCP bundle synced to stable path → ${result.scriptPath}`);
      }
    } else {
      console.warn(
        `[McpRegistrar] MCP bundle stable-copy unavailable (${result.reason}); ` +
          `registering versioned path ${result.scriptPath}`,
      );
    }
    return result.scriptPath;
  }

  /**
   * Locate the Codex resume-capture notify script SOURCE (before install).
   * Packaged: ships next to the CLI bundle as an extraResource
   * (resources/cli-bundle/). Dev: the repo `integrations/codex/bin/` file, or the
   * `dist/cli-bundle/` copy after `build:cli`. Mirrors getMcpScriptPath's
   * packaged/dev/walk-up strategy.
   */
  private getCodexNotifySourcePath(): string | null {
    const BASENAME = CODEX_NOTIFY_BASENAME;
    if (app.isPackaged) {
      const p = path.join(process.resourcesPath, 'cli-bundle', BASENAME);
      return fs.existsSync(p) ? p : null;
    }
    const appPath = app.getAppPath();
    const rels = [
      ['integrations', 'codex', 'bin', BASENAME],
      ['dist', 'cli-bundle', BASENAME],
    ];
    let current = appPath;
    for (let i = 0; i < 6; i++) {
      for (const rel of rels) {
        const candidate = path.join(current, ...rel);
        if (fs.existsSync(candidate)) return candidate;
      }
      const parent = path.resolve(current, '..');
      if (parent === current) break;
      current = parent;
    }
    return null;
  }

  /**
   * Install the Codex notify bridge to a stable path and register it without
   * replacing a foreign destination or foreign root `notify` command.
   */
  private installAndRegisterCodexNotify(): void {
    const spec = resolveLifecycleIntegrationPaths(this.home, app.getAppPath()).codex;
    const dest = spec.destinationPath;
    const installed = installLifecycleAsset({
      ...spec,
      sourcePath: this.getCodexNotifySourcePath(),
    });
    if (installed.state !== 'current') {
      const detail = installed.error ? `: ${installed.error}` : '';
      console.warn(
        `[McpRegistrar] Codex notify bridge ${installed.state}; left ${dest} untouched${detail}`,
      );
      return;
    }
    if (installed.action !== 'none') {
      console.log(`[McpRegistrar] Codex notify bridge ${installed.action} → ${dest}`);
    }

    const result = registerCodexNotify(this.home, dest);
    if (result.skipped === 'foreign') {
      // The user's own notify is preserved; with no captured thread the
      // resume pill opens `codex resume`'s picker (#1946). Also queryable via
      // getStatus().
      console.warn(
        `[McpRegistrar] Codex notify: skipped — a foreign notify occupies the slot in ${result.configPath}. ` +
        'Codex resume auto-capture is OFF; the resume pill opens the `codex resume` picker instead.',
      );
    } else if (result.skipped === 'malformed') {
      console.warn(`[McpRegistrar] Codex notify: malformed config left untouched at ${result.configPath}`);
    } else if (result.wrote) {
      console.log(`[McpRegistrar] Codex notify → ${dest}`);
    }
  }

  /** Resolve the bundled OpenCode plugin in packaged and development layouts. */
  private getOpenCodePluginSourcePath(devSource: string | null): string | null {
    if (app.isPackaged) {
      const bundled = path.join(
        process.resourcesPath,
        'cli-bundle',
        OPENCODE_PLUGIN_BUNDLE_BASENAME,
      );
      return fs.existsSync(bundled) ? bundled : null;
    }
    return devSource;
  }

  /**
   * Install/refresh the global OpenCode lifecycle plugin only when OpenCode's
   * config root already exists (or wmux previously installed the destination).
   * A same-name user plugin without the wmux marker is always preserved.
   */
  private installOpenCodePlugin(): void {
    const spec = resolveLifecycleIntegrationPaths(this.home, app.getAppPath()).opencode;
    const dest = spec.destinationPath;
    const configRoot = path.dirname(path.dirname(dest));
    if (!fs.existsSync(configRoot) && !fs.existsSync(dest)) return;

    const installed = installLifecycleAsset({
      ...spec,
      sourcePath: this.getOpenCodePluginSourcePath(spec.sourcePath),
    });
    if (installed.state !== 'current') {
      const detail = installed.error ? `: ${installed.error}` : '';
      console.warn(
        `[McpRegistrar] OpenCode lifecycle plugin ${installed.state}; left ${dest} untouched${detail}`,
      );
      return;
    }
    // Not awaited: the version probe must never hold up startup.
    void installOpenCodeTerminalChat({ configRoot, startDir: app.getAppPath(),
      ...(app.isPackaged ? { sourcePath: path.join(process.resourcesPath, 'cli-bundle', 'wmux-chat-tui.mjs') } : {}) }, {
      onRetry: () => console.warn(`[McpRegistrar] OpenCode terminal chat: \`opencode --version\` timed out after ${OPENCODE_PROBE_TIMEOUT_MS / 1000}s; retrying in ${OPENCODE_PROBE_RETRY_MS / 1000}s`),
    }).then(chat => { const message = describeTerminalChat(chat); if (message) console.warn(`[McpRegistrar] OpenCode terminal chat: ${message}`); },
      err => console.error('[McpRegistrar] OpenCode terminal chat installation failed:', err));
    if (installed.action !== 'none') {
      console.log(`[McpRegistrar] OpenCode lifecycle plugin ${installed.action} → ${dest}`);
    }
  }
}

/** What happened, in the log's words; the manual-edit hint only where it applies. */
function describeTerminalChat(chat: OpenCodeTerminalChatInstall): string | null {
  switch (chat.state) {
    case 'current': return null;
    case 'not-found': return `opencode not found on PATH; not installed (${chat.error})`;
    case 'timeout': return `\`opencode --version\` timed out again after ${OPENCODE_PROBE_TIMEOUT_MS / 1000}s; not installed this session`;
    case 'manual-config': return `wmux will not rewrite ${chat.configPath} (JSONC or an unexpected plugin key); add ${chat.pluginUrl} to its plugin list`;
    default: return `${chat.state}; not installed${chat.error ? ` (${chat.error})` : ''}`;
  }
}
