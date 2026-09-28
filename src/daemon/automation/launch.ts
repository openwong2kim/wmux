// The scheduled-run launch line and environment.
//
// The command string is assembled ONLY from: the fixed launcher plus the
// validated `--model`/`--effort` tokens (buildAgentLaunch), and permission
// flags from the fixed map below. Scoped tool names are re-validated here
// against AUTOMATION_TOOL_NAME_RE so no shell metacharacter can ever reach the
// wrapper shell (bash -lc / pwsh -Command / cmd /c). The folder travels as the
// PTY cwd and the prompt is pasted into the ready agent — neither is ever part
// of this string.

import fs from 'node:fs';
import path from 'node:path';
import {
  AUTOMATION_TOOL_NAME_RE,
  type AutomationAgent,
  type AutomationPermissionMode,
} from '../../shared/automation';
import { CLAUDE_SANDBOXED_ENV } from '../../shared/agentFirstRun';
import { buildWebPaneEnv } from '../web/webPaneEnv';

/**
 * Permission flags per agent and effective mode. `scoped` for claude is
 * completed with the tool names (space-separated, never comma-joined: under
 * `pwsh -Command` a bare `a,b` is an array literal) and must stay the LAST flag
 * group because `--allowedTools` is variadic.
 */
const PERMISSION_FLAGS: Record<AutomationAgent, Record<AutomationPermissionMode, readonly string[]>> = {
  claude: {
    // Pinned: without it the run inherits the user's configured default mode
    // (which may auto-approve), and an approval run would never ask.
    approval: ['--permission-mode', 'default'],
    scoped: ['--allowedTools'],
    bypass: ['--dangerously-skip-permissions'],
  },
  codex: {
    // No pin: codex approval runs use the user's own codex approval config.
    approval: [],
    scoped: ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'],
    bypass: ['--dangerously-bypass-approvals-and-sandbox'],
  },
};

/** Throws on any tool name outside the bare-name grammar. */
export function permissionFlags(
  agent: AutomationAgent,
  mode: AutomationPermissionMode,
  allowedTools: readonly string[] | undefined,
): string[] {
  const flags = [...PERMISSION_FLAGS[agent][mode]];
  if (agent === 'claude' && mode === 'scoped') {
    const tools = allowedTools ?? [];
    if (tools.length === 0) throw new Error('Scoped mode has no tools');
    for (const tool of tools) {
      if (!AUTOMATION_TOOL_NAME_RE.test(tool)) throw new Error('Invalid tool name');
    }
    flags.push(...tools);
  }
  return flags;
}

/** `base` is buildAgentLaunch's output; flags are appended after it. */
export function buildAutomationCommand(
  base: string,
  agent: AutomationAgent,
  mode: AutomationPermissionMode,
  allowedTools: readonly string[] | undefined,
): string {
  const flags = permissionFlags(agent, mode, allowedTools);
  return flags.length ? `${base} ${flags.join(' ')}` : base;
}

const SCRUBBED_PREFIXES = ['CLAUDE', 'ANTHROPIC'];
const SCRUBBED_KEYS = ['AI_AGENT'];

/**
 * Drop CLAUDE* / ANTHROPIC* / AI_AGENT. A daemon started from inside an agent
 * session inherits that session's markers; a claude that sees them treats
 * itself as nested and stops persisting its transcript, so the run could not
 * be resumed afterwards.
 */
export function scrubAgentEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (SCRUBBED_PREFIXES.some((p) => upper.startsWith(p))) continue;
    if (SCRUBBED_KEYS.includes(upper)) continue;
    out[key] = value;
  }
  return out;
}

const ACCOUNT_ENV_KEY: Record<AutomationAgent, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

export type AccountEnvResult =
  | { ok: true; env: Record<string, string> }
  | { ok: false };

/**
 * Resolve `accountId` against accounts.json READ-ONLY (main owns writes).
 * The account must exist, match the agent's vendor, and its config dir must
 * still be a directory. No account id → no override (the CLI's default dir).
 */
export function resolveAccountEnv(wmuxDir: string, agent: AutomationAgent, accountId: string | undefined): AccountEnvResult {
  if (!accountId) return { ok: true, env: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(wmuxDir, 'accounts.json'), 'utf8')) as unknown;
    const accounts = (raw as { accounts?: unknown })?.accounts;
    if (!Array.isArray(accounts)) return { ok: false };
    const account = accounts.find((a) =>
      !!a && typeof a === 'object' && (a as Record<string, unknown>)['id'] === accountId) as Record<string, unknown> | undefined;
    const configDir = account?.['configDir'];
    if (!account || account['vendor'] !== agent || typeof configDir !== 'string' || !path.isAbsolute(configDir)) {
      return { ok: false };
    }
    if (!fs.statSync(configDir).isDirectory()) return { ok: false };
    return { ok: true, env: { [ACCOUNT_ENV_KEY[agent]]: configDir } };
  } catch {
    return { ok: false };
  }
}

/**
 * Pane env for a run: the web-pane env (filtered process env, WMUX_* stripped,
 * member id stamped), scrubbed of agent-nesting markers, then the account dir
 * and CLAUDE_CODE_SANDBOXED (skips claude's folder-trust dialog for the folder
 * the user picked). createSession stamps WMUX_PTY_ID / WMUX_DATA_SUFFIX after
 * this, so hook routing still reaches the pane.
 */
export function buildAutomationEnv(
  id: string,
  parentEnv: NodeJS.ProcessEnv,
  accountEnv: Record<string, string>,
): Record<string, string> {
  return {
    ...scrubAgentEnv(buildWebPaneEnv({ id, parentEnv })),
    ...accountEnv,
    [CLAUDE_SANDBOXED_ENV]: '1',
  };
}
