// ─── Per-role MCP surfaces (launch-time optimization, like --core) ───────────
//
// `--role=<Role>` narrows tools/list to what an orchestrator role actually
// calls. Like `--core` (src/shared/coreSurface.ts) it is an OPTIMIZATION, not a
// security boundary: no role claim, no token, no RPC lane changes. A pane that
// wants more simply launches without the flag.
//
// Every surface is a subset of CORE_TOOL_SURFACE (asserted in
// src/shared/__tests__/roleSurfaces.test.ts), so the server runs the core
// profile and then drops every name outside the role's list.
//
// Builder / Tester get only what a fan-out worker is told to do in
// WORKER_DELIVERY_PREAMBLE (FanOutService.ts): record its ledger row, read and
// acknowledge its mission channel, post completion there, and check for
// follow-up work with a2a_task_query. A Tester also
// reads the output of the pane it checks. Nothing that types into other panes.

import type { OrchRole, WmuxTools } from './orchestratorRole';

export const ROLE_TOOL_SURFACES: Readonly<Record<OrchRole, readonly string[]>> = {
  Planner: [
    'terminal_read',
    'terminal_send',
    'terminal_send_key',
    'pane_list',
    'pane_metadata',
    'send_message',
  ],
  Reviewer: [
    'terminal_read',
    'workspace_list',
    'pane_list',
    'channel_join',
    'channel_post',
  ],
  Builder: [
    'ledger_update',
    'task_push',
    'task_fetch',
    'channel_read',
    'channel_unread',
    'channel_ack',
    'channel_post',
    'a2a_task_query',
  ],
  Tester: [
    'ledger_update',
    'channel_read',
    'channel_unread',
    'channel_ack',
    'channel_post',
    'a2a_task_query',
    'terminal_read',
    'pane_list',
  ],
};

/** Arguments for the `wmux` stdio server at a tool level. */
export function wmuxServerArgs(entry: string, tools: WmuxTools, role?: OrchRole): string[] {
  if (tools === 'core') return [entry, '--core'];
  if (tools === 'role' && role) return [entry, `${ROLE_MODE_ARG_PREFIX}${role}`];
  return [entry];
}

function surfaceIsEmpty(tools: WmuxTools, role?: OrchRole): boolean {
  return tools === 'role' && !!role && ROLE_TOOL_SURFACES[role].length === 0;
}

/**
 * Exec-ready tokens (no shell) that point an agent CLI's `wmux` MCP server at a
 * tool level, keeping the server NAME "wmux" so it replaces the user-level
 * registration instead of adding a second one. Verified 2026-09-30:
 *   - claude 2.1.285: `--mcp-config <inline json or file>` with a server named
 *     `wmux` replaces the ~/.claude.json one (init lists one wmux, exactly the
 *     surface's tools); other servers stay, so no `--strict-mcp-config`.
 *   - codex 0.159.2: `-c mcp_servers.wmux.args=[...]` overrides the args
 *     (`codex mcp get wmux`), `-c mcp_servers.wmux.enabled=false` disables it.
 *   - agy: no MCP servers are registered, nothing to narrow.
 * `entry` is the stdio bundle the CLI configs already use (~/.wmux/mcp/index.js).
 * Returns null for agents with no verified grammar.
 */
export function roleMcpArgv(agent: string, role: OrchRole, entry: string, tools: WmuxTools = 'role'): string[] | null {
  const serverArgs = wmuxServerArgs(entry, tools, role);
  switch (agent) {
    case 'claude':
      // One `=` token: --mcp-config is variadic, so a separate value would let it
      // swallow a positional prompt that follows.
      return [`--mcp-config=${JSON.stringify({ mcpServers: { wmux: { command: 'node', args: serverArgs } } })}`];
    case 'codex':
      // JSON string escaping is valid TOML basic-string escaping.
      return surfaceIsEmpty(tools, role)
        ? ['-c', 'mcp_servers.wmux.enabled=false']
        : ['-c', `mcp_servers.wmux.args=${JSON.stringify(serverArgs)}`];
    case 'agy':
      return [];
    default:
      return null;
  }
}

/**
 * The same, as text for a SHELL line (a pane's typed initial command, bash or
 * PowerShell). No JSON on the line — PowerShell 5.1 mangles embedded double
 * quotes on the way to a native exe — so claude gets a config FILE the caller
 * wrote (`claudeConfigFile`, see wmuxServerArgs), and codex gets TOML literal
 * strings ('...') inside one double-quoted argument. A path carrying a quote of
 * either kind is refused (null) rather than escaped per shell.
 */
export function toolSurfaceShellFlags(
  agent: string,
  tools: WmuxTools,
  entry: string,
  role: OrchRole | undefined,
  claudeConfigFile: string,
): string | null {
  if (/['"`$]/.test(entry) || /['"`$]/.test(claudeConfigFile)) return null;
  switch (agent) {
    case 'claude':
      // The `=` form: --mcp-config is variadic, and the flags land right after
      // the launcher, so `claude "<prompt>"` would lose its prompt to it.
      return `--mcp-config="${claudeConfigFile}"`;
    case 'codex': {
      if (surfaceIsEmpty(tools, role)) return '-c mcp_servers.wmux.enabled=false';
      const list = wmuxServerArgs(entry, tools, role).map((a) => `'${a}'`).join(',');
      return `-c "mcp_servers.wmux.args=[${list}]"`;
    }
    default:
      return null;
  }
}

/** Launch argument prefix. An argv flag, never an env var (same rule as
 *  CORE_MODE_ARG): the client config declares it in the server `args`. */
export const ROLE_MODE_ARG_PREFIX = '--role=';

export type RoleArg =
  | { kind: 'none' }
  | { kind: 'role'; role: OrchRole }
  | { kind: 'unknown'; value: string };

/** Read `--role=<Role>` from argv (last one wins, case-sensitive role name). */
export function parseRoleArg(argv: readonly string[]): RoleArg {
  return resolveRoleName(roleArgValue(argv));
}

/** The raw `--role=` value from argv (last one wins), or undefined. Passed
 *  through unvalidated so the server can report an unknown name itself. */
export function roleArgValue(argv: readonly string[]): string | undefined {
  const hit = [...argv].reverse().find((a) => a.startsWith(ROLE_MODE_ARG_PREFIX));
  return hit === undefined ? undefined : hit.slice(ROLE_MODE_ARG_PREFIX.length);
}

/** Validate a role name from argv or a shim handshake. */
export function resolveRoleName(value: string | undefined): RoleArg {
  if (value === undefined || value === '') return { kind: 'none' };
  return Object.prototype.hasOwnProperty.call(ROLE_TOOL_SURFACES, value)
    ? { kind: 'role', role: value as OrchRole }
    : { kind: 'unknown', value };
}
