// ─── wmux MCP tool level on a role-bound launch ──────────────────────────────
//
// A role binding may pick how many wmux tools its agent sees (RoleBinding.tools,
// set by Settings > Token usage). The renderer cannot know where the MCP bundle
// lives, so it sends the level with the pane create and main splices the flags
// into the typed launch line here, right after the launcher.
//
// claude reads a config FILE (no JSON on a PowerShell line), written next to the
// bundle; codex takes `-c "mcp_servers.wmux.args=['…']"`. A line that already
// configures the wmux server by hand is left alone (the operator's line wins).
//
// codex only accepts those overrides on top of a registered server: with no
// `[mcp_servers.wmux]` table in its config.toml, both `-c mcp_servers.wmux.args=…`
// and `-c mcp_servers.wmux.enabled=false` abort the launch with "invalid
// transport in `mcp_servers.wmux`" (codex-cli 0.158). So a codex line gets the
// flags only when its config already holds a wmux server with a command; it
// otherwise launches unchanged, with the full tool list.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getWmuxHomeDir } from '../../shared/constants';
import { externalRegistrationSkipReason } from '../../shared/mcpTargets';
import { codexConfigPath, codexHasWmuxServer } from '../../shared/mcpRegistration';
import { tokenize, launcherStem } from '../../shared/agentResume';
import { WMUX_TOOLS, type WmuxTools } from '../../shared/orchestratorRole';
import { resolveRoleName, toolSurfaceShellFlags, wmuxServerArgs } from '../../shared/roleSurfaces';
import { splitModelEnvMarker } from '../../shared/workerLaunch';

export interface WmuxToolsHint {
  tools: WmuxTools;
  role?: string;
}

export function isWmuxToolsHint(value: unknown): value is WmuxToolsHint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (WMUX_TOOLS as readonly unknown[]).includes(v.tools) && (v.role === undefined || typeof v.role === 'string');
}

export interface McpEntryLocation {
  /** The user's home (electron app.getPath('home')). */
  home: string;
  isPackaged: boolean;
  resourcesPath?: string;
  appPath?: string;
  exists?: (p: string) => boolean;
  /** Path rules to resolve with (default: this platform's). Tests pass
   *  path.posix / path.win32 to cover both on any OS. */
  pathApi?: path.PlatformPath;
  /** An isolated (suffixed) instance: McpRegistrar never syncs the stable
   *  copy there (externalRegistrationSkipReason), so that copy is whatever
   *  the installed app last wrote and the app's own bundle goes first.
   *  Default: read from the environment. */
  isolated?: boolean;
}

/**
 * Where the full wmux MCP bundle actually lives, resolved the way McpRegistrar
 * resolves the script it registers:
 *   - packaged: the stable copy McpRegistrar keeps in `<home>/.wmux/mcp/`
 *     (no data suffix: one copy per user, see stabilizePackaged), else the
 *     versioned `resources/mcp-bundle/index.js` (or the old resources layout);
 *     an isolated instance never syncs that copy, so there the app's own
 *     bundle comes first and the copy is the fallback;
 *   - dev: `dist/mcp/mcp/entry.js` under the app path or one of its parents.
 * null when none exists.
 */
export function locateWmuxMcpEntry(loc: McpEntryLocation): string | null {
  const exists = loc.exists ?? fs.existsSync;
  const p = loc.pathApi ?? path;
  const candidates: string[] = [];
  if (loc.isPackaged) {
    const stable = p.join(loc.home, '.wmux', 'mcp', 'index.js');
    const own = loc.resourcesPath
      ? [p.join(loc.resourcesPath, 'mcp-bundle', 'index.js'), p.join(loc.resourcesPath, 'mcp', 'mcp', 'index.js')]
      : [];
    const isolated = loc.isolated ?? externalRegistrationSkipReason() !== null;
    candidates.push(...(isolated ? [...own, stable] : [stable, ...own]));
  } else if (loc.appPath) {
    let current = loc.appPath;
    for (let i = 0; i < 6; i++) {
      candidates.push(p.join(current, 'dist', 'mcp', 'mcp', 'entry.js'));
      const parent = p.resolve(current, '..');
      if (parent === current) break;
      current = parent;
    }
  }
  return candidates.find((c) => exists(c)) ?? null;
}

export interface ToolSurfaceDeps {
  /** Folder the claude `--mcp-config` files are written to (default: the
   *  instance's data dir `mcp/`, created on demand). */
  mcpDir?: string;
  /** The MCP bundle entry to launch. Default: the packaged stable copy in
   *  `~/.wmux/mcp/index.js` when it exists. Main passes locateWmuxMcpEntry(). */
  entry?: string | null;
  exists?: (p: string) => boolean;
  writeFile?: (p: string, data: string) => void;
  /** Whether the codex config this launch will read registers a wmux server. */
  codexHasWmuxServer?: () => boolean;
  /** Where a skipped splice is reported. */
  log?: (line: string) => void;
}

export function applyWmuxToolsToCommand(fullCommand: string, hint: WmuxToolsHint, deps: ToolSurfaceDeps = {}): string {
  // A fan-out worker line may lead with the model-env marker (POSIX), which
  // hides the launcher from tokens[0]; splice into the rest and put it back.
  const { marker, command } = splitModelEnvMarker(fullCommand);
  if (marker) return marker + applyWmuxToolsToCommand(command, hint, deps);
  const mcpDir = deps.mcpDir ?? path.join(getWmuxHomeDir(), 'mcp');
  const exists = deps.exists ?? fs.existsSync;
  const writeFile = deps.writeFile ?? ((p, d) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, d, 'utf8');
  });
  const tokens = tokenize(command);
  if (tokens.length === 0) return command;
  const stem = launcherStem(tokens[0].value);
  if (stem !== 'claude' && stem !== 'codex') return command;
  if (/--mcp-config\b|mcp_servers\.wmux/.test(command)) return command;
  const entry = deps.entry !== undefined
    ? deps.entry
    : locateWmuxMcpEntry({ home: os.homedir(), isPackaged: true, resourcesPath: process.resourcesPath, exists });
  if (!entry || !exists(entry)) return command;
  const known = resolveRoleName(hint.role);
  const role = known.kind === 'role' ? known.role : undefined;
  if (hint.tools === 'role' && !role) return command;
  const configFile = path.join(mcpDir, `surface-${hint.tools}${role ? `-${role.toLowerCase()}` : ''}.json`);
  const flags = toolSurfaceShellFlags(stem, hint.tools, entry, role, configFile);
  if (!flags) return command;
  if (stem === 'codex') {
    const hasServer = deps.codexHasWmuxServer ?? (() => codexHasWmuxServer(codexConfigPath()));
    if (!hasServer()) {
      const log = deps.log ?? ((line: string) => console.warn(line));
      log(`[pty:create] wmux tool level '${hint.tools}' not applied: codex has no wmux MCP server registered, and codex refuses to start on a -c mcp_servers.wmux override without one`);
      return command;
    }
  }
  if (stem === 'claude') {
    try {
      writeFile(configFile, JSON.stringify({ mcpServers: { wmux: { command: 'node', args: wmuxServerArgs(entry, hint.tools, role) } } }, null, 2));
    } catch {
      return command;
    }
  }
  const at = tokens[0].end;
  return `${command.slice(0, at)} ${flags}${command.slice(at)}`;
}
