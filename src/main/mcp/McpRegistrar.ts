import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { getAuthTokenPath } from '../../shared/constants';
import { secureWriteTokenFile } from '../../shared/security';
import { isMac } from '../../shared/platform';
import { formatMacosError, MACOS_ERRORS } from '../../shared/errors/macos';
import { MCP_TARGETS } from '../../shared/mcpTargets';
import { isMcpBrokerEnabled } from './BrokerSupervisor';
import { CODEX_NOTIFY_BASENAME } from '../../shared/configIO';
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
   * Write auth token to file and register the MCP servers in every installed
   * target. Must be called after PipeServer.start().
   */
  register(authToken: string): void {
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

      const mcpScript = this.getMcpScriptPath();
      if (!mcpScript) {
        console.warn('[McpRegistrar] Could not determine MCP script path — skipping registration.');
        return;
      }

      for (const target of MCP_TARGETS) {
        try {
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

      // X6 codex resume: register the Codex resume-capture `notify` bridge in the
      // SAME codex config.toml. Isolated so a notify failure never aborts MCP
      // registration (and vice-versa).
      try {
        this.installAndRegisterCodexNotify();
      } catch (err) {
        console.error('[McpRegistrar] Codex notify registration failed:', err);
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

  private getMcpScriptPath(): string | null {
    // Broker topology (WMUX_MCP_BROKER=1): agents spawn the thin shim
    // instead of the full bundle; the resident broker (BrokerSupervisor)
    // hosts the actual server. Registered server name stays "wmux" — only
    // the script path changes, which hosts tolerate without a restart
    // (design doc §81: a NEW name would trip host schema caches).
    // Fail-open: if the shim is missing (stale build), fall through to the
    // full bundle so agents keep working in the legacy topology.
    if (isMcpBrokerEnabled()) {
      const shim = app.isPackaged
        ? path.join(process.resourcesPath, 'mcp-bundle', 'shim.js')
        : path.join(app.getAppPath(), 'dist', 'mcp', 'mcp', 'shim.js');
      if (fs.existsSync(shim)) return shim;
      console.error('[McpRegistrar] WMUX_MCP_BROKER=1 but shim.js missing — falling back to full bundle');
    }

    if (app.isPackaged) {
      // Production: bundled single-file in resources/mcp-bundle/
      const bundlePath = path.join(process.resourcesPath, 'mcp-bundle', 'index.js');
      if (fs.existsSync(bundlePath)) return bundlePath;
      // Fallback: old layout (resources/mcp/mcp/index.js)
      const legacyPath = path.join(process.resourcesPath, 'mcp', 'mcp', 'index.js');
      if (fs.existsSync(legacyPath)) return legacyPath;
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
   * Install the Codex notify bridge to a STABLE, version-free location
   * (`~/.wmux/hooks/wmux-codex-notify.mjs`) and register it as Codex's `notify`
   * program. Copying fresh on every boot keeps the installed script in lock-step
   * with the running app version while the config path never goes stale (unlike
   * the versioned resources path). Skip-if-foreign lives in registerCodexNotify.
   */
  private installAndRegisterCodexNotify(): void {
    const src = this.getCodexNotifySourcePath();
    if (!src) {
      console.warn('[McpRegistrar] Codex notify script not found — skipping notify registration.');
      return;
    }
    const dest = path.join(this.home, '.wmux', 'hooks', CODEX_NOTIFY_BASENAME);
    try {
      const destDir = path.dirname(dest);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, dest);
    } catch (err) {
      console.error('[McpRegistrar] Failed to install Codex notify script:', err);
      return;
    }
    const result = registerCodexNotify(this.home, dest);
    if (result.skipped === 'foreign') {
      // Surface the skip (GLM outside-voice: don't silently downgrade). The
      // user's own notify is preserved; Codex resume falls back to the pill's
      // `codex resume --last`. Also queryable via getStatus().codexNotify.
      console.warn(
        `[McpRegistrar] Codex notify: skipped — a foreign notify occupies the slot in ${result.configPath}. ` +
        'Codex resume auto-capture is OFF; the resume pill falls back to `codex resume --last`.',
      );
    } else if (result.wrote) {
      console.log(`[McpRegistrar] Codex notify → ${dest}`);
    }
  }
}
