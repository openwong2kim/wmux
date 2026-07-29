import * as net from 'net';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { RpcMethod, RpcResponse } from '../shared/rpc';
import { getPipeName, getAuthTokenPath, getTcpPortPath } from '../shared/constants';
import { getConnectionScope } from './connectionScope';

const TIMEOUT_MS = 10000;
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 1000;

/** Upper bound for a long-poll wait. A waiting call parks a socket on the
 *  daemon for its whole duration, so the ceiling is what stops a caller from
 *  pinning one indefinitely — a waiter that wants longer re-waits. */
export const LONG_POLL_MAX_MS = 15 * 60 * 1000;

// Module-scoped declared identity. Populated by `setClientIdentity` from
// the MCP `InitializeRequest` handler (src/mcp/index.ts). Every outbound
// RPC stamps the envelope with this so PluginTrustStore can attribute the
// call. May be undefined for the very first RPCs that race the MCP
// initialize handshake — wmux treats those as 'legacy' and records them.
let CLIENT_NAME: string | undefined;
let CLIENT_VERSION: string | undefined;

// Broker mode (connectionScope.ts): when a connection scope is active, the
// identity setters/getters below read and write the PER-CONNECTION slots
// instead of these module globals, so N hosted server instances cannot
// stamp each other's plugin identity onto outbound RPC envelopes. The
// single-child entry never establishes a scope and keeps the globals.

export function setClientIdentity(name?: string, version?: string): void {
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const trimmedVersion = typeof version === 'string' ? version.trim() : '';
  const scope = getConnectionScope();
  if (scope) {
    scope.rpcIdentity.clientName = trimmedName.length > 0 ? trimmedName : undefined;
    scope.rpcIdentity.clientVersion = trimmedVersion.length > 0 ? trimmedVersion : undefined;
    return;
  }
  CLIENT_NAME = trimmedName.length > 0 ? trimmedName : undefined;
  CLIENT_VERSION = trimmedVersion.length > 0 ? trimmedVersion : undefined;
}

// Drop the declared identity so any further outbound RPC stamps an
// envelope-less request and falls through to the substrate's `legacy`
// audit path. Called from the MCP transport.onclose handler — after the
// transport tears down, an old name lingering in module scope would
// misattribute trailing RPC traffic (e.g. cleanup work) to a plugin that
// has already disconnected. A reconnect must re-run the initialize
// handshake to re-establish identity, which is the intended contract.
export function clearClientIdentity(): void {
  const scope = getConnectionScope();
  if (scope) {
    scope.rpcIdentity.clientName = undefined;
    scope.rpcIdentity.clientVersion = undefined;
    return;
  }
  CLIENT_NAME = undefined;
  CLIENT_VERSION = undefined;
}

export function getClientIdentity(): { name?: string; version?: string } {
  const scope = getConnectionScope();
  if (scope) {
    return { name: scope.rpcIdentity.clientName, version: scope.rpcIdentity.clientVersion };
  }
  return { name: CLIENT_NAME, version: CLIENT_VERSION };
}

// BYOB P4: commander role claim. Set once at startup by index.ts when the
// process runs with --commander. The value (may be '' when the token env was
// lost) is stamped on EVERY outbound envelope — presence of the field is the
// role claim, and the router fails a claimed-but-invalid token closed. Kept
// separate from the auth token: WMUX_AUTH_TOKEN authenticates the pipe,
// commanderToken narrows the role.
let COMMANDER_TOKEN: string | undefined;

export function setCommanderRole(token: string): void {
  const scope = getConnectionScope();
  if (scope) {
    scope.rpcIdentity.commanderToken = token;
    return;
  }
  COMMANDER_TOKEN = token;
}

/** Effective identity for the CURRENT execution context (scope-aware). */
function currentEnvelopeIdentity(): {
  clientName?: string;
  clientVersion?: string;
  commanderToken?: string;
} {
  const scope = getConnectionScope();
  if (scope) return scope.rpcIdentity;
  return { clientName: CLIENT_NAME, clientVersion: CLIENT_VERSION, commanderToken: COMMANDER_TOKEN };
}

