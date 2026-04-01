import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { getAuthTokenPath, getPipeName } from '../../shared/constants';

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

  /**
   * Write auth token to file and register MCP server in Claude Code configs.
   * Must be called after PipeServer.start().
   */
  register(authToken: string): void {
    try {
      // Write auth token to file so MCP server can read it
      fs.writeFileSync(this.authTokenPath, authToken, { encoding: 'utf8', mode: 0o600 });
      // On Windows, mode 0o600 is ignored. Use icacls to enforce owner-only access.
      if (process.platform === 'win32') {
        try {
          const { execFileSync } = require('child_process');
          const icacls = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\icacls.exe`;
          execFileSync(icacls, [
            this.authTokenPath, '/inheritance:r',
            '/grant:r', `${process.env.USERNAME}:F`
          ], { windowsHide: true });
        } catch (aclErr) {
          console.warn('[McpRegistrar] Could not set file ACL:', aclErr);
        }
      }
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

      // Clean up legacy MCP keys from previous versions
      this.removeLegacyKeys(['wmux-playwright', 'wmux-devtools']);

      this.registered = true;
      console.log(`[McpRegistrar] Registered wmux MCP → ${mcpScript}`);
    } catch (err) {
      console.error('[McpRegistrar] Failed to register:', err);
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readJson(filePath: string): Record<string, any> {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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
