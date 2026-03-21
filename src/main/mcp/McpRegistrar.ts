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

      this.registerInClaudeJson(mcpEntry);

      this.registered = true;
      console.log(`[McpRegistrar] Registered wmux MCP → ${mcpScript}`);
    } catch (err) {
      console.error('[McpRegistrar] Failed to register:', err);
    }
  }

  /**
   * Remove wmux MCP server entry from Claude Code config.
   * Token file is intentionally NOT deleted — it is reused across restarts
   * (dev mode: Vite hot-reload, production: overwritten by next register()).
   */
  unregister(): void {
    if (!this.registered) return;

    try {
      this.unregisterFromClaudeJson();
      console.log('[McpRegistrar] Unregistered wmux MCP.');
    } catch (err) {
      console.error('[McpRegistrar] Failed to unregister:', err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private registerInClaudeJson(mcpEntry: Record<string, any>): void {
    const config = this.readJson(this.claudeJsonPath);
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers['wmux'] = mcpEntry;
    this.writeJson(this.claudeJsonPath, config);
  }

  private unregisterFromClaudeJson(): void {
    const config = this.readJson(this.claudeJsonPath);
    if (config.mcpServers?.['wmux']) {
      delete config.mcpServers['wmux'];
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
      this.writeJson(this.claudeJsonPath, config);
    }
  }

  private getMcpScriptPath(): string | null {
    if (app.isPackaged) {
      const resourcePath = path.join(process.resourcesPath, 'mcp', 'mcp', 'index.js');
      if (fs.existsSync(resourcePath)) return resourcePath;
      return null;
    }

    // In dev mode, app.getAppPath() returns .vite/build, so walk up to project root
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