function readAuthToken(): string | undefined {
  // File takes priority — always read the latest token from disk.
  // Env vars may be stale (Claude Code caches them across MCP restarts).
  try {
    const fromFile = fs.readFileSync(getAuthTokenPath(), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch { /* file doesn't exist */ }
  // Env var fallback (when running inside wmux terminal)
  if (process.env.WMUX_AUTH_TOKEN) return process.env.WMUX_AUTH_TOKEN;
  return undefined;
}

function readTcpPort(): number | undefined {
  try {
    const port = parseInt(fs.readFileSync(getTcpPortPath(), 'utf8').trim(), 10);
    return Number.isFinite(port) ? port : undefined;
  } catch { return undefined; }
}

function attemptRpc(
  target: string | { host: string; port: number },
  token: string,
  method: RpcMethod,
  params: Record<string, unknown>,
  timeoutMs: number = TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const envelope: Record<string, unknown> = { id, method, params, token };
    const identity = currentEnvelopeIdentity();
    if (identity.clientName) envelope.clientName = identity.clientName;
    if (identity.clientVersion) envelope.clientVersion = identity.clientVersion;
    if (identity.commanderToken !== undefined) envelope.commanderToken = identity.commanderToken;
    const request = JSON.stringify(envelope) + '\n';

    const socket = typeof target === 'string' ? net.connect(target) : net.connect(target);
    let buffer = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`));
      }
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(request);
    });

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const response = JSON.parse(trimmed) as RpcResponse;
          if (response.id === id && !settled) {
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            if (response.ok) {
              resolve(response.result);
            } else {
              reject(new Error(response.error));
            }
          }
        } catch {
          // ignore malformed lines
        }
      }
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
          reject(new Error('wmux is not running. Start the app first.'));
        } else {
          reject(new Error(`Connection error: ${err.message}`));
        }
      }
    });

    socket.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('Connection closed before response was received.'));
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Per-call transport options. */
export interface SendRpcOptions {
  /**
   * Turn this call into a LONG POLL: wait up to this many ms (clamped to
   * `LONG_POLL_MAX_MS`) for the daemon to answer, instead of the 10 s default.
   *
   * Setting it also DISABLES the retry ladder, and that coupling is why it is
   * one option rather than two knobs. A waiting call that retries opens the
   * SAME wait several times over — the caller ends up holding N sockets on one
   * event and, if the RPC has any side effect, triggering it N times. There is
   * deliberately no way to express "long timeout, keep retrying".
   *
   * The pipe-path and Windows-TCP fallbacks stay in place: those fire only on a
   * connect-class failure, which means no wait was ever opened.
   */
  longPollMs?: number;
}

export async function sendRpc(
  method: RpcMethod,
  params: Record<string, unknown> = {},
  options: SendRpcOptions = {},
): Promise<unknown> {
  // Long poll: clamp the wait and collapse the retry ladder to a single attempt
  // per candidate endpoint (see SendRpcOptions.longPollMs).
  const longPoll = typeof options.longPollMs === 'number' && options.longPollMs > 0;
  const timeoutMs = longPoll
    ? Math.min(options.longPollMs as number, LONG_POLL_MAX_MS)
    : TIMEOUT_MS;
  const retryCount = longPoll ? 1 : RETRY_COUNT;
  const token = readAuthToken();
  if (!token) {
    throw new Error('wmux auth token not found. Is wmux running?');
  }

  // Try WMUX_SOCKET_PATH first (if set), then fall back to getPipeName().
  // Claude Code may cache a stale WMUX_SOCKET_PATH from a previous session,
  // so we must fall back to the derived name if the env path fails.
  const envPath = process.env.WMUX_SOCKET_PATH;
  const derivedPath = getPipeName();
  const pipePaths = envPath && envPath !== derivedPath ? [envPath, derivedPath] : [derivedPath];

  // On Windows, add TCP localhost fallback (avoids named pipe EPERM issues)
  const tcpPort = process.platform === 'win32' ? readTcpPort() : undefined;

  let lastError: Error | undefined;

  for (const pipePath of pipePaths) {
    for (let attempt = 0; attempt < retryCount; attempt++) {
      try {
        return await attemptRpc(pipePath, token, method, params, timeoutMs);
      } catch (err) {
        lastError = err as Error;
        const msg = lastError.message;
        const isRetryable = msg.includes('not running') || msg.includes('unauthorized');
        const isPerm = msg.includes('EPERM');
        if (isPerm) break; // Don't retry EPERM — fall through to TCP
        if (isRetryable && attempt < retryCount - 1) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        if (isRetryable && pipePaths.length > 1 && pipePath === envPath) {
          break;
        }
        if (!isRetryable && !isPerm) throw err;
      }
    }
  }

  // TCP localhost fallback — bypasses Windows named pipe ACL issues
  if (tcpPort) {
    try {
      return await attemptRpc({ host: '127.0.0.1', port: tcpPort }, token, method, params, timeoutMs);
    } catch { /* fall through */ }
  }

  throw lastError ?? new Error('wmux is not running. Start the app first.');
}
