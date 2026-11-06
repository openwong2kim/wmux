// ─── wmux role resolve <Role> ────────────────────────────────────────────────
//
// Read-only bridge for launchers wmux does not assemble itself (a project's
// own dispatch scripts): prints what a role is bound to in Settings → Roles &
// fan-out, as tokens a script can exec without re-implementing each CLI's
// grammar.
//
// Reads the app's session.json directly (the renderer persists the bindings
// there), so it works whether or not wmux is running, and re-normalizes with
// the same normalizeRoleBinding the app uses — session.json is hand-editable.
//
// Exit codes: 0 bound · 2 role not bound · 1 session file missing/unreadable.
// Zero Electron dependencies: must stay importable into the CLI bundle.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataSuffix } from '../../shared/constants';
import { ROLE_TOOL_SURFACES, resolveRoleName, roleMcpArgv, type WmuxServerLauncher } from '../../shared/roleSurfaces';
import { CORE_TOOL_SURFACE } from '../../shared/coreSurface';
import { codexConfigPath, codexHasWmuxServer, codexWmuxLauncher } from '../../shared/mcpRegistration';
import {
  applyRoleBinding, bindingEnforcesFreshContext, bindingEnforcesSkipPermissions, normalizeRoleBindings,
  type RoleBinding, type WmuxTools,
} from '../../shared/orchestratorRole';
import { tokenize } from '../../shared/agentResume';
import { customAgentLaunchLine, customAgentStem, findCustomAgent, normalizeCustomAgentsReport, type CustomAgent, type CustomAgentDropped } from '../../shared/customAgents';
import { unresolvedCustomAgent } from '../../shared/fanoutPreset';
import { agyEffortOf } from '../../shared/modelCatalog';

/** Electron's `app.getPath('userData')` for productName "wmux", with the same
 *  WMUX_DATA_SUFFIX isolation main applies (`-dev` for dev builds). */
export function defaultSessionPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = os.homedir();
  const base =
    platform === 'win32'
      ? env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return path.join(base, `wmux${dataSuffix()}`, 'session.json');
}

export interface ResolvedRole {
  role: string;
  agent?: string;
  model?: string;
  /** For agy this is the model id suffix, never a separate flag. */
  effort?: string;
  skipPermissions: boolean;
  /** A new task sent to a pane in this role starts a fresh conversation
   *  (#1680): the setting is on AND the agent has a verified command. */
  freshContext: boolean;
  /** The full launch, launcher first, as exec-ready tokens. */
  argv: string[];
  /** Flags only (argv without the launcher), for scripts that own the launcher. */
  flags: string[];
  /** The role's wmux MCP surface. `argv` is opt-in: append it to the launch to
   *  narrow the agent's wmux tools (see src/shared/roleSurfaces.ts). */
  mcp?: { level: WmuxTools; tools: string[]; argv: string[] };
  /** Why a tool level the binding asks for has no `mcp` argv. */
  mcpUnavailable?: string;
}

/** The stdio bundle the CLI configs register. McpRegistrar stabilizes the
 *  packaged bundle into `<home>/.wmux/mcp/` with NO data suffix (one copy per
 *  user), so a suffixed instance must not look under its own data dir. */
export function defaultMcpEntry(home: string = os.homedir()): string {
  return path.join(home, '.wmux', 'mcp', 'index.js');
}

/** The operator's custom agents (main's custom-agents.json, in the wmux data
 *  folder next to the daemon's files). */
export function defaultCustomAgentsPath(home: string = os.homedir()): string {
  return path.join(home, `.wmux${dataSuffix()}`, 'custom-agents.json');
}

export function resolveRole(
  role: string,
  binding: RoleBinding,
  mcpEntry = defaultMcpEntry(),
  codexRegistered: () => boolean = () => codexHasWmuxServer(codexConfigPath(process.env)),
  customAgents: readonly CustomAgent[] = [],
  /** What the codex config runs for wmux; an override must carry its args. */
  codexLauncher: (entry: string) => WmuxServerLauncher = (entry) => codexWmuxLauncher(codexConfigPath(process.env), entry),
): ResolvedRole {
  const agent = binding.agent;
  const effort = agent === 'agy' ? (binding.model ? agyEffortOf(binding.model) : undefined) : binding.effort;
  // A role bound to a custom agent launches its command and arguments as typed.
  const custom = agent ? findCustomAgent(agent, customAgents) : undefined;
  const argv = agent
    ? tokenize(applyRoleBinding(custom ? customAgentLaunchLine(custom) : agent, binding, {
      spawnedProcess: true,
      ...(custom ? { customAgents } : {}),
    }).command).map((t) => t.value)
    : [];
  return {
    role,
    ...(agent ? { agent } : {}),
    ...(binding.model ? { model: binding.model } : {}),
    ...(effort ? { effort } : {}),
    // What the launch in `argv` does, not the stored setting: a permission
    // flag in the role's args withholds the skip, a skip flag in them adds it.
    skipPermissions: bindingEnforcesSkipPermissions(binding),
    freshContext: bindingEnforcesFreshContext(binding),
    argv,
    flags: argv.slice(1),
    ...mcpFor(role, agent, binding.tools, agent === 'codex' ? codexLauncher(mcpEntry) : mcpEntry, codexRegistered),
  };
}

/** Only when the binding picks a tool level (Settings > Token usage, or by
 *  hand): an unset level means "leave the CLI's own wmux registration alone". */
