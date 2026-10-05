import fs from 'node:fs';
import path from 'node:path';
import { ENV_KEYS } from '../../../shared/constants';
import { isInternalEnvKey, isNestingMarker } from '../../../shared/envFilter';

/** The pane identity a driver carries, copied from the anchor pane's own env. */
const PANE_IDENTITY_KEYS = [
  ENV_KEYS.WORKSPACE_ID,
  ENV_KEYS.WORKSPACE_NAME,
  ENV_KEYS.SURFACE_ID,
  ENV_KEYS.SOCKET_PATH,
  ENV_KEYS.MEMBER_ID,
] as const;

/**
 * Agent-nesting markers live in shared/envFilter (panes drop them too). The
 * driver additionally drops CLAUDE_CODE_EFFORT_LEVEL, claude's effort input:
 * it would override the effort the chat presents as its own ("Default effort")
 * without the chat knowing. Model-picker extras such as
 * ANTHROPIC_CUSTOM_MODEL_OPTION* are user shell config a `claude` typed in the
 * pane also sees; they only affect the interactive picker, so they stay.
 * Everything else the pane has, credentials and endpoints included
 * (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, CLAUDE_CODE_USE_BEDROCK, …), stays,
 * so chat runs on the same account and endpoint as `claude` typed in the pane.
 */
export { isNestingMarker } from '../../../shared/envFilter';
const CHAT_EFFORT_INPUT = 'CLAUDE_CODE_EFFORT_LEVEL';

export class DriverEnvError extends Error {}

/**
 * The driver's child env: the pane's own env (what a `claude` typed in the
 * pane would get) without wmux internals and agent-nesting markers, then the
 * pane's identity: `WMUX_PTY_ID` = the anchor pane, the identity keys the pane
 * was spawned with, the daemon's own `WMUX_DATA_SUFFIX` (so hooks and MCP
 * reach THIS instance) and `WMUX_GATE=0` (the stream approval is the only card
 * for a tool call). `WMUX_AUTH*` never reaches the child.
 *
 * A pane pinned to an account (`CLAUDE_CONFIG_DIR`) whose directory is gone
 * throws `DriverEnvError`: running on the default account instead would be a
 * different account than the one the pane asked for.
 */
export function buildDriverEnv(
  paneId: string,
  paneEnv: Record<string, string>,
  daemonEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(paneEnv)) {
    if (typeof value !== 'string') continue;
    const upper = key.toUpperCase();
    if (isInternalEnvKey(key) || isNestingMarker(key) || upper === CHAT_EFFORT_INPUT || upper.startsWith('WMUX_')) continue;
    env[key] = value;
  }
  const accountDir = env.CLAUDE_CONFIG_DIR;
  if (accountDir !== undefined) {
    let usable = false;
    try {
      usable = path.isAbsolute(accountDir) && fs.statSync(accountDir).isDirectory();
    } catch { /* gone */ }
    if (!usable) throw new DriverEnvError('The account folder this pane uses is missing. Sign in to the account again or pick another one.');
  }
  for (const key of PANE_IDENTITY_KEYS) {
    const value = paneEnv[key];
    if (typeof value === 'string' && value) env[key] = value;
  }
  env[ENV_KEYS.MEMBER_ID] ??= paneId;
  const suffix = daemonEnv[ENV_KEYS.DATA_SUFFIX];
  if (suffix) env[ENV_KEYS.DATA_SUFFIX] = suffix;
  env[ENV_KEYS.PTY_ID] = paneId;
  env.WMUX_GATE = '0';
  return env;
}
