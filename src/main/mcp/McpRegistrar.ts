import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { getAuthTokenPath, getPipeName } from '../../shared/constants';
import { secureWriteTokenFile } from '../../shared/security';
import { isMac } from '../../shared/platform';
import { formatMacosError, MACOS_ERRORS } from '../../shared/errors/macos';

/** Per-server registration state surfaced via getStatus(). */
export interface McpServerStatus {
  registered: boolean;
  /** Resolved script path written to ~/.claude.json, or null when not registered. */
  path: string | null;
}

/** Aggregate snapshot of MCP integration state for CLI / Settings UI. */
export interface McpRegistrarStatus {
  wmux: McpServerStatus;
  wmuxA2a: McpServerStatus;
  /** Absolute path to the Claude Code user config file (~/.claude.json). */
  configPath: string;
  configExists: boolean;
  /** Last-modified timestamp (mtime) of the config file, or null when missing. */
  configModified: Date | null;
}

/**
 * Registers/unregisters the wmux MCP server in Claude Code's config files
 * and writes the auth token to a well-known file so the MCP server can read it.
 *
 * The MCP server uses:
 *   - Fixed pipe path: \\.\pipe\wmux  (from shared/constants)
 *   - Auth token file: ~/.wmux-auth-token (written here, read by MCP)
 *
 * Config files written:
 *   1. ~/.claude.json   (user-level MCP config — where Claude Code reads mcpServers)
 *
 * NOTE (cross-platform): the path `~/.claude.json` is currently used on every
 * OS. macOS Claude Desktop may use `~/Library/Application Support/Claude/`
 * instead — macOS verification pending — see plan Phase 1.17 prereq. Do NOT
 * add the macOS-specific path here speculatively; gate that behind empirical
 * verification and ship as a separate change.
 */
export class McpRegistrar {
  private readonly claudeJsonPath: string;
  private readonly authTokenPath: string;
  private registered = false;
  /** Keys that WinMux actually wrote (so we only unregister our own). */
  private readonly ownedKeys = new Set<string>();

  constructor() {
    const home = app.getPath('home');
    this.claudeJsonPath = path.join(home, '.claude.json');
    this.authTokenPath = getAuthTokenPath();
  }

  /** Absolute path to the Claude Code user config file. */
  getClaudeJsonPath(): string {
    return this.claudeJsonPath;
  }

  /**
   * Read-only snapshot of MCP registration state. Used by `wmux mcp check`
   * and the Settings → General → MCP section to surface whether Claude Code
   * can discover the wmux MCP servers.
   *
   * Pure read — never creates the config file or its parent directory, never
   * throws. Corrupted JSON or missing files yield "not registered".
   */
  getStatus(): McpRegistrarStatus {
    let configExists = false;
    let configModified: Date | null = null;
    try {
      const stat = fs.statSync(this.claudeJsonPath);
      configExists = stat.isFile();
      configModified = configExists ? stat.mtime : null;
    } catch {
      configExists = false;
    }

    let wmuxPath: string | null = null;
    let a2aPath: string | null = null;
    if (configExists) {
      try {
        const raw = fs.readFileSync(this.claudeJsonPath, 'utf8');
        const config = JSON.parse(raw, (key, value) => {
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
          return value;
        }) as { mcpServers?: Record<string, unknown> };
        const servers = config && typeof config === 'object' ? config.mcpServers : null;
        if (servers && typeof servers === 'object') {
          wmuxPath = extractScriptPath(servers['wmux']);
          a2aPath = extractScriptPath(servers['wmux-a2a']);
        }
      } catch {
        // Corrupted config — surface as "not registered" rather than throw.
      }
    }

    return {
      wmux: { registered: wmuxPath !== null, path: wmuxPath },
      wmuxA2a: { registered: a2aPath !== null, path: a2aPath },
      configPath: this.claudeJsonPath,
      configExists,
      configModified,
    };
  }