function mcpFor(
  role: string,
  agent: string | undefined,
  tools: WmuxTools | undefined,
  entry: WmuxServerLauncher,
  codexRegistered: () => boolean,
): Pick<ResolvedRole, 'mcp' | 'mcpUnavailable'> {
  if (!agent || !tools) return {};
  // codex refuses to start on a -c mcp_servers.wmux override when its config
  // registers no wmux server (same rule as main's launch splice).
  if (agent === 'codex' && !codexRegistered()) {
    return { mcpUnavailable: 'codex has no wmux MCP server registered; codex would refuse a -c mcp_servers.wmux override' };
  }
  const known = resolveRoleName(role);
  if (tools === 'role' && known.kind !== 'role') return {};
  const orchRole = known.kind === 'role' ? known.role : undefined;
  const argv = orchRole ? roleMcpArgv(agent, orchRole, entry, tools) : roleMcpArgv(agent, 'Planner', entry, tools);
  if (!argv) return {};
  const list = tools === 'role' && orchRole ? [...ROLE_TOOL_SURFACES[orchRole]] : tools === 'core' ? [...CORE_TOOL_SURFACE] : ['*'];
  return { mcp: { level: tools, tools: list, argv } };
}

export interface RoleDeps {
  sessionPath: string;
  customAgentsPath: string;
  readFile: (p: string) => string;
  /** The MCP bundle entry `mcp.argv` points at. */
  mcpEntry: string;
  exists: (p: string) => boolean;
  log: (line: string) => void;
  error: (line: string) => void;
  exit: (code: number) => void;
  /** The platform the custom agents are validated for (main's rules). */
  platform: NodeJS.Platform;
}

const USAGE = 'Usage: wmux role resolve <Role> [--json] [--session <path>]';

export async function handleRole(args: string[], jsonMode: boolean, overrides: Partial<RoleDeps> = {}): Promise<void> {
  const deps: RoleDeps = {
    sessionPath: defaultSessionPath(),
    customAgentsPath: defaultCustomAgentsPath(),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    mcpEntry: defaultMcpEntry(),
    exists: (p) => fs.existsSync(p),
    log: (l) => console.log(l),
    error: (l) => console.error(l),
    exit: (c) => process.exit(c),
    platform: process.platform,
    ...overrides,
  };
  const [sub, role, ...rest] = args;
  if (sub !== 'resolve' || !role) {
    deps.error(USAGE);
    deps.exit(1);
    return;
  }
  const sessionFlag = rest.indexOf('--session');
  const sessionPath = sessionFlag >= 0 && rest[sessionFlag + 1] ? rest[sessionFlag + 1] : deps.sessionPath;

  let bindings;
  try {
    const data: unknown = JSON.parse(deps.readFile(sessionPath));
    // A root that is not an object is a corrupt file, not "no bindings": report
    // it as unreadable (exit 1) so a script does not read it as "not bound".
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('session data is not a JSON object');
    }
    bindings = normalizeRoleBindings((data as { orchestratorRoleBindings?: unknown }).orchestratorRoleBindings);
  } catch (err) {
    deps.error(`wmux role: cannot read ${sessionPath}: ${(err as Error).message}`);
    deps.exit(1);
    return;
  }
  // Own keys only: `constructor` / `toString` are not roles.
  const binding = Object.hasOwn(bindings, role) ? bindings[role] : undefined;
  if (!binding) {
    if (jsonMode) deps.log(JSON.stringify({ role, bound: false }));
    else deps.error(`Role "${role}" is not bound in Settings → Roles & fan-out.`);
    deps.exit(2);
    return;
  }
  let customAgents: CustomAgent[] = [];
  let raw: unknown;
  let unreadable: string | undefined;
  let dropped: CustomAgentDropped[] = [];
  try {
    raw = (JSON.parse(deps.readFile(deps.customAgentsPath)) as { agents?: unknown })?.agents;
    const report = normalizeCustomAgentsReport(raw, { platform: deps.platform });
    customAgents = report.agents;
    dropped = report.dropped;
  } catch (err) {
    // No file is no custom agents, not a read problem.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') unreadable = (err as Error).message;
  }
  // A role bound to a custom agent main cannot find would not launch: say so,
  // and why, rather than print a command line nothing will run.
  const agent = binding.agent?.toLowerCase();
  if (agent && unresolvedCustomAgent(agent, customAgents)) {
    const drop = Array.isArray(raw)
      ? dropped.find((d) => {
        const entry = raw[d.index] as { command?: unknown } | null;
        return typeof entry?.command === 'string' && customAgentStem({ command: entry.command }) === agent;
      })
      : undefined;
    const why = drop
      ? drop.issue.error
      : unreadable !== undefined
        ? `cannot read ${deps.customAgentsPath}: ${unreadable}`
        : `no custom agent "${agent}" is defined in ${deps.customAgentsPath}`;
    if (jsonMode) deps.log(JSON.stringify({ role, bound: true, unavailable: why }));
    else deps.error(`wmux role: Role "${role}" runs "${agent}", which cannot launch: ${why}`);
    deps.exit(1);
    return;
  }
  const resolved = resolveRole(role, binding, deps.mcpEntry, undefined, customAgents);
  // Never print an argv that points at a bundle that is not there (a dev
  // checkout, or a packaged app that has not booted once to stabilize it).
  if (resolved.mcp && resolved.mcp.argv.length > 0 && !deps.exists(deps.mcpEntry)) {
    delete resolved.mcp;
    resolved.mcpUnavailable = `wmux MCP bundle not found at ${deps.mcpEntry}`;
  }
  if (jsonMode) {
    deps.log(JSON.stringify({ bound: true, ...resolved }));
  } else {
    deps.log(resolved.argv.join(' ') || `(role "${role}" has no agent bound)`);
  }
}
