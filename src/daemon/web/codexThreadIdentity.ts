import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENV_KEYS } from '../../shared/constants';
import { getMcpServerEntry, parseConfig } from '../../shared/configIO';
import { WMUX_SERVER_KEY } from '../../shared/mcpTargets';

/**
 * Per-thread pane identity for Codex threads started through a pane's relay.
 *
 * Codex runs every thread inside one shared, per-account server, so a thread's
 * shell commands and MCP servers cannot take their identity from that
 * server's environment. The relay knows exactly which pane it serves, so on
 * `thread/start` and `thread/resume` it adds per-thread config overrides that
 * set the pane's identity for:
 *   - shell commands:  `shell_environment_policy.set.<KEY>`
 *   - the wmux MCP:    `mcp_servers.wmux.env.<KEY>` (only when the account
 *                      config defines that server: an override for a server
 *                      that does not exist makes Codex reject the thread).
 * Values come from the daemon's own session record, never from the client.
 */

/** Every identity key is always set (to '' when the pane has none) so a stale
 *  value inherited from the shared server can never show through. */
const IDENTITY_KEYS = [
  ENV_KEYS.WORKSPACE_ID,
  ENV_KEYS.WORKSPACE_NAME,
  ENV_KEYS.SURFACE_ID,
  ENV_KEYS.MEMBER_ID,
] as const;

/** Instance routing: which wmux instance the thread's tools talk to. */
const ROUTING_KEYS = [ENV_KEYS.SOCKET_PATH, ENV_KEYS.DATA_SUFFIX] as const;

export function threadIdentityEnv(
  session: { id: string; env?: Record<string, string> },
  daemonEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const paneEnv = session.env ?? {};
  const out: Record<string, string> = { [ENV_KEYS.PTY_ID]: session.id };
  for (const key of IDENTITY_KEYS) out[key] = paneEnv[key] ?? '';
  // Panes are stamped with their member id at spawn; a pane without one still
  // has exactly one sensible member identity, its own pty id.
  if (!out[ENV_KEYS.MEMBER_ID]) out[ENV_KEYS.MEMBER_ID] = session.id;
  for (const key of ROUTING_KEYS) out[key] = paneEnv[key] ?? daemonEnv[key] ?? '';
  return out;
}

/** Title-generation threads the TUI starts on its own; they run no tools. */
export function isSystemTitleThread(params: Record<string, unknown>): boolean {
  return params.ephemeral === true && ['system', 'thread_title'].includes(String(params.threadSource));
}

export type ThreadFrameRewrite =
  | { kind: 'pass' }
  | { kind: 'rewrite'; message: Record<string, unknown> }
  | { kind: 'refuse'; reason: string };

const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** Does this client frame start or resume a thread that needs pane identity? */
export function needsThreadIdentity(message: unknown): boolean {
  const m = record(message);
  if (!m || (m.method !== 'thread/start' && m.method !== 'thread/resume')) return false;
  const params = record(m.params);
  return !(params && isSystemTitleThread(params));
}

/**
 * Add the pane's identity to a `thread/start` / `thread/resume` frame. Any
 * frame whose shape cannot carry it is refused rather than forwarded without
 * identity.
 */
export function rewriteThreadFrame(
  message: unknown,
  identity: Record<string, string> | undefined,
  opts: { mcp: boolean },
): ThreadFrameRewrite {
  if (!needsThreadIdentity(message)) return { kind: 'pass' };
  const m = message as Record<string, unknown>;
  if (!identity) return { kind: 'refuse', reason: 'pane identity is not available yet' };
  if (m.params !== undefined && m.params !== null && !record(m.params)) {
    return { kind: 'refuse', reason: 'thread request parameters are malformed' };
  }
  const params = { ...(record(m.params) ?? {}) };
  if (params.config !== undefined && params.config !== null && !record(params.config)) {
    return { kind: 'refuse', reason: 'thread request config is malformed' };
  }
  const config: Record<string, unknown> = { ...(record(params.config) ?? {}) };
  for (const [key, value] of Object.entries(identity)) {
    config[`shell_environment_policy.set.${key}`] = value;
    if (opts.mcp) config[`mcp_servers.${WMUX_SERVER_KEY}.env.${key}`] = value;
  }
  params.config = config;
  return { kind: 'rewrite', message: { ...m, params } };
}

/**
 * Whether the account's Codex config defines the wmux MCP server. Cached by
 * the file's mtime; an unreadable or malformed file counts as "no".
 */
export function createWmuxMcpProbe(codeHome?: string): () => boolean {
  const file = path.join(codeHome ?? path.join(os.homedir(), '.codex'), 'config.toml');
  let cached: { mtimeMs: number; value: boolean } | undefined;
  return () => {
    let mtimeMs: number;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { cached = undefined; return false; }
    if (cached && cached.mtimeMs === mtimeMs) return cached.value;
    let value = false;
    try {
      const entry = getMcpServerEntry(parseConfig(fs.readFileSync(file, 'utf8'), 'toml'), 'toml', WMUX_SERVER_KEY);
      value = !!entry && !!entry.command;
    } catch { value = false; }
    cached = { mtimeMs, value };
    return value;
  };
}