  /**
   * Force-remove the wmux + wmux-a2a keys from ~/.claude.json. Unlike
   * {@link unregister} (intentionally a no-op to avoid the chicken-and-egg
   * problem on app quit), this is invoked from explicit user actions — the
   * `wmux mcp unregister` CLI and the Settings panel "Unregister" button.
   *
   * Other mcpServers entries are left untouched.
   */
  forceUnregister(): void {
    try {
      this.unregisterFromClaudeJson(['wmux', 'wmux-a2a']);
      this.ownedKeys.delete('wmux');
      this.ownedKeys.delete('wmux-a2a');
      this.registered = false;
      console.log('[McpRegistrar] Force-unregistered wmux + wmux-a2a from ~/.claude.json');
    } catch (err) {
      console.error('[McpRegistrar] Failed to force-unregister:', err);
    }
  }

  /**
   * Write auth token to file and register MCP server in Claude Code configs.
   * Must be called after PipeServer.start().
   */
  register(authToken: string): void {
    try {
      // Write auth token to file so MCP server can read it
      secureWriteTokenFile(this.authTokenPath, authToken);
      console.log(`[McpRegistrar] Auth token written to ${this.authTokenPath}`);

      const mcpScript = this.getMcpScriptPath();
      if (!mcpScript) {
        console.warn('[McpRegistrar] Could not determine MCP script path — skipping registration.');
        return;
      }

      // Use 'node' instead of process.execPath, which returns electron.exe at runtime
      // Note: do NOT set env field — Claude Code may replace (not merge) the
      // subprocess environment, breaking PATH/USERPROFILE. getPipeName() uses
      // os.userInfo().username which works without env vars.
      const mcpEntry = {
        command: 'node',
        args: [mcpScript],
      };

      this.registerInClaudeJson('wmux', mcpEntry);

      // Register wmux-a2a MCP server (Agent-to-Agent communication)
      const a2aScript = this.getA2aScriptPath();
      if (a2aScript) {
        this.registerInClaudeJson('wmux-a2a', {
          command: 'node',
          args: [a2aScript],
        });
        console.log(`[McpRegistrar] Registered wmux-a2a MCP → ${a2aScript}`);
      }

      // Clean up legacy MCP keys from previous versions
      this.removeLegacyKeys(['wmux-playwright', 'wmux-devtools']);

      this.registered = true;
      console.log(`[McpRegistrar] Registered wmux MCP → ${mcpScript}`);
    } catch (err) {
      console.error('[McpRegistrar] Failed to register:', err);
      // macOS users hitting Time Machine restore / sudo-written ~/.claude.json
      // see ENOACCES/EACCES/EPERM and have no way to know the fix is `chmod 600`.
      // Surface the catalog entry so the next stderr line shows the exact command.
      // Other platforms / other errors are unaffected.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (isMac && (code === 'EACCES' || code === 'ENOACCES' || code === 'EPERM')) {
        console.error('\n' + formatMacosError(MACOS_ERRORS.mcpPermissionDenied));
      }
    }
  }

  /**
   * Previously removed MCP entries on quit, but this caused a chicken-and-egg
   * problem: Claude Code couldn't find the MCP server because wmux deleted it
   * on exit. Now we keep the registration persistent — the MCP server process
   * handles pipe-not-available gracefully when wmux isn't running.
   */
  unregister(): void {
    // Intentionally no-op: keep MCP registration persistent in ~/.claude.json
    // so Claude Code can always discover the wmux MCP server.
    this.ownedKeys.clear();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private registerInClaudeJson(key: string, mcpEntry: Record<string, any>): void {
    const config = this.readJson(this.claudeJsonPath);
    if (!config.mcpServers) config.mcpServers = {};

    const existing = config.mcpServers[key];
    if (existing && !this.ownedKeys.has(key)) {
      // Always overwrite if the script path changed (e.g. after app update).
      // Previous logic skipped registration when the key existed from a prior
      // session, leaving stale paths pointing to old app versions.
      const existingArgs = JSON.stringify(existing.args ?? []);
      const newArgs = JSON.stringify(mcpEntry.args ?? []);
      if (existingArgs === newArgs) {
        console.log(`[McpRegistrar] Key "${key}" already up-to-date — skipping.`);
        this.ownedKeys.add(key);
        return;
      }
      console.log(`[McpRegistrar] Key "${key}" path changed — updating.`);
    }

    config.mcpServers[key] = mcpEntry;
    this.writeJson(this.claudeJsonPath, config);
    this.ownedKeys.add(key);
  }

  /**
   * Remove legacy MCP keys that WinMux no longer manages.
   * These are cleaned up regardless of who originally wrote them.
   */
  private removeLegacyKeys(keys: string[]): void {
    const config = this.readJson(this.claudeJsonPath);
    if (!config.mcpServers) return;

    let changed = false;
    for (const key of keys) {
      if (config.mcpServers[key]) {
        delete config.mcpServers[key];
        changed = true;
        console.log(`[McpRegistrar] Removed legacy key "${key}"`);
      }
    }
    if (changed) {
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
      this.writeJson(this.claudeJsonPath, config);
    }
  }

  private unregisterFromClaudeJson(keys: string[]): void {
    const config = this.readJson(this.claudeJsonPath);
    if (!config.mcpServers) return;

    let changed = false;
    for (const key of keys) {
      if (config.mcpServers[key]) {
        delete config.mcpServers[key];
        changed = true;
      }
    }
    if (changed) {
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
      this.writeJson(this.claudeJsonPath, config);
    }
  }

  private getMcpScriptPath(): string | null {
    if (app.isPackaged) {
      // Production: bundled single-file in resources/mcp-bundle/
      const bundlePath = path.join(process.resourcesPath, 'mcp-bundle', 'index.js');
      if (fs.existsSync(bundlePath)) return bundlePath;
      // Fallback: old layout (resources/mcp/mcp/index.js)
      const legacyPath = path.join(process.resourcesPath, 'mcp', 'mcp', 'index.js');
      if (fs.existsSync(legacyPath)) return legacyPath;
      return null;
    }

    // Dev mode: use the unbundled tsc output (has access to node_modules)
    const appPath = app.getAppPath();

    const devPath = path.join(appPath, 'dist', 'mcp', 'mcp', 'index.js');
    if (fs.existsSync(devPath)) return devPath;

    // Walk up directories until we find dist/mcp/mcp/index.js or hit root
    let current = appPath;
    for (let i = 0; i < 5; i++) {
      const parent = path.resolve(current, '..');
      if (parent === current) break;
      const candidate = path.join(parent, 'dist', 'mcp', 'mcp', 'index.js');
      if (fs.existsSync(candidate)) return candidate;
      current = parent;
    }

    return null;
  }

  private getA2aScriptPath(): string | null {
    if (app.isPackaged) {
      const bundlePath = path.join(process.resourcesPath, 'a2a-bundle', 'index.js');
      if (fs.existsSync(bundlePath)) return bundlePath;
      return null;
    }

    const appPath = app.getAppPath();
    const devPath = path.join(appPath, 'dist', 'mcp', 'mcp', 'a2a', 'index.js');
    if (fs.existsSync(devPath)) return devPath;

    let current = appPath;
    for (let i = 0; i < 5; i++) {
      const parent = path.resolve(current, '..');
      if (parent === current) break;
      const candidate = path.join(parent, 'dist', 'mcp', 'mcp', 'a2a', 'index.js');
      if (fs.existsSync(candidate)) return candidate;
      current = parent;
    }

    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readJson(filePath: string): Record<string, any> {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'), (key, value) => {
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
          return value;
        });
      }
    } catch { /* corrupted — start fresh */ }

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return {};
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private writeJson(filePath: string, data: Record<string, any>): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, filePath);
  }
}

/**
 * Extract the MCP script path from a `mcpServers[key]` entry.
 *
 * wmux always writes entries shaped `{ command: 'node', args: [scriptPath] }`,
 * so the script path is the first arg. Returns null when the entry is absent
 * or malformed (foreign edits, schema drift) — getStatus() then reports the
 * server as not registered rather than fabricating a path.
 */
function extractScriptPath(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const args = (entry as { args?: unknown }).args;
  if (!Array.isArray(args) || args.length === 0) return null;
  const first = args[0];
  return typeof first === 'string' && first.length > 0 ? first : null;
}
