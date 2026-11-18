/**
 * An agent that lost its sign-in (N4). The daemon reports it when a turn ends
 * on an authentication failure, when an agent starts in a pane whose account
 * is signed out, and when a scheduled run is refused for that reason. main
 * folds the reports into one notice per agent and account, and the renderer
 * offers the agent's own sign-in. Nothing here carries a token or the
 * provider's message text.
 */

import { agentRow } from './agentIdentity';
import { parseWslAuthRef, wslAccountAuthRef } from './wslAccountMark';

export type AuthLostAgent = 'claude' | 'codex';

/** Where the daemon saw it: a failed turn, an agent start, or a scheduled run it refused. */
export type AuthLostOrigin = 'turn' | 'start' | 'schedule';

export interface AgentAuthLost {
  agent: AuthLostAgent;
  /**
   * The account's config dir (CLAUDE_CONFIG_DIR / CODEX_HOME), or null for the
   * agent's default. A WSL pane on a bound account reports its sign-in key
   * instead ('wsl:<distro>:<folder>', shared/wslAccountMark.ts): that account's
   * Linux home has its own sign-in.
   */
  configDir: string | null;
  origin: AuthLostOrigin;
  /** The provider's own error code when a turn failed (`authentication_failed`, `unauthorized`, …). */
  providerCode?: string;
  at: number;
}

/** An agent and account that was seen to work (a confirmed turn end, or its status said signed in). */
export interface AuthAccount {
  agent: AuthLostAgent;
  configDir: string | null;
}

/** One signed-out agent and account, with the panes that reported it (main → renderer). */
export interface AuthLostEntry {
  key: string;
  agent: AuthLostAgent;
  configDir: string | null;
  ptyIds: string[];
}

/** The registry's account variable for an agent whose sign-in can be checked, or undefined. */
function accountEnvOf(slug: string): 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' | undefined {
  const status = agentRow(slug)?.setup?.loginStatus;
  return status && status.read !== 'none' ? status.accountEnv : undefined;
}

/** An agent with a sign-in status command and a per-account folder (its registry row says so). */
export function isAuthLostAgent(value: unknown): value is AuthLostAgent {
  return typeof value === 'string' && accountEnvOf(value) !== undefined;
}

export function authConfigEnvKey(agent: AuthLostAgent): 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' {
  const key = accountEnvOf(agent);
  if (!key) throw new Error(`no account variable for ${agent}`);
  return key;
}

/**
 * The account a pane or run uses, read from its env; null = the agent's default.
 * A WSL pane on a bound account runs it on the account's Linux home, which has
 * its own sign-in: that is its sign-in key (wslAccountAuthRef), never the folder.
 */
export function authConfigDir(agent: AuthLostAgent, env: Readonly<Record<string, string | undefined>> | undefined): string | null {
  const key = authConfigEnvKey(agent);
  const wsl = wslAccountAuthRef(env, key);
  if (wsl) return wsl;
  const dir = env?.[key]?.trim();
  return dir ? dir : null;
}

/**
 * Whether wmux on Windows can ask the agent's own status about this account: not
 * for a WSL account home, which only the Linux agent in that distro can read.
 */
export function isWindowsReadableAccount(configDir: string | null): boolean {
  return parseWslAuthRef(configDir) === null;
}

/** Dedup key: one notice per agent and account. */
export function authLostKey(agent: AuthLostAgent, configDir: string | null): string {
  return `${agent}:${configDir ?? ''}`;
}

const ORIGINS: ReadonlySet<string> = new Set(['turn', 'start', 'schedule']);
const PROVIDER_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function validConfigDir(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 4096);
}

/** Validate an "it works" report that crossed the daemon pipe; anything malformed is null. */
export function parseAuthAccount(value: unknown): AuthAccount | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  return isAuthLostAgent(v.agent) && validConfigDir(v.configDir) ? { agent: v.agent, configDir: v.configDir } : null;
}

/** Validate a report that crossed the daemon pipe; anything malformed is null. */
export function parseAgentAuthLost(value: unknown): AgentAuthLost | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!isAuthLostAgent(v.agent) || typeof v.origin !== 'string' || !ORIGINS.has(v.origin)) return null;
  if (!validConfigDir(v.configDir)) return null;
  const at = typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : Date.now();
  return {
    agent: v.agent,
    configDir: v.configDir,
    origin: v.origin as AuthLostOrigin,
    ...(typeof v.providerCode === 'string' && PROVIDER_CODE.test(v.providerCode) ? { providerCode: v.providerCode } : {}),
    at,
  };
}
