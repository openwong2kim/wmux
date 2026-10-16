// ─── A bot's Claude worker: its MCP servers and its rules, per launch ──────
//
// Every claude launch in a bot's worker pane loads exactly the MCP servers
// main wrote for it: wmux (at the `core` or `full` level, never a role
// surface, which lacks the tools a worker reports with) and the connections
// its task was given (shared/botConnector.ts). `--strict-mcp-config` keeps
// the owner's own servers (user, project `.mcp.json`, plugins, claude.ai
// connectors) out. The launch also carries ONE `--settings` file: the worker
// rules (botWorkerGuard.ts BOT_WORKER_DENY) and each connection's tool rules.
// Both files hold names and paths only, never a key value: a stdio server
// inherits the worker's environment, where the task's keys are, and a
// remote header names its key as `${NAME}`, which claude fills in.
//
// Measured on claude 2.1.300 with a local fake Messages API:
//  - strict drops user, project, plugin and claude.ai servers;
//  - a stdio entry's `cwd` key is ignored (the server starts in the worker's
//    folder), so a stdio connection runs as `/usr/bin/env -C <run dir> <its
//    absolute command>`: nothing in the worker's checkout (an `.npmrc`, a
//    `node_modules/.bin`, a relative PATH entry) is looked up, and `-u` takes
//    the other connections' keys out of its environment;
//  - `${NAME}` is filled in in `env` and `headers`;
//  - a bare `mcp__<name>` allow covers every tool of a server (default and
//    auto modes); a `mcp__<name>__<tool>` deny holds under bypass;
//  - a PreToolUse hook whose matcher leaves out the listed tools blocks the
//    others under bypass, but only while the settings say
//    `disableAllHooks: false` (a user or project `true` turns it off);
//  - of two `--settings` flags the last one wins: a line carries exactly one.

import crypto from 'node:crypto';
import { BOT_WORKER_DENY } from './botWorkerGuard';
import type { Connector } from './botConnector';
import { tokenize } from './agentResume';
import { splitModelEnvMarker } from './workerLaunch';
import { stripPromptFileArgument } from './promptFileArgument';
import { argumentsMayExpand, isClaudeLauncher, isQuotable, isSingleCommand } from './botWorkerGuard';
import { wslMcpLaunchOf } from './wslIntegration';

/** The wmux level a worker's server runs at. */
export type WorkerWmuxLevel = 'core' | 'full';

/** The level for a worker launch: a role surface is raised to `core` (its
 *  tools do not include the ones a worker reports with), a commander surface
 *  is never a worker's. Pure. */
export function workerWmuxLevel(...candidates: Array<string | undefined | null>): WorkerWmuxLevel {
  for (const c of candidates) {
    if (c === 'full') return 'full';
    if (c === 'core' || c === 'role' || c === 'commander') return 'core';
  }
  return 'full';
}

/** npm's registry, pinned for a stdio connection (with an empty user
 *  config), so where npx fetches from does not come from the worker's
 *  environment. */
export const CONNECTOR_NPM_REGISTRY = 'https://registry.npmjs.org/';

export interface WorkerMcpInput {
  /** The wmux MCP bundle (locateWmuxMcpEntry). */
  entry: string;
  level: WorkerWmuxLevel;
  connectors: readonly Connector[];
  /** A stdio connection's run folder (outside every worktree). */
  runDir: (c: Connector) => string;
  /** The empty npm user config in that folder. */
  npmrc: (c: Connector) => string;
  /** Other connection keys the worker's environment may hold (a re-fire's
   *  first launch had them): kept out of every stdio server too. */
  strayKeys?: readonly string[];
}

/** A WSL pane's `--mcp-config` document: this build's wmux server, run in
 *  the Windows runtime over interop as a WSL pane's own server is
 *  (wslIntegration.ts WSL_MCP_LAUNCH), so its pipe and caller identity work.
 *  `runtime` is that runtime's /mnt path. A WSL worker takes no connections.
 *  Pure. */
export function buildWslWorkerMcpConfig(runtime: string, entry: string, level: WorkerWmuxLevel): { mcpServers: Record<string, unknown> } {
  return { mcpServers: { wmux: { type: 'stdio', command: '/bin/sh', args: ['-c', wslMcpLaunchOf(runtime, entry, level === 'core' ? ['--core'] : [])] } } };
}

/** The `--mcp-config` document. Pure. */
export function buildWorkerMcpConfig(input: WorkerMcpInput): { mcpServers: Record<string, unknown> } {
  const servers: Record<string, unknown> = {
    wmux: { type: 'stdio', command: 'node', args: input.level === 'core' ? [input.entry, '--core'] : [input.entry] },
  };
  const keysOf = (c: Connector) => c.secrets.map((s) => s.secret);
  for (const c of input.connectors) {
    if (c.transport === 'stdio' && c.stdio) {
      // The other connections' keys are taken out of its environment.
      const others = [...new Set([...input.connectors.filter((o) => o !== c).flatMap(keysOf), ...(input.strayKeys ?? [])])].filter((k) => !keysOf(c).includes(k));
      servers[c.name] = {
        type: 'stdio',
        command: '/usr/bin/env',
        args: ['-C', input.runDir(c), ...others.flatMap((k) => ['-u', k]), c.stdio.command, ...c.stdio.args],
        env: { ...c.stdio.env, npm_config_userconfig: input.npmrc(c), npm_config_registry: CONNECTOR_NPM_REGISTRY },
      };
    } else if (c.remote) {
      const headers: Record<string, string> = { ...c.remote.headers };
      for (const s of c.secrets) {
        if (s.as === 'header') headers[s.header] = s.scheme === 'bearer' ? `Bearer \${${s.secret}}` : `\${${s.secret}}`;
      }
      servers[c.name] = { type: c.transport, url: c.remote.url, headers };
    }
  }
  return { mcpServers: servers };
}

