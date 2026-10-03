import fs from 'node:fs';
import path from 'node:path';
import { ENV_KEYS } from '../../../shared/constants';
import { buildAutomationEnv } from '../../automation/launch';

/** The pane identity a driver carries, copied from the anchor pane's own env. */
const PANE_IDENTITY_KEYS = [
  ENV_KEYS.WORKSPACE_ID,
  ENV_KEYS.WORKSPACE_NAME,
  ENV_KEYS.SURFACE_ID,
  ENV_KEYS.SOCKET_PATH,
  ENV_KEYS.MEMBER_ID,
] as const;

/**
 * The driver's child env, built like a scheduled run's: the pane's env through
 * the web-pane filter (`WMUX_*` stripped) and `scrubAgentEnv` (CLAUDE* /
 * ANTHROPIC* / AI_AGENT: a claude that inherits a parent agent's markers stops
 * persisting its transcript), then the pane's account directory, then the
 * pane's own identity: `WMUX_PTY_ID` = the anchor pane, the identity keys the
 * pane was spawned with, the daemon's own `WMUX_DATA_SUFFIX` (so hooks and MCP
 * reach THIS instance), and `WMUX_GATE=0` (the stream approval is the only
 * card for a tool call). `WMUX_AUTH*` never reaches the child.
 */
export function buildDriverEnv(
  paneId: string,
  paneEnv: Record<string, string>,
  daemonEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const accountDir = paneEnv.CLAUDE_CONFIG_DIR;
  let accountEnv: Record<string, string> = {};
  if (accountDir && path.isAbsolute(accountDir)) {
    try {
      if (fs.statSync(accountDir).isDirectory()) accountEnv = { CLAUDE_CONFIG_DIR: accountDir };
    } catch { /* gone: the CLI's default account, never a fresh empty config */ }
  }
  const env = buildAutomationEnv(paneId, paneEnv, accountEnv);
  for (const key of PANE_IDENTITY_KEYS) {
    const value = paneEnv[key];
    if (typeof value === 'string' && value) env[key] = value;
  }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === ENV_KEYS.DATA_SUFFIX || key.toUpperCase().startsWith('WMUX_AUTH')) delete env[key];
  }
  const suffix = daemonEnv[ENV_KEYS.DATA_SUFFIX];
  if (suffix) env[ENV_KEYS.DATA_SUFFIX] = suffix;
  env[ENV_KEYS.PTY_ID] = paneId;
  env.WMUX_GATE = '0';
  return env;
}
