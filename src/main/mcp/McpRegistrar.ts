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
import { stabilizeMcpBundle } from './stabilizeBundle';
import { CODEX_NOTIFY_BASENAME } from '../../shared/configIO';
import {
  OPENCODE_PLUGIN_BUNDLE_BASENAME,
  installLifecycleAsset,
  resolveLifecycleIntegrationPaths,
} from '../../shared/lifecycleIntegrations';
import {
  readAllTargetStatuses,
  registerTarget,
  unregisterTarget,
  registerCodexNotify,
  unregisterCodexNotify,
  readCodexNotifyStatus,
  type TargetRegStatus,
  type ServerRegState,
  type CodexNotifyStatus,
} from '../../shared/mcpRegistration';

/** Per-server registration state surfaced via getStatus(). */
export type McpServerStatus = ServerRegState;
/** Registration state for a single agent target (Claude / Codex / Gemini). */
export type McpTargetStatus = TargetRegStatus;

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

  constructor() {
    this.home = app.getPath('home');
    this.authTokenPath = getAuthTokenPath();
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
    this.registered = false;
  }

  /**
   * Resolve whether registration should point agents at the thin shim (broker
   * topology) or the full bundle (legacy single-child). An explicit
   * `opts.useShim` wins; otherwise, when the broker flag is on, probe the pipe
   * so EVERY call site (boot, renderer re-register IPC, first-run onboarding) is
   * self-correcting — a caller that omits opts never has to know the broker's
   * live health (RISK 6). Flag off short-circuits with no probe and no logs so
   * the pre-broker world is byte-identical.
   */
  private async resolveUseShim(opts?: { useShim?: boolean }): Promise<boolean> {
    if (opts && typeof opts.useShim === 'boolean') return opts.useShim;
    if (!isMcpBrokerEnabled()) return false;
    return canConnectBrokerPipe(300);
  }

  /**
   * Write auth token to file and register the MCP servers in every installed
   * target. Must be called after PipeServer.start().
   *
   * `opts.useShim` forces the topology (boot passes the readiness-gate result);
   * omitting it lets register() probe the broker itself so re-register call
   * sites stay self-correcting.
   */
  async register(authToken: string, opts?: { useShim?: boolean }): Promise<void> {
    const useShim = await this.resolveUseShim(opts);
    // Only the broker topology surfaces a path-choice log; flag-off stays silent.
    if (isMcpBrokerEnabled()) {
      console.log(useShim ? '[mcp] broker reachable → shim' : '[mcp] broker unreachable → full bundle');
    }
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
        return;
      }

      const mcpScript = this.getMcpScriptPath(useShim);
      if (!mcpScript) {
        console.warn('[McpRegistrar] Could not determine MCP script path — skipping registration.');
        return;
      }

      for (const target of MCP_TARGETS) {
        try {
          // No profile argument on purpose. This is the AUTOMATIC path (boot,
          // path refresh), and it must never overrule a profile the user chose
          // with `wmux mcp register --profile`: omitting it preserves whatever
          // the config already carries. Only that CLI flag sets one explicitly.
          const result = registerTarget(target, this.home, mcpScript, this.ownedFor(target.id));
          if (result.wrote.length > 0) {
            console.log(`[McpRegistrar] ${target.displayName}: wrote ${result.wrote.join(', ')} → ${result.configPath}`);
          }
          if (result.foreign.length > 0) {
            console.warn(`[McpRegistrar] ${target.displayName}: left foreign key(s) ${result.foreign.join(', ')} untouched`);
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
        }
      }

      // Official lifecycle integrations are isolated so one agent's config or
      // filesystem failure never aborts MCP registration or another bridge.
      try {
        this.installAndRegisterCodexNotify();
      } catch (err) {
        console.error('[McpRegistrar] Codex notify registration failed:', err);
      }
      try {
        this.installOpenCodePlugin();
      } catch (err) {
        console.error('[McpRegistrar] OpenCode plugin installation failed:', err);
      }

      this.registered = true;
      console.log(`[McpRegistrar] Registered wmux MCP → ${mcpScript}`);
    } catch (err) {
      console.error('[McpRegistrar] Failed to register:', err);
      // macOS Time Machine restore / sudo-written configs surface
      // ENOACCES/EACCES/EPERM with no hint that the fix is `chmod 600`.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (isMac && (code === 'EACCES' || code === 'ENOACCES' || code === 'EPERM')) {
        console.error('\n' + formatMacosError(MACOS_ERRORS.mcpPermissionDenied));
      }
    }
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

  private getMcpScriptPath(useShim: boolean): string | null {
    // Broker topology: agents spawn the thin shim instead of the full bundle;
    // the resident broker (BrokerSupervisor) hosts the actual server. Registered
    // server name stays "wmux" — only the script path changes, which hosts
    // tolerate without a restart (design doc §81: a NEW name would trip host
    // schema caches). `useShim` is decided by the caller (readiness gate or an
    // internal probe) so registration falls back to the full bundle whenever the
    // broker isn't reachable. Fail-open: if the shim file is missing (stale
    // build), fall through to the full bundle so agents keep working.
    if (useShim) {
      if (app.isPackaged) {
        // Packaged shim lives in the versioned resourcesPath — stabilize it to
        // ~/.wmux/mcp/ so the registered command survives app-* swaps.
        const shim = path.join(process.resourcesPath, 'mcp-bundle', 'shim.js');
        if (fs.existsSync(shim)) return this.stabilizePackaged(shim);
      } else {
        const shim = path.join(app.getAppPath(), 'dist', 'mcp', 'mcp', 'shim.js');
        if (fs.existsSync(shim)) return shim;
      }
      console.error('[McpRegistrar] WMUX_MCP_BROKER=1 but shim.js missing — falling back to full bundle');
    }

    if (app.isPackaged) {
      // Production: bundled single-file in resources/mcp-bundle/. Register a
      // STABLE copy under ~/.wmux/mcp/ instead of this versioned resourcesPath
      // so the command wmux writes into ~/.claude.json never dangles when the
      // app-{version} dir (or a dogfood worktree/out/) is later removed — see
      // stabilizeMcpBundle. Fail-open returns the versioned path.
      const bundlePath = path.join(process.resourcesPath, 'mcp-bundle', 'index.js');
      if (fs.existsSync(bundlePath)) return this.stabilizePackaged(bundlePath);
      // Fallback: old layout (resources/mcp/mcp/index.js)
      const legacyPath = path.join(process.resourcesPath, 'mcp', 'mcp', 'index.js');
      if (fs.existsSync(legacyPath)) return this.stabilizePackaged(legacyPath);
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
  private stabilizePackaged(source: string): string {
    const stableDir = path.join(this.home, '.wmux', 'mcp');
    const result = stabilizeMcpBundle(source, stableDir, app.getVersion());
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
      // The user's own notify is preserved; Codex resume falls back to the
      // pill's `codex resume --last`. Also queryable via getStatus().
      console.warn(
        `[McpRegistrar] Codex notify: skipped — a foreign notify occupies the slot in ${result.configPath}. ` +
        'Codex resume auto-capture is OFF; the resume pill falls back to `codex resume --last`.',
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
    if (installed.action !== 'none') {
      console.log(`[McpRegistrar] OpenCode lifecycle plugin ${installed.action} → ${dest}`);
    }
  }
}