/** The worker's one `--settings` document: the worker rules, and per
 *  connection either every tool but the blocked ones, or only the listed
 *  ones (a per-tool allow plus a hook that refuses the rest). Pure. */
export function buildWorkerSettings(
  connectors: readonly Connector[],
  /** wmux's own hook groups by event (an isolated instance's worker, which
   *  loads no user settings: setupHooks.bridgeHookGroups). */
  wmuxHooks?: Record<string, ReadonlyArray<{ matcher: string; hooks: ReadonlyArray<{ type: 'command'; command: string }> }>>,
): Record<string, unknown> {
  const allow: string[] = [];
  const deny: string[] = [...BOT_WORKER_DENY];
  const hooks: Array<{ matcher: string; hooks: Array<{ type: 'command'; command: string }> }> = [];
  for (const c of connectors) {
    if (c.tools.mode === 'all') {
      allow.push(`mcp__${c.name}`);
      deny.push(...c.tools.blocked.map((t) => `mcp__${c.name}__${t}`));
    } else {
      allow.push(...c.tools.allowed.map((t) => `mcp__${c.name}__${t}`));
      // Names are [a-z0-9-] and tools [A-Za-z0-9_-]: no regex metacharacter
      // but `-`, which is literal outside a class.
      const except = c.tools.allowed.length > 0 ? `(?!(${c.tools.allowed.join('|')})$)` : '';
      hooks.push({
        matcher: `^mcp__${c.name}__${except}.*`,
        hooks: [{ type: 'command', command: `echo 'wmux: the ${c.name} connection allows only its listed tools' >&2; exit 2` }],
      });
    }
  }
  const byEvent: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(wmuxHooks ?? {})) byEvent[event] = groups.map((g) => ({ matcher: g.matcher, hooks: g.hooks.map((h) => ({ ...h })) }));
  if (hooks.length > 0) byEvent.PreToolUse = [...hooks, ...(byEvent.PreToolUse ?? [])];
  return {
    permissions: { ...(allow.length > 0 ? { allow } : {}), deny },
    ...(Object.keys(byEvent).length > 0 ? { disableAllHooks: false, hooks: byEvent } : {}),
  };
}

/** `<sha256-12>.json` of a document's bytes: the file never changes once
 *  written, so a launch and a later resume read the same rules. Pure. */
export function contentFileName(content: string): string {
  return `${crypto.createHash('sha256').update(content).digest('hex').slice(0, 12)}.json`;
}

const SUBSTITUTION = /\$\(|`|<\(|>\(/;

/**
 * Splice `--settings="<s>" --mcp-config="<m>" --strict-mcp-config` right
 * after a `claude` launcher (keeping a leading model-env marker). Returns the
 * line unchanged when exactly these words already follow the launcher, and
 * null when it cannot carry them: another launcher, more than one command, an
 * argument the shell could expand (argumentsMayExpand), an end-of-options
 * `--`, any other settings, MCP config or strict flag, or a path that cannot
 * be quoted. Pure.
 */
export function spliceWorkerLaunch(fullCommand: string, settingsPath: string, mcpPath: string, settingSources?: 'project'): string | null {
  const { marker, command } = splitModelEnvMarker(fullCommand);
  if (!isQuotable(settingsPath) || !isQuotable(mcpPath)) return null;
  const rest = stripPromptFileArgument(command);
  const spliced = ` --settings="${settingsPath}" --mcp-config="${mcpPath}" --strict-mcp-config${settingSources ? ` --setting-sources=${settingSources}` : ''}`;
  // Our own flags, already spliced, hold paths (a Windows one has `\`).
  if (SUBSTITUTION.test(rest) || !isSingleCommand(rest) || argumentsMayExpand(rest.split(spliced).join(''))) return null;
  const tokens = tokenize(command);
  if (tokens.length === 0 || !isClaudeLauncher(tokens[0].value)) return null;
  if (tokens.some((t) => t.value === '--')) return null;
  const ours = [`--settings=${settingsPath}`, `--mcp-config=${mcpPath}`, '--strict-mcp-config', ...(settingSources ? [`--setting-sources=${settingSources}`] : [])];
  const flagged = tokens.slice(1).filter((t) => /^--(settings|mcp-config|strict-mcp-config|setting-sources)(=|$)/.test(t.value));
  if (flagged.length > 0) {
    const same = flagged.length === ours.length && ours.every((w, i) => tokens[1 + i]?.value === w);
    return same ? fullCommand : null;
  }
  const at = tokens[0].end;
  return `${marker}${command.slice(0, at)}${spliced}${command.slice(at)}`;
}
