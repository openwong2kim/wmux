import * as net from 'net';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import type { RpcMethod, RpcResponse } from '../shared/rpc';
import { getPipeName, getAuthTokenPath, getTcpPortPath } from '../shared/constants';
import { getConnectionScope } from './connectionScope';

/**
 * Default per-call RPC deadline. Every tool gets this unless it asks for
 * another — see `sendRpc`'s `timeoutMs`.
 *
 * This is a PER-CALL timer on a PER-CALL socket (`attemptRpc` opens its own
 * connection), not a transport-wide contract, which is why one long-running
 * method can be given a longer deadline without touching any other tool. The
 * blocking `events.poll` is the only caller that does.
 */
const TIMEOUT_MS = 10000;
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 1000;

// Module-scoped declared identity. Populated by `setClientIdentity` from
// the MCP `InitializeRequest` handler (src/mcp/index.ts). Every outbound
// RPC stamps the envelope with this so PluginTrustStore can attribute the
// call. Undefined until the initialize handshake completes (and for good
// with a host that reports no clientInfo name). An RPC sent without it goes
// out envelope-less, which the substrate refuses since #1111 closed the
// legacy lane (identity bootstrap and a token-validated commander aside);
// tool calls normally arrive only after the handshake has set it.
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

// Drop the declared identity so any further outbound RPC goes out
// envelope-less, which the substrate refuses since #1111 (identity bootstrap
// aside), instead of under a stale name. Called from the MCP
// transport.onclose handler — after the transport tears down, an old name
// lingering in module scope would misattribute trailing RPC traffic (e.g.
// cleanup work) to a plugin that has already disconnected. A reconnect must re-run the initialize
// handshake to re-establish identity, which is the intended contract.
export function clearClientIdentity(): void {
  const scope = getConnectionScope();
  if (scope) {
    scope.rpcIdentity.clientName = undefined;
    scope.rpcIdentity.clientVersion = undefined;
    scope.rpcIdentity.workspaceToken = undefined;
    scope.rpcIdentity.callerPtyId = undefined;
    return;
  }
  CLIENT_NAME = undefined;
  CLIENT_VERSION = undefined;
  WORKSPACE_TOKEN = undefined;
  CALLER_PTY_ID = undefined;
}

export function getClientIdentity(): { name?: string; version?: string } {
  const scope = getConnectionScope();
  if (scope) {
    return { name: scope.rpcIdentity.clientName, version: scope.rpcIdentity.clientVersion };
  }
  return { name: CLIENT_NAME, version: CLIENT_VERSION };
}

// #922 PR-A: the workspace claim token minted by `mcp.claimWorkspace`. Set by
// paneResolver the moment a claim succeeds, and stamped on every later
// envelope so main can tell WHICH workspace this caller claimed — a fact main
// itself recorded at claim time, not one the caller asserts.
//
// Scope-aware for the same reason as the identity above: under the broker one
// process hosts N connections, and a shared token would let one hosted caller
// send another's claim. `clearClientIdentity` drops it with the rest of the
// identity, so trailing RPCs after a transport closes cannot keep presenting a
// claim on behalf of a caller that has gone.
let WORKSPACE_TOKEN: string | undefined;

export function setWorkspaceToken(token: string | undefined): void {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  const value = trimmed.length > 0 ? trimmed : undefined;
  const scope = getConnectionScope();
  if (scope) {
    scope.rpcIdentity.workspaceToken = value;
    return;
  }
  WORKSPACE_TOKEN = value;
}

export function getWorkspaceToken(): string | undefined {
  const scope = getConnectionScope();
  if (scope) return scope.rpcIdentity.workspaceToken;
  return WORKSPACE_TOKEN;
}

// The PTY this caller runs in, stamped on every envelope as `callerPtyId` so
// main can pick the caller's PANE browser profile (src/shared/chromePaneBinding.ts).
// Set by index.ts from the server's own identity (PID-map walk, WMUX_PTY_ID
// hint, external claim) — never from tool arguments, which only ever reach the
// envelope's `params`. Scope-aware and cleared exactly like the claim token.
let CALLER_PTY_ID: string | undefined;

// A per-call source that overrides the connection value: a shared Codex
// app-server (#1778) identifies each call by its own thread, so the
// connection-wide value (the daemon starter's pane) must not be stamped there.
// The source returns the call's pane, '' for "no pane — omit the field", or
// undefined to defer to the connection value.
const callerPtyIdSource = new AsyncLocalStorage<() => string | undefined>();

export function setCallerPtyId(ptyId: string | undefined): void {
  const trimmed = typeof ptyId === 'string' ? ptyId.trim() : '';
  const value = trimmed.length > 0 ? trimmed : undefined;
  const scope = getConnectionScope();
  if (scope) {
    scope.rpcIdentity.callerPtyId = value;
    return;
  }
  CALLER_PTY_ID = value;
}

/** The callerPtyId the next envelope built in this context will carry. */
export function getCallerPtyId(): string | undefined {
  const source = callerPtyIdSource.getStore();
  const fromCall = source ? source() : undefined;
  if (fromCall !== undefined) return fromCall.length > 0 ? fromCall : undefined;
  const scope = getConnectionScope();
  if (scope) return scope.rpcIdentity.callerPtyId;
  return CALLER_PTY_ID;
}

/** Run `fn` with a per-call callerPtyId source (see `callerPtyIdSource`). */
export function runWithCallerPtyIdSource<T>(source: () => string | undefined, fn: () => T): T {
  return callerPtyIdSource.run(source, fn);
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
  workspaceToken?: string;
} {
  const scope = getConnectionScope();
  if (scope) return scope.rpcIdentity;
  return {
    clientName: CLIENT_NAME,
    clientVersion: CLIENT_VERSION,
    commanderToken: COMMANDER_TOKEN,
    workspaceToken: WORKSPACE_TOKEN,
  };
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
    // #922 PR-A. Absent until a claim succeeds, and omitted entirely when
    // there is none — an empty string would read as a presented-but-stale
    // token to the lane PR-B adds, which must refuse rather than demote.
    if (identity.workspaceToken !== undefined) envelope.workspaceToken = identity.workspaceToken;
    // Omitted, never '', when this caller has no known pane.
    const callerPtyId = getCallerPtyId();
    if (callerPtyId !== undefined) envelope.callerPtyId = callerPtyId;
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

export async function sendRpc(
  method: RpcMethod,
  params: Record<string, unknown> = {},
  timeoutMs: number = TIMEOUT_MS,
): Promise<unknown> {
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
    for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
      try {
        return await attemptRpc(pipePath, token, method, params, timeoutMs);
      } catch (err) {
        lastError = err as Error;
        const msg = lastError.message;
        const isRetryable = msg.includes('not running') || msg.includes('unauthorized');
        const isPerm = msg.includes('EPERM');
        if (isPerm) break; // Don't retry EPERM — fall through to TCP
        if (isRetryable && attempt < RETRY_COUNT - 1) {
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
