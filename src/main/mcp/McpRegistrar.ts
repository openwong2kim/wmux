import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { getAuthTokenPath } from '../../shared/constants';

/**
 * Registers/unregisters the wmux MCP server in Claude Code's config files
 * and writes the auth token to a well-known file so the MCP server can read it.
 *
 * The MCP server uses:
 *   - Fixed pipe path: \\.\pipe\wmux  (from shared/constants)
 *   - Auth token file: ~/.wmux-auth-token (written here, read by MCP)
 *
 * Config files written:
 *   1. ~/.claude/settings.json   (global settings — mcpServers key)
 *   2. ~/.claude/.mcp.json       (user-level MCP config)
 */
export class McpRegistrar {
  private readonly settingsPath: string;
  private readonly mcpJsonPath: string;
  private readonly authTokenPath: string;
  private registered = false;

  constructor() {
    const home = app.getPath('home');
    this.settingsPath = path.join(home, '.claude', 'settings.json');
    this.mcpJsonPath = path.join(home, '.claude', '.mcp.json');
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
      console.log(`[McpRegistrar] Auth token written to ${this.authTokenPath}`);

      const mcpScript = this.getMcpScriptPath();
      if (!mcpScript) {
        console.warn('[McpRegistrar] Could not determine MCP script path — skipping registration.');
        return;
      }

      // Use absolute node path to avoid PATH resolution issues
      const mcpEntry = {
        command: process.execPath,
        args: [mcpScript],
      };

      this.registerInSettings(mcpEntry);
      this.registerInMcpJson(mcpEntry);

      this.registered = true;
      console.log(`[McpRegistrar] Registered wmux MCP → ${mcpScript}`);
    } catch (err) {
      console.error('[McpRegistrar] Failed to register:', err);
    }
  }

  /**
   * Remove wmux MCP server entry and auth token file.
   */
  unregister(): void {
    // Always clean up auth token file
    try {
      if (fs.existsSync(this.authTokenPath)) {
        fs.unlinkSync(this.authTokenPath);
      }
    } catch { /* ignore */ }

    if (!this.registered) return;

    try {
      this.unregisterFromSettings();
      this.unregisterFromMcpJson();
      console.log('[McpRegistrar] Unregistered wmux MCP.');
    } catch (err) {
      console.error('[McpRegistrar] Failed to unregister:', err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private registerInSettings(mcpEntry: Record<string, any>): void {
    const settings = this.readJson(this.settingsPath);
    if (!settings.mcpServers) settings.mcpServers = {};
    settings.mcpServers['wmux'] = mcpEntry;
    this.writeJson(this.settingsPath, settings);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private registerInMcpJson(mcpEntry: Record<string, any>): void {
    const mcpConfig = this.readJson(this.mcpJsonPath);
    if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    mcpConfig.mcpServers['wmux'] = mcpEntry;
    this.writeJson(this.mcpJsonPath, mcpConfig);
  }

  private unregisterFromSettings(): void {
    const settings = this.readJson(this.settingsPath);
    if (settings.mcpServers?.['wmux']) {
      delete settings.mcpServers['wmux'];
      if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
      this.writeJson(this.settingsPath, settings);
    }
  }

  private unregisterFromMcpJson(): void {
    const mcpConfig = this.readJson(this.mcpJsonPath);
    if (mcpConfig.mcpServers?.['wmux']) {
      delete mcpConfig.mcpServers['wmux'];
      if (Object.keys(mcpConfig.mcpServers).length === 0) delete mcpConfig.mcpServers;
      if (Object.keys(mcpConfig).length === 0) {
        try { fs.unlinkSync(this.mcpJsonPath); } catch { /* ignore */ }
      } else {
        this.writeJson(this.mcpJsonPath, mcpConfig);
      }
    }
  }

  private getMcpScriptPath(): string | null {
    if (app.isPackaged) {
      const resourcePath = path.join(process.resourcesPath, 'mcp', 'mcp', 'index.js');
      if (fs.existsSync(resourcePath)) return resourcePath;
      return null;
    }

    const appPath = app.getAppPath();
    const devPath = path.join(appPath, 'dist', 'mcp', 'mcp', 'index.js');
    if (fs.existsSync(devPath)) return devPath;

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
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }
}
